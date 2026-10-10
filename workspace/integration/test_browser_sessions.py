"""Exercise browser sessions without credentials or financial data."""
import importlib.util
import json
from pathlib import Path
import shutil
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT))


class BrowserSessionsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        shutil.copy(ROOT / 'server.py', root / 'server.py')
        assets = ROOT / 'browser-auth' if (ROOT / 'browser-auth').is_dir() else ROOT
        (root / 'browser-auth').mkdir()
        for name in ('login.html', 'login.js', 'login.css'):
            shutil.copy(assets / name, root / 'browser-auth' / name)
        (root / 'credentials.json').write_text(json.dumps({'password': 'test-password', 'token': 'test-mcp-token', 'user_id': 'fixture-family'}))
        spec = importlib.util.spec_from_file_location('gateway_fixture', root / 'server.py')
        self.gateway = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.gateway)
        self.server = self.gateway.ThreadingHTTPServer(('127.0.0.1', 0), self.gateway.Gateway)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f'http://127.0.0.1:{self.server.server_port}'
        self.host = self.gateway.HTTPS_HOST
        self.origin = 'https://' + self.host
        connection = MagicMock()
        response = connection.getresponse.return_value
        response.status = 200
        response.read.return_value = b'fixture'
        response.getheaders.return_value = [('Content-Type', 'text/plain')]
        self.proxy = patch.object(self.gateway, 'HTTPConnection', return_value=connection)
        self.connect = self.proxy.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.proxy.stop()
        self.temp.cleanup()

    def request(self, path, payload=None, cookie=None, **extra):
        headers = {'Host': self.host, 'Origin': self.origin, 'Content-Type': 'application/json', 'X-Juanca-Request': '1'}
        if cookie:
            headers['Cookie'] = cookie
        headers.update(extra)
        return urlopen(Request(self.base + path, data=json.dumps(payload).encode() if payload is not None else None, headers=headers))

    def login(self, remember=True, **extra):
        with self.request('/api/login', {'username': 'juanca', 'password': 'test-password', 'remember': remember}, **extra) as response:
            self.assertEqual(response.status, 200)
            return response.headers['Set-Cookie']

    def test_public_login_and_protected_data(self):
        with self.request('/') as response:
            self.assertTrue(response.geturl().endswith('/login'))
            self.assertIn('Lembrar neste dispositivo', response.read().decode())
        for path in ('/api/dashboard', '/api/hermes/chat', '/api/mcp'):
            with self.assertRaises(HTTPError) as error:
                self.request(path)
            self.assertEqual(error.exception.code, 401)
            self.assertIsNone(error.exception.headers.get('WWW-Authenticate'))
        with self.assertRaises(HTTPError) as error:
            self.request('/api/login', {'username': 'juanca', 'password': 'wrong'})
        self.assertEqual(error.exception.code, 401)
        self.connect.assert_not_called()
        with self.request('/juanca-app-180.png') as response:
            self.assertEqual(response.status, 200)

    def test_remember_restart_cookie_identity_and_logout(self):
        value = self.login()
        cookie = value.split(';')[0]
        token = cookie.split('=', 1)[1]
        for flag in ('__Host-juanca-session=', 'Max-Age=2592000', 'Secure', 'HttpOnly', 'SameSite=Strict'):
            self.assertIn(flag, value)
        restarted = self.gateway.Sessions(self.gateway.SESSIONS.path, self.gateway.AUTH)
        self.assertTrue(restarted.valid(token, self.host))
        with sqlite3.connect(restarted.path) as conn:
            row = conn.execute('SELECT token_hash,expires FROM sessions').fetchone()
            self.assertNotEqual(row[0], token)
            self.assertAlmostEqual(row[1] - time.time(), 2592000, delta=5)
        with self.request('/api/dashboard', cookie=cookie, **{'oai-authenticated-user-id': 'attacker'}) as response:
            self.assertEqual(response.status, 200)
        headers = self.connect.return_value.request.call_args.kwargs['headers']
        self.assertEqual(headers['oai-authenticated-user-id'], 'fixture-family')
        self.assertNotIn('Cookie', headers)
        with self.request('/api/logout', {}, cookie=cookie) as response:
            self.assertIn('Max-Age=0', response.headers['Set-Cookie'])
        self.assertFalse(restarted.valid(token, self.host))
        with self.assertRaises(HTTPError) as error:
            self.request('/api/dashboard', cookie=cookie)
        self.assertEqual(error.exception.code, 401)

    def test_http_local_session_and_no_remember(self):
        value = self.login(False, Host='localhost:3040', Origin='http://localhost:3040')
        self.assertIn('juanca-local-session=', value)
        self.assertNotIn('Secure', value)
        self.assertNotIn('Max-Age', value)
        cookie = value.split(';')[0]
        with self.request('/api/dashboard', cookie=cookie, Host='localhost:3040') as response:
            self.assertEqual(response.status, 200)
        with self.assertRaises(HTTPError) as error:
            self.request('/api/dashboard', cookie=cookie)
        self.assertEqual(error.exception.code, 401)

    def test_cross_origin_and_missing_origin_rejected(self):
        cookie = self.login().split(';')[0]
        for path in ('/api/login', '/api/logout', '/api/transactions'):
            with self.assertRaises(HTTPError) as error:
                self.request(path, {}, cookie=cookie, Origin='https://foreign.example')
            self.assertEqual(error.exception.code, 403)
        with self.assertRaises(HTTPError) as error:
            self.request('/api/transactions', {}, cookie=cookie, Origin='')
        self.assertEqual(error.exception.code, 403)

    def test_machine_token_preserved_and_basic_cannot_restore_logged_out_session(self):
        with self.request('/api/mcp', {}, Authorization='Bearer test-mcp-token', Origin='') as response:
            self.assertEqual(response.status, 200)
        with self.assertRaises(HTTPError) as error:
            self.request('/api/dashboard', Authorization='Basic anVhbmNhOnRlc3QtcGFzc3dvcmQ=')
        self.assertEqual(error.exception.code, 401)

    def test_expiry_password_change_and_throttling(self):
        token = self.gateway.SESSIONS.create(self.host, True)
        with sqlite3.connect(self.gateway.SESSIONS.path) as conn:
            conn.execute('UPDATE sessions SET expires=?', (time.time() - 1,))
        self.assertFalse(self.gateway.SESSIONS.valid(token, self.host))
        token = self.gateway.SESSIONS.create(self.host, True)
        changed = dict(self.gateway.AUTH, hash='0' * 64)
        restarted = self.gateway.Sessions(self.gateway.SESSIONS.path, changed)
        self.assertFalse(restarted.valid(token, self.host))
        for _ in range(10):
            self.gateway.SESSIONS.allow_attempt('127.0.0.1')
        with self.assertRaises(HTTPError) as error:
            self.login()
        self.assertEqual(error.exception.code, 429)


if __name__ == '__main__':
    unittest.main()
