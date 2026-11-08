#!/usr/bin/python3
"""Run a single HEIC decoder with no home access, filesystem writes or network."""
import ctypes
import errno
import os
import resource
import sys

libc = ctypes.CDLL(None, use_errno=True)
class Ruleset(ctypes.Structure):
    _fields_ = [('handled_access_fs', ctypes.c_uint64)]
class PathRule(ctypes.Structure):
    _fields_ = [('allowed_access', ctypes.c_uint64), ('parent_fd', ctypes.c_int)]

def syscall(number, *args):
    result = libc.syscall(number, *args)
    if result < 0:
        raise OSError(ctypes.get_errno(), os.strerror(ctypes.get_errno()))
    return result

def restrict(temp_dir=None):
    abi = syscall(444, 0, 0, 1)
    if abi < 3:
        raise RuntimeError('HEIC_SANDBOX_UNAVAILABLE')
    rules = Ruleset((1 << 15) - 1)
    ruleset = syscall(444, ctypes.byref(rules), ctypes.sizeof(rules), 0)
    try:
        for path in ('/usr', '/lib', '/lib64', '/etc/ImageMagick-6', '/etc/ld.so.cache', '/etc/fonts'):
            if not os.path.exists(path):
                continue
            fd = os.open(path, os.O_PATH | os.O_CLOEXEC)
            try:
                rights = (1 << 0) | (1 << 2) | ((1 << 3) if os.path.isdir(path) else 0)
                rule = PathRule(rights, fd)
                syscall(445, ruleset, 1, ctypes.byref(rule), 0)
            finally:
                os.close(fd)
        if temp_dir:
            stat = os.lstat(temp_dir)
            if not temp_dir.startswith('/tmp/juanca-heic-') or os.path.islink(temp_dir) or stat.st_uid != os.getuid() or stat.st_mode & 0o077:
                raise RuntimeError('HEIC_INVALID_TEMP_DIR')
            fd = os.open(temp_dir, os.O_PATH | os.O_CLOEXEC)
            try:
                rule = PathRule((1 << 15) - 1, fd)
                syscall(445, ruleset, 1, ctypes.byref(rule), 0)
            finally:
                os.close(fd)
        if libc.prctl(38, 1, 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), 'PR_SET_NO_NEW_PRIVS')
        syscall(446, ruleset, 0)
    finally:
        os.close(ruleset)
    sec = ctypes.CDLL('libseccomp.so.2', use_errno=True)
    sec.seccomp_init.argtypes = [ctypes.c_uint32]; sec.seccomp_init.restype = ctypes.c_void_p
    sec.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]; sec.seccomp_syscall_resolve_name.restype = ctypes.c_int
    sec.seccomp_rule_add.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint]
    sec.seccomp_load.argtypes = [ctypes.c_void_p]; sec.seccomp_release.argtypes = [ctypes.c_void_p]
    ctx = sec.seccomp_init(0x7fff0000)
    if not ctx:
        raise RuntimeError('HEIC_SANDBOX_UNAVAILABLE')
    try:
        for name in ('socket','socketpair','connect','bind','listen','accept','accept4','ptrace','process_vm_readv','process_vm_writev','pidfd_getfd','kill','tkill','tgkill','bpf','keyctl','add_key','request_key','unshare','setns','mount','umount2','open_by_handle_at','io_uring_setup','io_uring_enter','io_uring_register','process_madvise','pidfd_open'):
            nr = sec.seccomp_syscall_resolve_name(name.encode())
            if nr >= 0 and sec.seccomp_rule_add(ctx, 0x00050000 | errno.EPERM, nr, 0) != 0:
                raise RuntimeError('HEIC_SANDBOX_UNAVAILABLE')
        if sec.seccomp_load(ctx) != 0:
            raise RuntimeError('HEIC_SANDBOX_UNAVAILABLE')
    finally:
        sec.seccomp_release(ctx)
    resource.setrlimit(resource.RLIMIT_AS, (768 * 1024 * 1024,) * 2)
    resource.setrlimit(resource.RLIMIT_CPU, (30, 30))
    resource.setrlimit(resource.RLIMIT_FSIZE, (64 * 1024 * 1024,) * 2)

if __name__ == '__main__':
    try:
        temp_dir = sys.argv[1] if len(sys.argv) == 2 and sys.argv[1] != '--self-test' else None
        restrict(temp_dir)
        if len(sys.argv) == 2 and sys.argv[1] == '--self-test':
            import socket
            try:
                open('/home/jorge/.hermes/config.yaml').close()
                raise RuntimeError('HOME_NOT_RESTRICTED')
            except PermissionError:
                pass
            try:
                open('/tmp/juanca-heic-sandbox-write-check', 'w').close()
                raise RuntimeError('FILESYSTEM_NOT_RESTRICTED')
            except PermissionError:
                pass
            try:
                socket.socket()
                raise RuntimeError('NETWORK_NOT_RESTRICTED')
            except PermissionError:
                pass
            print('HEIC_SANDBOX_OK')
        elif temp_dir:
            os.execve('/usr/bin/convert-im6.q16', ['/usr/bin/convert-im6.q16','-limit','memory','192MiB','-limit','map','192MiB','-limit','disk','0','-limit','width','10000','-limit','height','10000','heic:-[0]','-auto-orient','-strip','png:-'], {'PATH':'/usr/bin:/bin','OMP_NUM_THREADS':'1','MAGICK_THREAD_LIMIT':'1','MAGICK_TMPDIR':temp_dir,'TMPDIR':temp_dir})
        else:
            raise RuntimeError('HEIC_SANDBOX_INVALID_ARGUMENT')
    except Exception as exc:
        print('HEIC_SANDBOX_ERROR: ' + str(exc), file=sys.stderr)
        sys.exit(1)
