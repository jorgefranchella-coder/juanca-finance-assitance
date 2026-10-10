"""Authenticated local-network gateway; internal Worker must remain on loopback."""
import os
import hashlib
import hmac
import http.client
from http.client import HTTPConnection
import json
import ipaddress
import re
from urllib.parse import urlsplit, unquote
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from browser_sessions import Sessions, COOKIE_NAME, password_valid, session_cookie

CONFIG = json.loads((Path(__file__).parent / 'credentials.json').read_text())
ROOT = Path(__file__).parent
WORKER_PORT = int(os.environ.get('JUANCA_WORKER_PORT', '3041'))
AUTH = {'username': 'juanca', 'salt': b'juanca-browser-login'.hex(), 'hash': hashlib.pbkdf2_hmac('sha256', CONFIG['password'].encode(), b'juanca-browser-login', 600000).hex()}
SESSIONS = Sessions(ROOT / 'state' / 'browser-sessions.db', AUTH)
HTTPS_HOST = 'nbcriancas.tailcb43eb.ts.net:8443'
ALLOWED_ORIGINS = {'http://localhost:3040', 'http://127.0.0.1:3040', 'http://nbcriancas:3040', 'http://nbcriancas.local:3040', 'http://192.168.68.128:3040', 'http://100.105.79.77:3040', 'http://nbcriancas.tailcb43eb.ts.net:3040', 'https://' + HTTPS_HOST}
HOP = {'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length', 'authorization', 'cookie'}
SHADOW_CONFIG_PATH = Path(os.environ.get('JUANCA_SHADOW_CONFIG', '/home/jorge/.local/share/juanca-shadow/application.json'))
SHADOW_ROUTES = {
    '/api/shadow/evidence/text': {'GET', 'POST'},
    '/api/shadow/evidence/photos': {'GET', 'POST'},
    '/api/shadow/evidence/documents': {'POST'},
    '/api/shadow/reconciliation/b3/candidates': {'GET'},
    '/api/shadow/reconciliation/manual-b3/candidates': {'GET'},
    '/api/shadow/reconciliation/manual-b3/decisions': {'POST'},
}
SHADOW_ITEM = re.compile(r'^/api/shadow/evidence/(text|photos|documents)/([0-9a-fA-F-]{36})(/content)?$')
PHOTO_TYPES = {'image/jpeg', 'image/png', 'image/webp', 'image/heic'}
DOCUMENT_TYPES = {
    ('b3', 'positions'): 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ('b3', 'movements'): 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ('avenue', 'avenue_statement'): 'application/pdf',
    ('avenue', 'avenue_confirmation'): 'application/pdf',
    ('pension', 'pension_statement'): 'application/pdf',
}

