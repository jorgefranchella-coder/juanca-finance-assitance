"""Exercise the scheduled backup wrapper with synthetic paths only."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'integration'))
SPEC = importlib.util.spec_from_file_location('run_verified_backup', ROOT / 'integration/run_verified_backup.py')
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


class LocalAuthorityBackupTests(unittest.TestCase):
    def test_wrapper_uses_private_unique_destination_and_restore_check(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'source'
            profile = root / 'profile'
            backups = root / 'backups'
            source.mkdir()
            profile.mkdir()
            manifest = {'files': {'state/db.sqlite': 'a' * 64}, 'table_counts': {'imports': 1}}
            with patch.object(runner, 'ROOT', source), patch.object(runner, 'PROFILE', profile), \
                 patch.object(runner, 'BACKUPS', backups), \
                 patch.object(runner, 'create', return_value=manifest) as create, \
                 patch.object(runner, 'verify', return_value=manifest) as verify, \
                 patch.object(runner, 'restore') as restore:
                result = runner.run()
            destination = Path(result['destination'])
            self.assertEqual(result['files'], 1)
            self.assertEqual(result['sqlite_tables'], 1)
            self.assertEqual(destination.parent, backups)
            self.assertTrue(destination.name.startswith('juanca-authority-'))
            self.assertEqual(backups.stat().st_mode & 0o777, 0o700)
            create.assert_called_once_with(source, destination, profile)
            verify.assert_called_once_with(destination)
            self.assertEqual(restore.call_args.args[0], destination)
            self.assertTrue(restore.call_args.args[1].name == 'restored')


if __name__ == '__main__':
    unittest.main()
