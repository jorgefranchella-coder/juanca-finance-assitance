"""Authenticated local-network gateway; internal Worker must remain on loopback."""
import os
import hashlib
import hmac
import http.client
from http.client import HTTPConnection
import json
import ipaddress
import re
from decimal import Decimal, ROUND_HALF_UP
from urllib.parse import urlsplit, unquote, parse_qs
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
MARKET_CONFIG_PATH = Path(os.environ.get('JUANCA_MARKET_CONFIG', '/home/jorge/.local/share/juanca-shadow/market.json'))
AUTHORITY_CONFIG_PATH = Path(os.environ.get('JUANCA_AUTHORITY_CONFIG', '/home/jorge/.local/share/juanca-shadow/authority.json'))
MARKET_JOB = re.compile(r'^/api/shadow/market/jobs/([0-9a-fA-F-]{36})$')
PORTFOLIO_READ_ROUTES = {'/api/portfolio/dashboard', '/api/portfolio/positions', '/api/portfolio/summary'}
LEGACY_WRITE_PREFIXES = ('/api/import/', '/api/transactions/', '/api/portfolio/reviews', '/api/portfolio/cost-basis', '/api/portfolio/confirmations', '/api/market/refresh')
ALLOCATION_LABELS = {
    'fixed_income': 'Renda fixa bancária', 'treasury': 'Tesouro Direto', 'equity': 'Ações',
    'bdr': 'BDRs', 'etf': 'ETFs', 'fund': 'Fundos listados', 'other': 'Outros ativos B3',
    'international_equity': 'Ações e ETFs internacionais', 'international_fixed_income': 'Renda fixa internacional',
    'money_market': 'Fundo monetário em USD', 'private_pension': 'Previdência privada',
}

def portfolio_authority_mode(path=None):
    path = path or AUTHORITY_CONFIG_PATH
    try:
        value = json.loads(path.read_text())
    except FileNotFoundError:
        return 'legacy'
    if not isinstance(value, dict) or set(value) != {'mode'} or value['mode'] not in {'legacy', 'postgres', 'freeze'}:
        raise ValueError('INVALID_AUTHORITY_CONFIGURATION')
    return value['mode']

def authoritative_dashboard(view):
    positions = [p for p in view.get('positions', []) if p.get('instrument_code') != 'USD_CASH']
    owners, classes = {}, {}
    for p in positions:
        value = int(p['market_value_cents']) if p.get('market_value_cents') is not None else 0
        owner, asset_class = str(p.get('owner') or 'Sin identificar'), str(p.get('asset_class') or 'other')
        owners[owner] = owners.get(owner, 0) + value
        classes[asset_class] = classes.get(asset_class, 0) + value
    total = sum(owners.values())
    allocations = [{'key': key, 'label': ALLOCATION_LABELS.get(key, ALLOCATION_LABELS['other']),
                    'value_cents': value, 'share': value / total * 100 if total else 0}
                   for key, value in sorted(classes.items(), key=lambda row: -row[1])]
    usd = sum(1 for p in positions if p.get('currency') == 'USD')
    pension = sum(1 for p in positions if p.get('asset_class') == 'private_pension')
    dates = sorted(str(p.get('price_as_of') or '')[:10] for p in positions if p.get('price_as_of'))
    return {'total_value_cents': total, 'portfolio_version': view.get('portfolio_version'),
            'facts_revision': view.get('facts_revision'), 'valuation_complete': view.get('valuation_complete'),
            'unvalued_count': view.get('unvalued_count', 0), 'owners': [{'owner': k, 'value_cents': v} for k, v in sorted(owners.items())],
            'allocation': allocations, 'reference_date': view.get('reference_date'), 'activity': [],
            'activity_period': {'from': '', 'to': ''},
            'coverage': 'b3_avenue_pension' if usd and pension else 'b3_pension' if pension else 'b3_avenue' if usd else 'b3_only',
            'sources': {'avenue_positions': usd, 'pension_positions': pension, 'ptax': view.get('ptax'),
                        'us_quote_count': sum(1 for p in positions if p.get('currency') == 'USD' and p.get('price_as_of')),
                        'latest_us_quote': dates[-1] if dates else None,
                        'quote_status': 'market_quotes_with_fixed_income_mtm' if usd else 'not_applicable'},
            'mode': 'postgres', 'authoritative': True}