class Gateway(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # Avoid logging private query strings and document names.

    def do_GET(self):
        self.forward()
    do_POST = do_GET
    do_HEAD = do_GET
    do_PUT = do_GET
    do_DELETE = do_GET

    def reply(self, status, body=b'', mime='application/json', headers=None):
        self.send_response(status)
        self.send_header('Content-Type', mime + '; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def reply_json(self, status, body, headers=None):
        self.reply(status, json.dumps(body, ensure_ascii=False).encode(), headers=headers)

    def secure_origin(self):
        # This exact hostname is served over TLS by the loopback Tailscale proxy.
        return self.headers.get('Host', '') == HTTPS_HOST and ipaddress.ip_address(self.client_address[0]).is_loopback

    def session_token(self):
        return SESSIONS.token(self.headers, COOKIE_NAME if self.secure_origin() else 'juanca-local-session')

    def same_origin(self):
        expected = ('https' if self.secure_origin() else 'http') + '://' + self.headers.get('Host', '')
        return expected in ALLOWED_ORIGINS and self.headers.get('Origin') == expected

    def session_request(self, path):
        if self.command != 'POST':
            self.reply_json(405, {'error': 'Método não permitido.'})
            return
        if not self.same_origin() or self.headers.get('X-Juanca-Request') != '1':
            self.reply_json(403, {'error': 'Origem não autorizada.'})
            return
        if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
            self.reply_json(415, {'error': 'É necessário enviar JSON.'})
            return
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 4096 or self.headers.get('Transfer-Encoding'):
                raise ValueError()
            payload = json.loads(self.rfile.read(size))
            if not isinstance(payload, dict):
                raise ValueError()
        except (ValueError, UnicodeError):
            self.reply_json(400, {'error': 'Solicitação inválida.'})
            return
        previous = self.session_token()
        if path == '/api/logout':
            SESSIONS.revoke(previous)
            self.reply_json(200, {'ok': True}, {'Set-Cookie': session_cookie('', clear=True, secure=self.secure_origin())})
            return
        if not SESSIONS.allow_attempt(self.client_address[0]):
            self.reply_json(429, {'error': 'Muitas tentativas. Aguarde cinco minutos e tente novamente.'}, {'Retry-After': '300'})
            return
        if not password_valid(AUTH, payload.get('username'), payload.get('password')):
            self.reply_json(401, {'error': 'Usuário ou senha incorretos.'})
            return
        remember = payload.get('remember') is True
        token = SESSIONS.create(self.headers.get('Host', ''), remember, previous)
        self.reply_json(200, {'ok': True}, {'Set-Cookie': session_cookie(token, remember, secure=self.secure_origin())})

    def shadow_evidence(self, path):
        if path == '/api/shadow/evidence/photo-file':
            self.shadow_photo_file()
            return
        if path == '/api/shadow/evidence/document-file':
            self.shadow_document_file()
            return
        methods = SHADOW_ROUTES.get(path)
        if methods is None:
            match = SHADOW_ITEM.fullmatch(path)
            if not match:
                self.reply_json(404, {'code': 'NOT_FOUND'})
                return
            methods = {'PUT'} if match.group(3) else {'GET'}
            if match.group(1) == 'photos' and match.group(3):
                methods = {'GET', 'PUT'}
            if match.group(1) == 'text' and match.group(3):
                methods = set()
        if self.command not in methods:
            self.reply_json(405, {'code': 'METHOD_NOT_ALLOWED'})
            return
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if size < 0 or size > 20_000_000 or self.headers.get('Transfer-Encoding'):
                self.reply_json(413, {'code': 'BODY_TOO_LARGE'})
                return
            body = self.rfile.read(size) if size else None
            shadow = json.loads(SHADOW_CONFIG_PATH.read_text())
            target = '/v1' + path.removeprefix('/api/shadow')
            headers = {'Authorization': 'Bearer ' + shadow['token'], 'Accept-Encoding': 'identity'}
            if path == '/api/shadow/reconciliation/manual-b3/decisions' and self.command == 'POST':
                headers['X-Juanca-Actor'] = CONFIG['user_id']
            if self.headers.get('Content-Type'):
                headers['Content-Type'] = self.headers['Content-Type']
            if self.headers.get('Idempotency-Key'):
                headers['Idempotency-Key'] = self.headers['Idempotency-Key']
            connection = HTTPConnection('127.0.0.1', int(shadow['port']), timeout=125)
            try:
                connection.request(self.command, target, body=body, headers=headers)
                response = connection.getresponse()
                payload = response.read()
                mime = response.getheader('Content-Type', 'application/json').split(';')[0]
                self.reply(response.status, payload, mime)
            finally:
                connection.close()
        except (OSError, ValueError, KeyError, http.client.HTTPException):
            self.reply_json(502, {'code': 'SHADOW_UNAVAILABLE'})

    def shadow_document_file(self):
        if self.command != 'POST':
            self.reply_json(405, {'code': 'METHOD_NOT_ALLOWED'})
            return
        try:
            size = int(self.headers.get('Content-Length', '0'))
            mime = self.headers.get('Content-Type', '').split(';')[0]
            owner = self.headers.get('X-Juanca-Owner', '')
            source = self.headers.get('X-Juanca-Source', '')
            file_type = self.headers.get('X-Juanca-File-Type', '')
            filename = unquote(self.headers.get('X-Juanca-File-Name', ''))
            request_id = self.headers.get('X-Juanca-Request-Id', '')
            reference_date = self.headers.get('X-Juanca-Reference-Date') or None
            if not 0 < size <= 15_000_000 or DOCUMENT_TYPES.get((source, file_type)) != mime or owner not in {'Jorge', 'Julia'} or not re.fullmatch(r'[A-Za-z0-9._:-]{8,128}', request_id) or not filename or len(filename) > 180 or any(ord(c) < 32 for c in filename) or (reference_date and not re.fullmatch(r'\d{4}-\d{2}-\d{2}', reference_date)) or (source == 'b3' and file_type == 'positions' and not reference_date):
                self.reply_json(422, {'code': 'INVALID_DOCUMENT_METADATA'})
                return
            if self.headers.get('Transfer-Encoding'):
                self.reply_json(413, {'code': 'BODY_TOO_LARGE'})
                return
            body = self.rfile.read(size)
            if len(body) != size:
                self.reply_json(422, {'code': 'INCOMPLETE_DOCUMENT'})
                return
            shadow = json.loads(SHADOW_CONFIG_PATH.read_text())
            connection = HTTPConnection('127.0.0.1', int(shadow['port']), timeout=125)
            try:
                intent = json.dumps({'request_id': request_id, 'owner': owner, 'source': source,
                                     'file_type': file_type, 'file_name': filename, 'reference_date': reference_date,
                                     'content_sha256': hashlib.sha256(body).hexdigest(), 'byte_size': size,
                                     'content_type': mime}).encode()
                connection.request('POST', '/v1/evidence/documents', body=intent,
                                   headers={'Authorization': 'Bearer ' + shadow['token'], 'Content-Type': 'application/json'})
                accepted = connection.getresponse()
                result = accepted.read()
                if accepted.status != 202:
                    self.reply(accepted.status, result)
                    return
                upload_id = json.loads(result)['upload_id']
                connection.close()
                connection = HTTPConnection('127.0.0.1', int(shadow['port']), timeout=125)
                connection.request('PUT', '/v1/evidence/documents/' + upload_id + '/content', body=body,
                                   headers={'Authorization': 'Bearer ' + shadow['token'], 'Content-Type': mime})
                stored = connection.getresponse()
                self.reply(stored.status, stored.read())
            finally:
                connection.close()
        except (OSError, ValueError, KeyError, http.client.HTTPException):
            self.reply_json(502, {'code': 'SHADOW_UNAVAILABLE'})

    def shadow_photo_file(self):
        if self.command != 'POST':
            self.reply_json(405, {'code': 'METHOD_NOT_ALLOWED'})
            return
        try:
            size = int(self.headers.get('Content-Length', '0'))
            mime = self.headers.get('Content-Type', '').split(';')[0]
            owner = self.headers.get('X-Juanca-Owner', '')
            filename = unquote(self.headers.get('X-Juanca-File-Name', ''))
            request_id = self.headers.get('X-Juanca-Request-Id', '')
            if not 0 < size <= 15_000_000 or mime not in PHOTO_TYPES or owner not in {'Jorge', 'Julia'} or not re.fullmatch(r'[A-Za-z0-9._:-]{8,128}', request_id) or not filename or len(filename) > 180 or any(ord(c) < 32 for c in filename):
                self.reply_json(422, {'code': 'INVALID_PHOTO_METADATA'})
                return
            if self.headers.get('Transfer-Encoding'):
                self.reply_json(413, {'code': 'BODY_TOO_LARGE'})
                return
            body = self.rfile.read(size)
            if len(body) != size:
                self.reply_json(422, {'code': 'INCOMPLETE_PHOTO'})
                return
            shadow = json.loads(SHADOW_CONFIG_PATH.read_text())
            connection = HTTPConnection('127.0.0.1', int(shadow['port']), timeout=125)
            try:
                intent = json.dumps({'request_id': request_id, 'owner': owner, 'file_name': filename,
                                     'content_sha256': hashlib.sha256(body).hexdigest(), 'byte_size': size,
                                     'content_type': mime}).encode()
                connection.request('POST', '/v1/evidence/photos', body=intent,
                                   headers={'Authorization': 'Bearer ' + shadow['token'], 'Content-Type': 'application/json'})
                accepted = connection.getresponse()
                result = accepted.read()
                if accepted.status != 202:
                    self.reply(accepted.status, result)
                    return
                upload_id = json.loads(result)['upload_id']
                connection.close()
                connection = HTTPConnection('127.0.0.1', int(shadow['port']), timeout=125)
                connection.request('PUT', '/v1/evidence/photos/' + upload_id + '/content', body=body,
                                   headers={'Authorization': 'Bearer ' + shadow['token'], 'Content-Type': mime})
                stored = connection.getresponse()
                self.reply(stored.status, stored.read())
            finally:
                connection.close()
        except (OSError, ValueError, KeyError, http.client.HTTPException):
            self.reply_json(502, {'code': 'SHADOW_UNAVAILABLE'})

    def forward(self):
        address = ipaddress.ip_address(self.client_address[0])
        if not (address.is_loopback or address in ipaddress.ip_network('192.168.68.0/24') or str(address) in {'100.104.19.85', '100.105.79.77'}):
            self.send_error(403, 'Acceso limitado a la red local y equipos privados autorizados')
            return
        auth = self.headers.get('Authorization', '')
        bearer = 'Bearer ' + CONFIG['token']
        path = urlsplit(self.path).path
        if path in ('/api/login', '/api/logout'):
            self.session_request(path)
            return
        if self.command in ('GET', 'HEAD') and path in ('/login', '/login.css', '/login.js'):
            if path == '/login' and SESSIONS.valid(self.session_token(), self.headers.get('Host', '')):
                self.reply(303, headers={'Location': '/'})
                return
            name, mime = {'/login': ('login.html', 'text/html'), '/login.css': ('login.css', 'text/css'), '/login.js': ('login.js', 'text/javascript')}[path]
            self.reply(200, (ROOT / 'browser-auth' / name).read_bytes(), mime)
            return
        install_asset = self.command in ('GET', 'HEAD') and path in {'/manifest.webmanifest', '/sw.js', '/juanca-icon.png', '/favicon.svg', '/juanca-app-180.png', '/juanca-app-192.png', '/juanca-app-512.png'}
        machine = hmac.compare_digest(auth.encode(), bearer.encode())
        browser = SESSIONS.valid(self.session_token(), self.headers.get('Host', ''))
        if not install_asset and not (machine or browser):
            if self.command in ('GET', 'HEAD') and not path.startswith('/api/') and (path == '/' or 'text/html' in self.headers.get('Accept', '')):
                self.reply(303, headers={'Location': '/login'})
            else:
                self.reply_json(401, {'error': 'Sua sessão terminou. Entre novamente.'})
            return
        if self.command not in ('GET', 'HEAD'):
            origin = self.headers.get('Origin')
            if (browser and not machine and not self.same_origin()) or (origin and origin not in ALLOWED_ORIGINS):
                self.send_error(403, 'Origen no autorizado')
                return
        if path.startswith('/api/shadow/'):
            self.shadow_evidence(path)
            return
        if path == '/api/juanca/chat':
            if self.command not in ('GET', 'POST'):
                self.reply_json(405, {'detail': 'Método não permitido.'})
                return
            from juanca_chat import handle
            handle(self, CONFIG, ROOT, WORKER_PORT)
            return
        if path == '/api/hermes/chat':
            if self.command not in ('GET', 'POST'):
                self.send_error(405)
                return
            from hermes_chat import handle
            handle(self)
            return
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if size < 0 or size > 20 * 1024 * 1024 or self.headers.get('Transfer-Encoding'):
                self.send_error(413)
                return
            headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP and not k.lower().startswith('oai-')}
            headers.update({'oai-authenticated-user-id': CONFIG['user_id'], 'oai-authenticated-user-email': 'juanca@localhost', 'Host': 'localhost:3040', 'Accept-Encoding': 'identity'})
            conn = HTTPConnection('127.0.0.1', WORKER_PORT, timeout=180)
            conn.request(self.command, self.path, body=self.rfile.read(size) if size else None, headers=headers)
            response = conn.getresponse()
            body = response.read()
            self.send_response(response.status)
            for k, v in response.getheaders():
                if k.lower() not in HOP and k.lower() != 'cache-control':
                    self.send_header(k, v)
            self.send_header('Cache-Control', 'private, no-store')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()
            if self.command != 'HEAD':
                self.wfile.write(body)
            conn.close()
        except (OSError, ValueError, http.client.HTTPException):
            self.send_error(502, 'Aplicacion temporalmente no disponible')

if __name__ == '__main__':
    ThreadingHTTPServer(('0.0.0.0', 3040), Gateway).serve_forever()
