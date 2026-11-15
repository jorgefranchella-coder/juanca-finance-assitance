"""Cancelable DNS worker: expires even if the caller is killed."""
import ctypes
import json
import os
import signal
import socket
import sys
import time


def main():
    host, port, deadline, parent = sys.argv[1], int(sys.argv[2]), float(sys.argv[3]), int(sys.argv[4])
    # PR_SET_PDEATHSIG is installed in the child, never through preexec_fn.
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0 or os.getppid() != parent:
        return 125
    delay = deadline - time.monotonic()
    if delay <= 0:
        return 124
    # Default SIGALRM terminates in the kernel even while libc is blocked.
    signal.signal(signal.SIGALRM, signal.SIG_DFL)
    signal.setitimer(signal.ITIMER_REAL, delay)
    answers = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    print(json.dumps([x[4][0] for x in answers]))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        sys.exit(1)