def authoritative_positions(view, acquisition_report=None):
    identities = (acquisition_report or {}).get('positions', [])
    index = {}
    for item in identities:
        key = (item.get('owner'), item.get('institution'), item.get('instrument_code'), item.get('currency'))
        index.setdefault(key, []).append(item)
    positions = []
    for row in view.get('positions', []):
        if row.get('instrument_code') == 'USD_CASH':
            continue
        key = (row.get('owner'), row.get('institution'), row.get('instrument_code'), row.get('currency'))
        matches = index.get(key, [])
        cost = None; cost_status = 'missing'
        if len(matches) == 1:
            identity = matches[0]
            if not identity.get('custody_identity_resolved'):
                cost_status = 'ambiguous_position'
            elif identity.get('status') == 'matches_snapshot' and identity.get('weighted_average_unit_price') is not None:
                cost = Decimal(str(identity['weighted_average_unit_price']))
                cost_status = 'available'
        quantity = Decimal(str(row.get('quantity') or '0'))
        cost_cents = int((cost * quantity * 100).quantize(Decimal('1'), rounding=ROUND_HALF_UP)) if cost is not None else None
        value = int(row['market_value_cents']) if row.get('market_value_cents') is not None else None
        positions.append({**row, 'account': row.get('account'), 'average_unit_cost': float(cost) if cost is not None else None,
                          'cost_currency': row.get('currency') if cost is not None else None,
                          'cost_basis_cents': cost_cents, 'unrealized_pnl_cents': value - cost_cents if value is not None and cost_cents is not None else None,
                          'cost_status': cost_status})
    total = sum(int(p['market_value_cents']) for p in positions if p.get('market_value_cents') is not None)
    return {'positions': positions, 'count': len(positions), 'total_value_cents': total,
            'reference_date': view.get('reference_date'), 'portfolio_version': view.get('portfolio_version'),
            'valuation_complete': view.get('valuation_complete'), 'mode': 'postgres', 'authoritative': True}
