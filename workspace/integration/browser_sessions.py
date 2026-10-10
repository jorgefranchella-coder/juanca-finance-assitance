"""Revocable device sessions; only token hashes are stored on disk."""
import hashlib
import hmac
import secrets
import sqlite3
import threading
import time
from http.cookies import SimpleCookie, CookieError

COOKIE_NAME = '__Host-juanca-session'
REMEMBER_SECONDS = 30 * 24 * 60 * 60
SESSION_SECONDS = 12 * 60 * 60


def password_valid(auth, username, password):
    if not isinstance(username, str) or not isinstance(password, str):
        return False
    if len(username) > 150 or len(password) > 1024:
        return False
    digest = hashlib.pbkdf2_hmac('sha256', password.encode(), bytes.fromhex(auth['salt']), 600000).hex()
    return hmac.compare_digest(username.encode(), auth['username'].encode()) & hmac.compare_digest(digest, auth['hash'])


class Sessions:
    def __init__(self, path, auth):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.auth_key = hashlib.sha256((auth['username'] + ':' + auth['salt'] + ':' + auth['hash']).encode()).hexdigest()
        self.lock = threading.Lock()
        self.attempts = {}
        with sqlite3.connect(self.path) as conn:
            conn.execute('CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, expires REAL NOT NULL, auth_key TEXT NOT NULL, host TEXT NOT NULL)')
            conn.execute('DELETE FROM sessions WHERE expires <= ? OR auth_key != ?', (time.time(), self.auth_key))
        self.path.chmod(0o600)

    @staticmethod
    def token(headers, name=COOKIE_NAME):
        try:
            cookies = SimpleCookie(headers.get('Cookie', ''))
            item = cookies.get(name)
            return item.value if item and len(item.value) == 43 else ''
        except CookieError:
            return ''

    @staticmethod
    def digest(token):
        return hashlib.sha256(token.encode()).hexdigest()

    def valid(self, token, host):
        if not token:
            return False
        with sqlite3.connect(self.path) as conn:
            row = conn.execute('SELECT 1 FROM sessions WHERE token_hash=? AND expires>? AND auth_key=? AND host=?',
                               (self.digest(token), time.time(), self.auth_key, host)).fetchone()
        return row is not None

    def create(self, host, remember, previous=''):
        token = secrets.token_urlsafe(32)
        lifetime = REMEMBER_SECONDS if remember else SESSION_SECONDS
        with sqlite3.connect(self.path) as conn:
            conn.execute('DELETE FROM sessions WHERE expires <= ? OR token_hash=?', (time.time(), self.digest(previous)))
            conn.execute('INSERT INTO sessions VALUES(?,?,?,?)', (self.digest(token), time.time() + lifetime, self.auth_key, host))
        return token

    def revoke(self, token):
        with sqlite3.connect(self.path) as conn:
            conn.execute('DELETE FROM sessions WHERE token_hash=?', (self.digest(token),))

    def allow_attempt(self, address):
        now = time.monotonic()
        with self.lock:
            self.attempts = {key: [t for t in times if now - t < 300]
                             for key, times in self.attempts.items() if times and now - times[-1] < 300}
            times = self.attempts.setdefault(address, [])
            if len(times) >= 10:
                return False
            times.append(now)
            return True


def session_cookie(token, remember=False, clear=False, secure=True):
    name = COOKIE_NAME if secure else 'juanca-local-session'
    value = f'{name}={token}; Path=/; HttpOnly; SameSite=Strict'
    if secure:
        value += '; Secure'
    if clear:
        value += '; Max-Age=0'
    elif remember:
        value += f'; Max-Age={REMEMBER_SECONDS}'
    return value
