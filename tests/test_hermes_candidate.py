"""Run against an isolated copy of the exact installed Hermes runtime."""
import asyncio
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

RUNTIME = Path(os.environ.get("HERMES_RUNTIME", str(Path.home() / ".hermes")))
PATCH = Path(__file__).resolve().parents[1] / 'deploy/hermes-owner-conflict.patch'


class CandidateTest(unittest.TestCase):
    @unittest.skipUnless((RUNTIME / 'gateway/run.py').is_file(), 'Hermes runtime source unavailable')
    def test_patch_applies_to_exact_runtime_copy_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            isolated = Path(tmp)
            (isolated / 'gateway').mkdir()
            shutil.copy2(RUNTIME / 'gateway/run.py', isolated / 'gateway/run.py')
            shutil.copy2(RUNTIME / 'gateway/status.py', isolated / 'gateway/status.py')
            (isolated / 'tests' / 'gateway').mkdir(parents=True)
            shutil.copy2(RUNTIME / 'tests/gateway/test_status.py', isolated / 'tests/gateway/test_status.py')
            subprocess.run(['git', 'apply', '--check', str(PATCH)], cwd=isolated, check=True)
            subprocess.run(['git', 'apply', str(PATCH)], cwd=isolated, check=True)
            patched = (isolated / 'gateway/run.py').read_text()
            self.assertEqual(patched.count('raise SystemExit(GATEWAY_FATAL_CONFIG_EXIT_CODE)'), 4)
            for marker in ('Another gateway instance is already running (PID %d', 'Another gateway instance (PID %d) started during our startup', 'Gateway runtime lock is held by verified Hermes gateway PID %d', 'PID file race exposed verified Hermes gateway PID %d'):
                pos = patched.index(marker)
                self.assertIn('raise SystemExit(GATEWAY_FATAL_CONFIG_EXIT_CODE)', patched[pos:pos + 2500])
            self.assertFalse((RUNTIME / 'gateway/run.py').read_text().count('raise SystemExit(GATEWAY_FATAL_CONFIG_EXIT_CODE)') > 0)

    def test_explicit_default_ignores_sticky_profile(self):
        from hermes_cli.main import _apply_profile_override
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            root = home / '.hermes'
            (root / 'profiles' / 'juanca').mkdir(parents=True)
            (root / 'active_profile').write_text('juanca')
            with patch.object(Path, 'home', return_value=home), patch.dict(os.environ, {'HERMES_HOME': str(root)}), patch.object(sys, 'argv', ['hermes', '--profile', 'default', 'gateway', 'run']):
                _apply_profile_override()
                self.assertEqual(Path(os.environ['HERMES_HOME']), root)

    def test_pid_that_appears_during_startup_is_permanent(self):
        import gateway.code_skew
        import gateway.status
        from gateway.run import start_gateway, GATEWAY_FATAL_CONFIG_EXIT_CODE
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {'HERMES_HOME': tmp}), patch.object(gateway.code_skew, 'record_boot_fingerprint'), patch.object(gateway.status, 'get_running_pid', side_effect=[None, os.getpid() + 100000]) as pid_check:
            with self.assertRaises(SystemExit) as exc:
                asyncio.run(start_gateway(verbosity=None))
            self.assertEqual(exc.exception.code, GATEWAY_FATAL_CONFIG_EXIT_CODE)
            self.assertEqual(pid_check.call_count, 2)

    def test_verified_runtime_lock_owner_is_permanent(self):
        import gateway.code_skew
        import gateway.status
        from gateway.run import start_gateway, GATEWAY_FATAL_CONFIG_EXIT_CODE
        owner_pid = os.getpid() + 100000
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {'HERMES_HOME': tmp}), patch.object(gateway.code_skew, 'record_boot_fingerprint'), patch.object(gateway.status, 'get_running_pid', side_effect=[None, None]), patch.object(gateway.status, 'acquire_gateway_runtime_lock', return_value=False) as lock_claim, patch.object(gateway.status, 'get_gateway_runtime_lock_owner_pid', return_value=owner_pid) as owner_check:
            with self.assertRaises(SystemExit) as exc:
                asyncio.run(start_gateway(verbosity=None))
            self.assertEqual(exc.exception.code, GATEWAY_FATAL_CONFIG_EXIT_CODE)
            lock_claim.assert_called_once_with()
            owner_check.assert_called_once_with()

    def test_pid_file_creation_race_without_verified_owner_is_retryable(self):
        import gateway.code_skew
        import gateway.status
        from gateway.run import start_gateway
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {'HERMES_HOME': tmp}), patch.object(gateway.code_skew, 'record_boot_fingerprint'), patch.object(gateway.status, 'get_running_pid', side_effect=[None, None, None]), patch.object(gateway.status, 'acquire_gateway_runtime_lock', return_value=True), patch.object(gateway.status, 'write_pid_file', side_effect=FileExistsError) as pid_write, patch.object(gateway.status, 'release_gateway_runtime_lock') as lock_release:
            self.assertFalse(asyncio.run(start_gateway(verbosity=None)))
            pid_write.assert_called_once_with()
            lock_release.assert_called_once_with()

    def test_lock_io_error_returns_retryable_startup_result(self):
        import gateway.code_skew
        import gateway.status
        from gateway.run import start_gateway
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {'HERMES_HOME': tmp}), patch.object(gateway.code_skew, 'record_boot_fingerprint'), patch.object(gateway.status, 'get_running_pid', side_effect=[None, None]), patch.object(gateway.status, 'acquire_gateway_runtime_lock', side_effect=PermissionError('denied')):
            with self.assertLogs('gateway.run', level='ERROR') as captured:
                self.assertFalse(asyncio.run(start_gateway(verbosity=None)))
            self.assertIn('Could not open or acquire the gateway runtime lock', captured.output[0])
            self.assertIn('PermissionError: denied', captured.output[0])

    def test_conflicting_owner_is_permanent(self):
        import gateway.code_skew
        import gateway.status
        from gateway.run import start_gateway, GATEWAY_FATAL_CONFIG_EXIT_CODE
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {'HERMES_HOME': tmp}), patch.object(gateway.code_skew, 'record_boot_fingerprint'), patch.object(gateway.status, 'get_running_pid', return_value=os.getpid() + 100000):
            with self.assertRaises(SystemExit) as exc:
                asyncio.run(start_gateway(verbosity=None))
            self.assertEqual(exc.exception.code, GATEWAY_FATAL_CONFIG_EXIT_CODE)
            self.assertEqual(exc.exception.code, 78)

if __name__ == '__main__':
    unittest.main()
