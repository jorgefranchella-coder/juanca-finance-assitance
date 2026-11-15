"""Lock failure classification against an isolated patched Hermes runtime."""
import errno
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

RUNTIME = Path(os.environ.get("HERMES_RUNTIME", str(Path.home() / ".hermes")))
PYTHON = Path(os.environ.get('HERMES_PYTHON', sys.executable))


def run_child(code, home, *, args=(), stdin=None, env_extra=None):
    env = os.environ.copy()
    env['HERMES_HOME'] = str(home)
    if env_extra:
        env.update(env_extra)
    return subprocess.Popen(
        [str(PYTHON), '-c', code, *args], env=env, stdin=stdin,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )


def wait_for(path, proc, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if path.exists():
            return
        if proc.poll() is not None:
            out, err = proc.communicate()
            raise AssertionError(f'child exited before {path.name}: {proc.returncode}\n{out}\n{err}')
        time.sleep(0.02)
    proc.kill()
    out, err = proc.communicate()
    raise AssertionError(f'timed out waiting for {path.name}\n{out}\n{err}')


UNKNOWN_OWNER = r'''
from gateway.status import acquire_gateway_runtime_lock
assert acquire_gateway_runtime_lock()
print("LOCK_HELD", flush=True)
input()
'''

STARTUP = r'''
import asyncio
import builtins
import errno
import gateway.code_skew
import gateway.status
import os
from pathlib import Path
import sys, time

gateway.code_skew.record_boot_fingerprint = lambda: None
real_get_running_pid = gateway.status.get_running_pid
get_pid_checks = 0
def hide_initial_pid(*args, **kwargs):
    global get_pid_checks
    get_pid_checks += 1
    if get_pid_checks <= 2:
        return None
    return real_get_running_pid(*args, **kwargs)
gateway.status.get_running_pid = hide_initial_pid
mode = sys.argv[1]
if mode == "pause-after-lock":
    acquire = gateway.status.acquire_gateway_runtime_lock
    def acquire_then_pause():
        if not acquire():
            return False
        Path(sys.argv[2]).touch()
        while not Path(sys.argv[3]).exists():
            time.sleep(0.01)
        return True
    gateway.status.acquire_gateway_runtime_lock = acquire_then_pause
elif mode == "open-and-unlink-error":
    target = Path(os.environ['HERMES_HOME']) / 'gateway.lock'
    marker = Path(sys.argv[2])
    real_open = builtins.open
    def fail_open(path, *args, **kwargs):
        if Path(path) == target:
            raise PermissionError(errno.EACCES, 'injected open denial', str(path))
        return real_open(path, *args, **kwargs)
    Path.unlink_original = Path.unlink
    def fail_unlink(self, *args, **kwargs):
        if self == target:
            marker.touch()
            raise OSError(errno.EIO, 'injected unlink failure', str(self))
        return Path.unlink_original(self, *args, **kwargs)
    builtins.open = fail_open
    Path.unlink = fail_unlink
elif mode == "flock-io-error":
    original = gateway.status.fcntl.flock
    exclusive_attempts = 0
    def fail_first_exclusive(fd, operation):
        global exclusive_attempts
        if operation & gateway.status.fcntl.LOCK_EX:
            exclusive_attempts += 1
            if exclusive_attempts == 1:
                raise OSError(errno.EIO, 'injected flock I/O error')
        return original(fd, operation)
    gateway.status.fcntl.flock = fail_first_exclusive
from gateway.run import start_gateway
success = asyncio.run(start_gateway(verbosity=None))
sys.exit(0 if success else 1)
'''

CHECK_OWNER = r'''
from pathlib import Path
from gateway.status import get_running_pid
import sys
pid = get_running_pid(expected_home=Path(sys.argv[1]))
print(pid if pid is not None else "NONE", flush=True)
sys.exit(0 if pid is not None else 1)
'''

CHECK_PERMISSION = r'''
import builtins
import errno
from pathlib import Path
from gateway.status import get_running_pid
import os, sys
home = Path(sys.argv[1])
target = home / 'gateway.lock'
real_open = builtins.open
def fail_lock_open(path, *args, **kwargs):
    if Path(path) == target:
        raise PermissionError(errno.EACCES, 'injected lock permission error', str(path))
    return real_open(path, *args, **kwargs)
builtins.open = fail_lock_open
try:
    get_running_pid(expected_home=home)
except PermissionError:
    print('UNKNOWN_LOCK_STATE', flush=True)
    sys.exit(0)
sys.exit(1)
'''

WRITE_PID = r'''
from gateway.status import write_pid_file
write_pid_file()
'''


@unittest.skipUnless((RUNTIME / 'gateway/run.py').is_file(), 'Hermes runtime source unavailable')
class ProcessRaceTest(unittest.TestCase):
    def _start_verified_gateway_owner(self, tmp, home):
        fake_root = Path(tmp) / 'fake-runtime'
        package = fake_root / 'hermes_cli'
        package.mkdir(parents=True)
        (package / '__init__.py').write_text('')
        (package / 'main.py').write_text(
            'from gateway.status import acquire_gateway_runtime_lock\n'
            'assert acquire_gateway_runtime_lock()\n'
            'print("LOCK_HELD", flush=True)\n'
            'input()\n'
        )
        env = os.environ.copy()
        env['HERMES_HOME'] = str(home)
        env['PYTHONPATH'] = str(fake_root) + os.pathsep + env.get('PYTHONPATH', '')
        return subprocess.Popen(
            [str(PYTHON), '-m', 'hermes_cli.main', 'gateway', 'run'],
            env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True,
        )

    def _start_verified_gateway_pid_owner(self, tmp, home):
        fake_root = Path(tmp) / 'fake-pid-owner'
        package = fake_root / 'hermes_cli'
        package.mkdir(parents=True)
        (package / '__init__.py').write_text('')
        (package / 'main.py').write_text(
            'from gateway.status import write_pid_file\n'
            'write_pid_file()\n'
            'print("PID_READY", flush=True)\n'
            'input()\n'
        )
        env = os.environ.copy()
        env['HERMES_HOME'] = str(home)
        env['PYTHONPATH'] = str(fake_root) + os.pathsep + env.get('PYTHONPATH', '')
        return subprocess.Popen(
            [str(PYTHON), '-m', 'hermes_cli.main', 'gateway', 'run'],
            env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True,
        )

    def _start_bare_named_profile_gateway(self, tmp, home, selector_args=()):
        fake_root = Path(tmp) / 'fake-bare-profile'
        package = fake_root / 'hermes_cli'
        package.mkdir(parents=True)
        (package / '__init__.py').write_text('')
        (package / 'main.py').write_text(
            'from gateway.status import acquire_gateway_runtime_lock, write_pid_file\n'
            'assert acquire_gateway_runtime_lock()\n'
            'write_pid_file()\n'
            'print("OWNER_READY", flush=True)\n'
            'input()\n'
        )
        env = os.environ.copy()
        env['HERMES_HOME'] = str(home)
        env['PYTHONPATH'] = str(fake_root) + os.pathsep + env.get('PYTHONPATH', '')
        return subprocess.Popen(
            [str(PYTHON), '-m', 'hermes_cli.main', *selector_args, 'gateway', 'run'],
            env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True,
        )

    def test_bare_gateway_in_named_home_is_detected_without_deleting_live_pid_or_lock(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / 'profiles' / 'juanca'
            home.mkdir(parents=True)
            owner = self._start_bare_named_profile_gateway(tmp, home)
            try:
                self.assertEqual(owner.stdout.readline().strip(), 'OWNER_READY')
                pid_path = home / 'gateway.pid'
                lock_path = home / 'gateway.lock'
                original_pid = pid_path.read_bytes()
                original_lock = lock_path.read_bytes()
                original_lock_identity = (lock_path.stat().st_dev, lock_path.stat().st_ino)
                checker = run_child(CHECK_OWNER, home, args=(str(home),))
                out, err = checker.communicate(timeout=15)
                self.assertEqual(checker.returncode, 0, out + err)
                self.assertEqual(out.strip(), str(owner.pid))
                self.assertEqual(pid_path.read_bytes(), original_pid)
                self.assertEqual(lock_path.read_bytes(), original_lock)
                self.assertEqual((lock_path.stat().st_dev, lock_path.stat().st_ino), original_lock_identity)
            finally:
                if owner.poll() is None:
                    owner.stdin.write('\n')
                    owner.stdin.flush()
                    owner.communicate(timeout=10)

    def test_explicit_other_profile_selector_is_rejected_without_cleanup(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / 'profiles' / 'juanca'
            home.mkdir(parents=True)
            owner = self._start_bare_named_profile_gateway(tmp, home, selector_args=('--profile', 'other'))
            try:
                self.assertEqual(owner.stdout.readline().strip(), 'OWNER_READY')
                pid_path = home / 'gateway.pid'
                lock_path = home / 'gateway.lock'
                original_pid = pid_path.read_bytes()
                original_lock = lock_path.read_bytes()
                checker = run_child(CHECK_OWNER, home, args=(str(home),))
                out, err = checker.communicate(timeout=15)
                self.assertEqual(checker.returncode, 1, out + err)
                self.assertEqual(out.strip(), 'NONE')
                self.assertEqual(pid_path.read_bytes(), original_pid)
                self.assertEqual(lock_path.read_bytes(), original_lock)
            finally:
                if owner.poll() is None:
                    owner.stdin.write('\n')
                    owner.stdin.flush()
                    owner.communicate(timeout=10)

    def test_lock_permission_error_preserves_pid_and_lock_metadata(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / 'profiles' / 'juanca'
            home.mkdir(parents=True)
            owner = self._start_bare_named_profile_gateway(tmp, home)
            try:
                self.assertEqual(owner.stdout.readline().strip(), 'OWNER_READY')
                pid_path = home / 'gateway.pid'
                lock_path = home / 'gateway.lock'
                original_pid = pid_path.read_bytes()
                original_lock = lock_path.read_bytes()
                checker = run_child(CHECK_PERMISSION, home, args=(str(home),))
                out, err = checker.communicate(timeout=15)
                self.assertEqual(checker.returncode, 0, out + err)
                self.assertIn('UNKNOWN_LOCK_STATE', out)
                self.assertEqual(pid_path.read_bytes(), original_pid)
                self.assertEqual(lock_path.read_bytes(), original_lock)
            finally:
                if owner.poll() is None:
                    owner.stdin.write('\n')
                    owner.stdin.flush()
                    owner.communicate(timeout=10)

    def test_real_verified_gateway_lock_owner_gets_78_then_retry_can_acquire(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / 'home'
            home.mkdir()
            owner = self._start_verified_gateway_owner(tmp, home)
            try:
                self.assertEqual(owner.stdout.readline().strip(), 'LOCK_HELD')
                contender = run_child(STARTUP, home, args=('plain',))
                out, err = contender.communicate(timeout=45)
                self.assertEqual(contender.returncode, 78, out + err)
            finally:
                if owner.poll() is None:
                    owner.stdin.write('\n')
                    owner.stdin.flush()
                    owner.communicate(timeout=10)
            retry = subprocess.run(
                [str(PYTHON), '-c', 'from gateway.status import acquire_gateway_runtime_lock, release_gateway_runtime_lock; assert acquire_gateway_runtime_lock(); release_gateway_runtime_lock()'],
                env={**os.environ, 'HERMES_HOME': str(home)}, capture_output=True,
                text=True, timeout=15,
            )
            self.assertEqual(retry.returncode, 0, retry.stdout + retry.stderr)

    def test_unverified_process_holding_lock_is_retryable_not_permanent(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / 'home'
            home.mkdir()
            owner = run_child(UNKNOWN_OWNER, home, stdin=subprocess.PIPE)
            try:
                self.assertEqual(owner.stdout.readline().strip(), 'LOCK_HELD')
                contender = run_child(STARTUP, home, args=('plain',))
                out, err = contender.communicate(timeout=45)
                self.assertEqual(contender.returncode, 1, out + err)
                self.assertTrue((home / 'gateway.lock').exists())
            finally:
                if owner.poll() is None:
                    owner.stdin.write('\n')
                    owner.stdin.flush()
                    owner.communicate(timeout=10)
            retry = subprocess.run(
                [str(PYTHON), '-c', 'from gateway.status import acquire_gateway_runtime_lock, release_gateway_runtime_lock; assert acquire_gateway_runtime_lock(); release_gateway_runtime_lock()'],
                env={**os.environ, 'HERMES_HOME': str(home)}, capture_output=True,
                text=True, timeout=15,
            )
            self.assertEqual(retry.returncode, 0, retry.stdout + retry.stderr)

    def test_open_and_unlink_errors_are_retryable_and_lock_is_never_removed(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / 'home'
            home.mkdir()
            lock_path = home / 'gateway.lock'
            lock_path.write_text('preserve lock metadata', encoding='utf-8')
            marker = Path(tmp) / 'unlink-attempted'
            contender = run_child(STARTUP, home, args=('open-and-unlink-error', str(marker)))
            out, err = contender.communicate(timeout=45)
            self.assertEqual(contender.returncode, 1, out + err)
            self.assertFalse(marker.exists(), 'lock unlink must never be attempted')
            self.assertEqual(lock_path.read_text(encoding='utf-8'), 'preserve lock metadata')

    def test_flock_io_error_is_retryable_and_preserves_lock_record(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / 'home'
            home.mkdir()
            lock_path = home / 'gateway.lock'
            lock_path.write_text('preserve lock metadata', encoding='utf-8')
            contender = run_child(STARTUP, home, args=('flock-io-error',))
            out, err = contender.communicate(timeout=45)
            self.assertEqual(contender.returncode, 1, out + err)
            self.assertEqual(lock_path.read_text(encoding='utf-8'), 'preserve lock metadata')
            retry = subprocess.run(
                [str(PYTHON), '-c', 'from gateway.status import acquire_gateway_runtime_lock, release_gateway_runtime_lock; assert acquire_gateway_runtime_lock(); release_gateway_runtime_lock()'],
                env={**os.environ, 'HERMES_HOME': str(home)}, capture_output=True,
                text=True, timeout=15,
            )
            self.assertEqual(retry.returncode, 0, retry.stdout + retry.stderr)

    def test_real_pid_file_owner_race_is_permanent_and_releases_lock(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / 'home'
            home.mkdir()
            acquired = Path(tmp) / 'acquired'
            resume = Path(tmp) / 'resume'
            env = os.environ.copy()
            env['HERMES_HOME'] = str(home)
            startup = subprocess.Popen(
                [str(PYTHON), '-c', STARTUP, 'pause-after-lock', str(acquired), str(resume)],
                env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            )
            pid_owner = None
            try:
                wait_for(acquired, startup)
                pid_owner = self._start_verified_gateway_pid_owner(tmp, home)
                self.assertEqual(pid_owner.stdout.readline().strip(), 'PID_READY')
                resume.touch()
                out, err = startup.communicate(timeout=45)
                self.assertEqual(startup.returncode, 78, out + err)
                pid_owner.stdin.write('\n')
                pid_owner.stdin.flush()
                pid_owner.communicate(timeout=10)
                pid_owner = None
                retry = subprocess.run(
                    [str(PYTHON), '-c', 'from gateway.status import acquire_gateway_runtime_lock, release_gateway_runtime_lock, remove_pid_file; remove_pid_file(); assert acquire_gateway_runtime_lock(); release_gateway_runtime_lock()'],
                    env=env, capture_output=True, text=True, timeout=15,
                )
                self.assertEqual(retry.returncode, 0, retry.stdout + retry.stderr)
            finally:
                resume.touch()
                if startup.poll() is None:
                    startup.kill()
                    startup.communicate(timeout=10)
                if pid_owner is not None and pid_owner.poll() is None:
                    pid_owner.stdin.write('\n')
                    pid_owner.stdin.flush()
                    pid_owner.communicate(timeout=10)

    def test_systemd_prevents_only_verified_conflict_exit_78_and_preserves_profiles(self):
        for unit in ('hermes-gateway.service', 'hermes-gateway-juanca.service'):
            result = subprocess.run(
                ['systemctl', '--user', 'show', unit, '-p', 'ExecStart', '-p', 'Restart', '-p', 'RestartPreventExitStatus'],
                capture_output=True, text=True, timeout=10,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('Restart=always', result.stdout)
            self.assertIn('RestartPreventExitStatus=78', result.stdout)
        generic = subprocess.run(
            ['systemctl', '--user', 'show', 'hermes-gateway.service', '-p', 'ExecStart', '--value'],
            capture_output=True, text=True, timeout=10,
        )
        self.assertEqual(generic.returncode, 0, generic.stderr)
        self.assertIn('hermes_cli.main gateway run', generic.stdout)
        self.assertNotIn('--profile', generic.stdout)


if __name__ == '__main__':
    unittest.main()