SHADOW_ROUTES = {
    '/api/shadow/portfolio': {'GET'},
    '/api/shadow/authority/readiness': {'GET'},
    '/api/shadow/confirmations': {'GET', 'POST'},
    '/api/shadow/positions': {'GET'},
    '/api/shadow/fixed-income-projection': {'GET'},
    '/api/shadow/conversations/family/messages': {'GET', 'POST'},
    '/api/shadow/evidence/text': {'GET', 'POST'},
    '/api/shadow/evidence/photos': {'GET', 'POST'},
    '/api/shadow/evidence/documents': {'POST'},
    '/api/shadow/reconciliation/b3/candidates': {'GET'},
    '/api/shadow/reconciliation/b3/snapshots': {'GET'},
    '/api/shadow/reconciliation/external/snapshots': {'GET'},
    '/api/shadow/reconciliation/b3/decisions': {'POST'},
    '/api/shadow/position-identities/acquisition-reconciliation': {'GET'},
    '/api/shadow/position-identities': {'GET'},
    '/api/shadow/reconciliation/manual-b3/candidates': {'GET'},
    '/api/shadow/reconciliation/manual-b3/decisions': {'POST'},
    '/api/shadow/proposals': {'GET', 'POST'},
    '/api/shadow/accounts': {'GET'},
    '/api/shadow/owners': {'GET'},
}
SHADOW_ITEM = re.compile(r'^/api/shadow/evidence/(text|photos|documents)/([0-9a-fA-F-]{36})(/content)?$')
SHADOW_PROPOSAL_COMMAND = re.compile(r'^/api/shadow/proposals/([0-9a-fA-F-]{36})/(approve|reject)$')
SHADOW_B3_PUBLISH = re.compile(r'^/api/shadow/reconciliation/b3/snapshots/([A-Za-z0-9._:-]+)/publish$')
SHADOW_EXTERNAL_PUBLISH = re.compile(r'^/api/shadow/reconciliation/external/snapshots/([A-Za-z0-9._:-]+)/publish$')
SHADOW_POSITION_ACQUISITIONS = re.compile(r'^/api/shadow/position-identities/([0-9a-fA-F-]{36})/acquisitions$')
SHADOW_CONFIRMATION_DECISION = re.compile(r'^/api/shadow/confirmations/([A-Za-z0-9._:-]{1,240})/decisions$')
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
            proposal_command = SHADOW_PROPOSAL_COMMAND.fullmatch(path)
            b3_publish = SHADOW_B3_PUBLISH.fullmatch(path)
            external_publish = SHADOW_EXTERNAL_PUBLISH.fullmatch(path)
            position_acquisitions = SHADOW_POSITION_ACQUISITIONS.fullmatch(path)
            confirmation_decision = SHADOW_CONFIRMATION_DECISION.fullmatch(path)
            if proposal_command:
                methods = {'POST'}
            elif b3_publish:
                methods = {'POST'}
            elif external_publish:
                methods = {'POST'}
            elif position_acquisitions:
                methods = {'GET', 'POST'}
            elif confirmation_decision:
                methods = {'POST'}
            elif not match:
                self.reply_json(404, {'code': 'NOT_FOUND'})
                return
            else:
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
            query = urlsplit(self.path).query
            if query:
                target += '?' + query
            headers = {'Authorization': 'Bearer ' + shadow['token'], 'Accept-Encoding': 'identity'}
            if (path in {'/api/shadow/reconciliation/manual-b3/decisions', '/api/shadow/reconciliation/b3/decisions'} or
                    SHADOW_B3_PUBLISH.fullmatch(path) or
                    SHADOW_EXTERNAL_PUBLISH.fullmatch(path) or
                    SHADOW_POSITION_ACQUISITIONS.fullmatch(path) or
                    path == '/api/shadow/confirmations' and self.command == 'POST' or
                    SHADOW_CONFIRMATION_DECISION.fullmatch(path) or
                    path == '/api/shadow/proposals' and self.command == 'POST' or
                    SHADOW_PROPOSAL_COMMAND.fullmatch(path)) and self.command == 'POST':
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

    def shadow_market(self, path):
        job = MARKET_JOB.fullmatch(path)
        methods = {'POST'} if path == '/api/shadow/market/refresh' else {'GET'} if path in {'/api/shadow/market/quotes', '/api/shadow/market/fx/USD-BRL'} or job else set()
        if not methods:
            self.reply_json(404, {'code': 'NOT_FOUND'})
            return
        if self.command not in methods:
            self.reply_json(405, {'code': 'METHOD_NOT_ALLOWED'})
            return
        try:
            query = urlsplit(self.path).query
            if path == '/api/shadow/market/quotes':
                raw_params = parse_qs(query, keep_blank_values=True, strict_parsing=True)
                if set(raw_params) != {'market', 'symbols'} or any(len(values) != 1 for values in raw_params.values()):
                    self.reply_json(422, {'code': 'INVALID_QUERY'})
                    return
                params = {key: values[0] for key, values in raw_params.items()}
                if params['market'] not in {'B3', 'US'} or not re.fullmatch(r'[A-Z0-9.,]{1,1299}', params['symbols']):
                    self.reply_json(422, {'code': 'INVALID_QUERY'})
                    return
            elif query:
                self.reply_json(400, {'code': 'INVALID_QUERY'})
                return
            body = None
            headers = {'Accept-Encoding': 'identity'}
            if self.command == 'POST':
                size = int(self.headers.get('Content-Length', '0'))
                key = self.headers.get('Idempotency-Key', '')
                if not 0 < size <= 16_000 or self.headers.get('Transfer-Encoding') or self.headers.get('Content-Type', '').split(';')[0] != 'application/json' or not re.fullmatch(r'[A-Za-z0-9._:-]{8,128}', key):
                    self.reply_json(422, {'code': 'INVALID_REFRESH_REQUEST'})
                    return
                body = self.rfile.read(size)
                try:
                    payload = json.loads(body)
                    if not isinstance(payload, dict) or set(payload) != {'b3_symbols', 'us_symbols', 'include_fx'} or not isinstance(payload['b3_symbols'], list) or not isinstance(payload['us_symbols'], list) or payload['include_fx'] is not True:
                        raise ValueError()
                    if len(payload['b3_symbols']) > 100 or len(payload['us_symbols']) > 100 or any(not isinstance(x, str) or not re.fullmatch(r'[A-Z]{4}\d{1,2}[A-Z]?', x) for x in payload['b3_symbols']) or any(not isinstance(x, str) or not re.fullmatch(r'[A-Z.]{1,10}', x) for x in payload['us_symbols']) or not payload['b3_symbols'] and not payload['us_symbols']:
                        raise ValueError()
                except (ValueError, KeyError, TypeError):
                    self.reply_json(422, {'code': 'INVALID_REFRESH_REQUEST'})
                    return
                headers.update({'Content-Type': 'application/json', 'Idempotency-Key': key})
            market = json.loads(MARKET_CONFIG_PATH.read_text())
            if not isinstance(market.get('token'), str) or len(market['token']) < 32 or not isinstance(market.get('port'), int) or not 1024 <= market['port'] <= 65535:
                raise ValueError()
            target = '/v1' + path.removeprefix('/api/shadow/market')
            if query:
                target += '?' + query
            headers['Authorization'] = 'Bearer ' + market['token']
            connection = HTTPConnection('127.0.0.1', market['port'], timeout=25)
            try:
                connection.request(self.command, target, body=body, headers=headers)
                response = connection.getresponse()
                content = response.read()
                mime = response.getheader('Content-Type', 'application/json').split(';')[0]
                self.reply(response.status, content, mime)
            finally:
                connection.close()
        except (OSError, ValueError, KeyError, http.client.HTTPException):
            self.reply_json(502, {'code': 'MARKET_UNAVAILABLE'})

    def postgres_portfolio_read(self, path):
        try:
            shadow = json.loads(SHADOW_CONFIG_PATH.read_text())
            connection = HTTPConnection('127.0.0.1', int(shadow['port']), timeout=30)
            try:
                def get(target):
                    connection.request('GET', target, headers={'Authorization': 'Bearer ' + shadow['token'], 'Accept-Encoding': 'identity'})
                    response = connection.getresponse(); body = response.read()
                    if response.status != 200:
                        raise RuntimeError('POSTGRES_READ_FAILED')
                    return json.loads(body)
                view = get('/v1/portfolio')
                if path == '/api/portfolio/dashboard':
                    result = authoritative_dashboard(view)
                elif path == '/api/portfolio/positions':
                    acquisitions = get('/v1/position-identities/acquisition-reconciliation')
                    result = authoritative_positions(view, acquisitions)
                else:
                    confirmations = get('/v1/confirmations?status=open')
                    b3 = get('/v1/reconciliation/b3/snapshots')
                    external = get('/v1/reconciliation/external/snapshots')
                    published = sum(1 for row in [*b3.get('snapshots', []), *external.get('snapshots', [])] if row.get('published'))
                    result = {'import_count': published, 'review_count': int(confirmations.get('open_count', 0)),
                              'reviews': [], 'mode': 'postgres', 'authoritative': True}
                self.reply_json(200, result, {'X-Juanca-Portfolio-Authority': 'postgres'})
            finally:
                connection.close()
        except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError, http.client.HTTPException, RuntimeError):
            self.reply_json(503, {'code': 'POSTGRES_PORTFOLIO_UNAVAILABLE', 'authoritative': True},
                            {'X-Juanca-Portfolio-Authority': 'postgres'})

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
        try:
            authority_mode = portfolio_authority_mode()
        except (OSError, ValueError, json.JSONDecodeError):
            self.reply_json(503, {'code': 'AUTHORITY_CONFIGURATION_UNAVAILABLE'})
            return
        if authority_mode == 'freeze' and path.startswith('/api/') and self.command not in ('GET', 'HEAD', 'OPTIONS'):
            self.reply_json(423, {'code': 'CUTOVER_FREEZE', 'message': 'Las escrituras están pausadas durante la captura final.'})
            return
        if authority_mode == 'postgres':
            if path in PORTFOLIO_READ_ROUTES and self.command in ('GET', 'HEAD'):
                self.postgres_portfolio_read(path)
                return
            if path.startswith(LEGACY_WRITE_PREFIXES) and self.command not in ('GET', 'HEAD', 'OPTIONS'):
                self.reply_json(409, {'code': 'LEGACY_WRITER_DISABLED', 'authority': 'postgres'},
                                {'X-Juanca-Portfolio-Authority': 'postgres'})
                return
        if path == '/api/authority' and self.command in ('GET', 'HEAD'):
            self.reply_json(200, {'mode': authority_mode, 'authoritative': authority_mode == 'postgres',
                                  'frozen': authority_mode == 'freeze'})
            return
        if path.startswith('/api/shadow/'):
            if path.startswith('/api/shadow/market/'):
                self.shadow_market(path)
                return
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
