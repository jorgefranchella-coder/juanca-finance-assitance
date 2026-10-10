"""Restricted browser bridge to Juanca's native session API."""
import json
import threading
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError

ROOT = Path(__file__).parent
LOCK = threading.Lock()

def call(path, body=None):
    config = json.loads((ROOT / 'credentials.json').read_text())
    headers = {'Authorization': 'Bearer ' + config['hermes_api_key']}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers['Content-Type'] = 'application/json'
    with urlopen(Request('http://127.0.0.1:8644' + path, data=data, headers=headers), timeout=900) as r:
        return json.load(r)

def session():
    p = ROOT / 'state' / 'web-chat-session.json'
    if p.exists():
        return json.loads(p.read_text())['id']
    result = call('/api/sessions', {'title': 'Patrimônio — Juanca', 'model': 'gpt-5.5'})
    sid = result.get('session', {}).get('id') or result.get('id') or result.get('session_id')
    if not sid:
        raise ValueError('No se pudo crear la sesión de Hermes')
    p.parent.mkdir(exist_ok=True)
    p.write_text(json.dumps({'id': sid}))
    p.chmod(0o600)
    return sid

def handle(handler):
    if not LOCK.acquire(blocking=False):
        reply(handler, 409, {'detail': 'Juanca está atendiendo el mensaje anterior. Espera a que termine.'})
        return
    try:
        sid = session()
        if handler.command == 'POST':
            size = int(handler.headers.get('Content-Length', '0'))
            if size <= 0 or size > 40000 or handler.headers.get('Transfer-Encoding'):
                reply(handler, 400, {'detail': 'Mensaje inválido.'})
                return
            body = json.loads(handler.rfile.read(size))
            message = body.get('message', '') if isinstance(body, dict) else ''
            if not isinstance(message, str) or not message.strip() or len(message) > 8000:
                reply(handler, 400, {'detail': 'Escribe un mensaje de hasta 8.000 caracteres.'})
                return
            result = call(f'/api/sessions/{sid}/chat', {'message': message.strip()})
            answer = result.get('message', {}).get('content')
            if not isinstance(answer, str) or not answer.strip():
                raise ValueError('Hermes no devolvió respuesta')
            sid = result.get('session_id') or sid
            (ROOT / 'state' / 'web-chat-session.json').write_text(json.dumps({'id':sid}))
        history = call(f'/api/sessions/{sid}/messages')
        messages = [{'role': m['role'], 'content': m['content']} for m in history.get('data', [])
                    if m.get('role') in ('user', 'assistant') and isinstance(m.get('content'), str) and m['content'].strip()]
        reply(handler, 200, {'messages': messages})
    except (OSError, ValueError, HTTPError):
        reply(handler, 502, {'detail': 'No se pudo completar la consulta a Juanca. Revisa la conversación antes de reenviar.'})
    finally:
        LOCK.release()

def reply(handler, status, body):
    data = json.dumps(body, ensure_ascii=False).encode()
    handler.send_response(status)
    handler.send_header('Content-Type', 'application/json; charset=utf-8')
    handler.send_header('Cache-Control', 'private, no-store')
    handler.send_header('Content-Length', str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)
