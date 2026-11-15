"""Entry point for a systemd transient PDF service; stdin is a client liveness pipe."""
import os
import selectors
import subprocess
import sys
import time

MEMORY = 512 * 1024 * 1024
MAX_TEXT = 200_000


def main():
    deadline = float(sys.argv[1])
    if time.monotonic() >= deadline: return 71
    # Verify the actual cgroup before executing untrusted PDF content.
    cg = '/sys/fs/cgroup' + open('/proc/self/cgroup').read().strip().split('::', 1)[1]
    def read(name):
        with open(cg + '/' + name) as f: return f.read().strip()
    if int(read('memory.max')) > MEMORY or int(read('pids.max')) > 16:
        return 70
    quota, period = read('cpu.max').split()
    if quota == 'max' or int(quota) * 2 > int(period): return 70
    if read('memory.swap.max') != '0': return 70
    # Input is framed over the client's liveness pipe; no PDF is written to disk.
    sel_input = selectors.DefaultSelector()
    sel_input.register(sys.stdin.buffer, selectors.EVENT_READ)
    def read_exact(size):
        parts = bytearray()
        while len(parts) < size:
            timeout = deadline - time.monotonic()
            if timeout <= 0 or not sel_input.select(timeout): raise TimeoutError()
            chunk = os.read(0, min(65536, size-len(parts)))
            if not chunk: raise EOFError()
            parts.extend(chunk)
        return parts
    size = int.from_bytes(read_exact(8), 'big')
    if size > 15 * 1024 * 1024: return 70
    content = read_exact(size)
    sel_input.close()
    fd = os.memfd_create('juanca-pdf', flags=0)
    view = memoryview(content)
    while view:
        view = view[os.write(fd, view):]
    del view, content
    os.lseek(fd, 0, os.SEEK_SET)
    command = ['/usr/bin/bwrap', '--unshare-user', '--unshare-pid', '--unshare-net',
               '--die-with-parent', '--clearenv', '--ro-bind', '/usr', '/usr',
               '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64',
               '--ro-bind-data', str(fd), '/input.pdf', '--proc', '/proc', '--dev', '/dev',
               '/usr/bin/prlimit', '--as=536870912:536870912', '--cpu=10:10',
               '--', '/usr/bin/pdftotext', '-enc', 'UTF-8', '/input.pdf', '-']
    process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, pass_fds=(fd,))
    os.close(fd)
    sel = selectors.DefaultSelector()
    sel.register(sys.stdin.buffer, selectors.EVENT_READ, 'client')
    sel.register(process.stdout, selectors.EVENT_READ, 'output')
    data = bytearray()
    try:
        while True:
            timeout = deadline - time.monotonic()
            if timeout <= 0: return 71
            events = sel.select(timeout)
            if not events: return 71
            for key, _ in events:
                if key.data == 'client':
                    if not os.read(key.fd, 1): return 72
                else:
                    chunk = os.read(key.fd, min(65536, MAX_TEXT + 1 - len(data)))
                    if not chunk:
                        try: code = process.wait(timeout=max(0, deadline-time.monotonic()))
                        except subprocess.TimeoutExpired: return 71
                        if code: return 73
                        os.write(1, data)
                        return 0
                    data.extend(chunk)
                    if len(data) > MAX_TEXT: return 74
    finally:
        sel.close()
        process.stdout.close()
        process.kill() if process.poll() is None else None
        # systemd kills the entire remaining cgroup when this main process exits.

if __name__ == '__main__':
    try: sys.exit(main())
    except Exception: sys.exit(70)
