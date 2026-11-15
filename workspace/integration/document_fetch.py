"""Bounded, direct HTTPS document retrieval; never include URLs in results or errors."""
import fcntl
import http.client
import json
import ipaddress
import os
import selectors
import signal
import socket
import ssl
import subprocess
import tempfile
import stat
import threading
import time
from urllib.parse import urljoin, urlsplit

TIMEOUT = 20
MAX_REDIRECTS = 5
MAX_BYTES = 15 * 1024 * 1024
MAX_TEXT = 200_000
DNS_RESOLVER = os.path.join(os.path.dirname(__file__), 'dns_resolver.py')

def _dns_runtime_dir(environ=None):
    source = os.environ if environ is None else environ
    return source.get('JUANCA_DNS_RUNTIME_DIR') or source.get('XDG_RUNTIME_DIR')


class FetchError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)

def remaining(deadline):
    result = deadline - time.monotonic()
    if result <= 0:
        raise FetchError('timeout')
    return result

def _dns_lookup(host, port, deadline):
    # A single kernel lock covers all profiles of this Unix user. The resolver
    # inherits it, so client death cannot release the slot while DNS is alive.
    try:
        runtime_dir = _dns_runtime_dir()
        if not runtime_dir:
            raise FetchError('tool_unavailable')
        # The configured runtime directory parent must be system-owned; the user runtime is
        # private. Open each component without following links, then operate
        # relative to verified directory fds to avoid path replacement races.
        parent_path, runtime_name = os.path.split(runtime_dir)
        parent_fd = os.open(parent_path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            parent_info = os.fstat(parent_fd)
            parent_mode = stat.S_IMODE(parent_info.st_mode)
            if parent_info.st_uid != 0 or (parent_mode & 0o022 and not (parent_mode & stat.S_ISVTX)):
                raise FetchError('tool_unavailable')
            runtime_fd = os.open(runtime_name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
        finally:
            os.close(parent_fd)
        try:
            info = os.fstat(runtime_fd)
            if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
                raise FetchError('tool_unavailable')
            try:
                os.mkdir('juanca-document-dns', 0o700, dir_fd=runtime_fd)
            except FileExistsError:
                pass
            directory_fd = os.open('juanca-document-dns', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=runtime_fd)
        finally:
            os.close(runtime_fd)
        try:
            info = os.fstat(directory_fd)
            if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
                raise FetchError('tool_unavailable')
            fd = os.open('dns.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600, dir_fd=directory_fd)
        finally:
            os.close(directory_fd)
        lock_info = os.fstat(fd)
        if (not stat.S_ISREG(lock_info.st_mode) or lock_info.st_uid != os.getuid()
                or stat.S_IMODE(lock_info.st_mode) != 0o600 or lock_info.st_nlink != 1):
            os.close(fd)
            raise FetchError('tool_unavailable')
    except OSError:
        raise FetchError('tool_unavailable') from None
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise FetchError('busy') from None
        remaining(deadline)
        process = subprocess.Popen(['/usr/bin/python3', '-I', DNS_RESOLVER, host, str(port),
                                    str(deadline), str(os.getpid())], stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, start_new_session=True, pass_fds=(fd,))
        try:
            output = _capture_process(process, deadline)
        except FetchError as exc:
            if exc.code == 'timeout' or process.returncode in (124, -signal.SIGALRM): raise FetchError('timeout') from None
            if process.returncode == 125: raise FetchError('tool_unavailable') from None
            raise FetchError('network_error') from None
        try:
            values = json.loads(output)
            if not isinstance(values, list) or not all(isinstance(v, str) for v in values):
                raise ValueError()
            return values
        except (ValueError, UnicodeError):
            raise FetchError('network_error') from None
    except OSError:
        raise FetchError('tool_unavailable') from None
    finally:
        os.close(fd)


def resolve(host, port, deadline):
    addresses = _dns_lookup(host, port, deadline)
    if not addresses:
        raise FetchError('network_error')
    ips = set()
    for entry in addresses:
        try:
            address = ipaddress.ip_address(entry.split('%')[0])
        except ValueError:
            raise FetchError('unsafe_destination') from None
        if not address.is_global or address.is_multicast or getattr(address, 'ipv4_mapped', None):
            raise FetchError('unsafe_destination')
        ips.add(str(address))
    return sorted(ips)

class PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host, port, ip, timeout):
        super().__init__(host, port, timeout=timeout, context=ssl.create_default_context())
        self.ip = ip
    def connect(self):
        raw = socket.create_connection((self.ip, self.port), self.timeout)
        try:
            self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
        except BaseException:
            raw.close()
            raise

def download(url, *, deadline=None, resolver=resolve, connection=PinnedHTTPSConnection):
    deadline = deadline or time.monotonic() + TIMEOUT
    for hop in range(MAX_REDIRECTS + 1):
        try:
            parts = urlsplit(url)
            if parts.scheme.lower() != 'https' or not parts.hostname or parts.username is not None or parts.password is not None or parts.port not in (None, 443):
                raise FetchError('unsafe_destination')
            host = parts.hostname.encode('idna').decode('ascii')
            if any(ord(c) < 33 or ord(c) == 127 for c in url):
                raise FetchError('unsafe_destination')
            addresses = resolver(host, 443, deadline)
            conn = connection(host, 443, addresses[0], remaining(deadline))
            timer = None
            active_socket = [None]
            try:
                # Force blocking socket operations to end at the overall deadline,
                # even if a peer trickles bytes within the per-operation timeout.
                def abort():
                    sock = active_socket[0] or conn.sock
                    if sock is not None:
                        try: sock.shutdown(socket.SHUT_RDWR)
                        except OSError: pass
                timer = threading.Timer(remaining(deadline), abort)
                timer.daemon = True
                timer.start()
                target = (parts.path or '/') + (('?' + parts.query) if parts.query else '')
                conn.request('GET', target, headers={'Accept': 'application/pdf', 'Accept-Encoding': 'identity', 'User-Agent': 'Juanca-document/1'})
                active_socket[0] = conn.sock
                response = conn.getresponse()
                if response.status in (301, 302, 303, 307, 308):
                    location = response.getheader('Location')
                    if not location:
                        raise FetchError('network_error')
                    if hop == MAX_REDIRECTS:
                        raise FetchError('redirect_limit')
                    url = urljoin(url, location)
                    continue
                if response.status in (401, 403):
                    raise FetchError('authentication_required')
                if response.status in (404, 410):
                    raise FetchError('expired_or_not_found')
                if response.status != 200:
                    raise FetchError('network_error')
                if response.getheader('Content-Encoding', 'identity').lower() not in ('', 'identity'):
                    raise FetchError('unsupported_format')
                size = response.getheader('Content-Length')
                if size is not None:
                    if not size.isdigit():
                        raise FetchError('network_error')
                    if int(size) > MAX_BYTES:
                        raise FetchError('size_limit')
                data = bytearray()
                while True:
                    if conn.sock:
                        conn.sock.settimeout(remaining(deadline))
                    chunk = response.read(min(65536, MAX_BYTES + 1 - len(data)))
                    if not chunk:
                        break
                    data.extend(chunk)
                    if len(data) > MAX_BYTES:
                        raise FetchError('size_limit')
                if not data.startswith(b'%PDF-'):
                    raise FetchError('unsupported_format')
                return bytes(data)
            finally:
                if timer: timer.cancel()
                conn.close()
        except FetchError:
            raise
        except (TimeoutError, socket.timeout):
            raise FetchError('timeout') from None
        except (OSError, ValueError, UnicodeError, http.client.HTTPException):
            raise FetchError('timeout' if time.monotonic() >= deadline else 'network_error') from None
    raise FetchError('redirect_limit')

def _capture_process(process, deadline):
    """Bound pipe reads without a reader thread; process must own a session.

    This helper alone does not contain descendants which create a new session.
    It is not sufficient to authorize running a document converter.
    """
    captured = bytearray()
    selector = selectors.DefaultSelector()
    try:
        os.set_blocking(process.stdout.fileno(), False)
        selector.register(process.stdout, selectors.EVENT_READ)
        while selector.get_map():
            if not selector.select(remaining(deadline)):
                raise FetchError('timeout')
            try:
                chunk = os.read(process.stdout.fileno(), min(65536, MAX_TEXT + 1 - len(captured)))
            except BlockingIOError:
                continue
            if not chunk:
                selector.unregister(process.stdout)
                break
            captured.extend(chunk)
            if len(captured) > MAX_TEXT:
                raise FetchError('text_limit')
        try:
            process.wait(timeout=remaining(deadline))
        except subprocess.TimeoutExpired:
            raise FetchError('timeout') from None
        if process.returncode:
            raise FetchError('unsupported_format')
        return bytes(captured)
    finally:
        selector.close()
        process.stdout.close()
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        # Never make the deadline depend on reaping an uninterruptible child.
        # Popen.wait in a daemon thread performs the eventual reap.
        if process.poll() is None:
            threading.Thread(target=process.wait, daemon=True).start()


def read_pdf(data, deadline):
    # The fixed unit name is a per-user, cross-process quota managed by systemd.
    remaining(deadline)
    reader, writer = os.pipe()
    process = None
    capture_started = False
    stderr_file = tempfile.TemporaryFile()
    try:
        command = ['/usr/bin/systemd-run', '--user', '--quiet', '--wait', '--pipe',
                   '--collect', '--unit=juanca-document-pdf',
                   '--property=MemoryMax=512M', '--property=MemorySwapMax=0',
                   '--property=CPUQuota=50%', '--property=TasksMax=16',
                   '--property=RuntimeMaxSec=20', '--property=KillMode=control-group',
                   '/usr/bin/python3', '-I', os.path.join(os.path.dirname(__file__), 'pdf_sandbox_runner.py'),
                   str(deadline)]
        process = subprocess.Popen(command, stdin=reader, stdout=subprocess.PIPE,
                                   stderr=stderr_file, start_new_session=True,
                                   env=dict(os.environ, LC_ALL='C'))
        os.close(reader)
        reader = None
        # Nonblocking framed write keeps the deadline even if service startup fails.
        os.set_blocking(writer, False)
        with selectors.DefaultSelector() as selector:
            selector.register(writer, selectors.EVENT_WRITE)
            payload = memoryview(len(data).to_bytes(8, 'big') + data)
            while payload:
                if not selector.select(remaining(deadline)): raise FetchError('timeout')
                try: n = os.write(writer, payload)
                except BlockingIOError: continue
                except BrokenPipeError: break  # Read the service's exit status.
                payload = payload[n:]
        capture_started = True
        text = _capture_process(process, deadline)
        result = text.decode('utf-8').strip()
        if not result: raise FetchError('unreadable_pdf')
        return result
    except FetchError as exc:
        if process is not None and process.returncode is not None and exc.code == 'unsupported_format':
            stderr_file.seek(0)
            message = stderr_file.read(4096)
            if process.returncode == 1 and b'already loaded or has a fragment file' in message:
                raise FetchError('busy') from None
            code = {71: 'timeout', 73: 'unsupported_format', 74: 'text_limit'}.get(process.returncode, 'tool_unavailable')
            raise FetchError(code) from None
        raise
    except FileNotFoundError:
        raise FetchError('tool_unavailable') from None
    except (OSError, UnicodeError):
        raise FetchError('unsupported_format') from None
    finally:
        stderr_file.close()
        if reader is not None: os.close(reader)
        os.close(writer)
        if process is not None and not capture_started:
            try: os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError: pass
            if process.poll() is None: threading.Thread(target=process.wait, daemon=True).start()
            if not process.stdout.closed: process.stdout.close()

def retrieve(url):
    deadline = time.monotonic() + TIMEOUT
    try:
        data = download(url, deadline=deadline)
        text = read_pdf(data, deadline)
        return {'status': 'ok', 'text': text, 'imported': False,
                'next_step': 'Documento leído localmente; no fue importado ni se verificaron identidad o autorización del enlace.'}
    except FetchError as exc:
        next_step = ('El servicio está ocupado; vuelve a intentarlo en unos instantes.'
                     if exc.code == 'busy' else
                     'No se pudo leer el documento. Pide al usuario que envíe el PDF o una captura.')
        return {'status': 'error', 'code': exc.code, 'imported': False, 'next_step': next_step}

