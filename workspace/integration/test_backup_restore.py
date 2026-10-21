"""Exercise backup verification and isolated restore with synthetic SQLite data."""
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location('backup_restore', ROOT / 'integration/backup_restore.py')
backup_restore = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(backup_restore)


class BackupRestoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / 'source'
        self.profile = self.root / 'profile'
        self.backup = self.root / 'backup'
        self.source.mkdir()
        self.profile.mkdir()
        state = self.source / 'integration/state'
        state.mkdir(parents=True)
        (self.source / 'integration/credentials.json').write_text(json.dumps({'token': 'synthetic'}))
        (self.source / 'app.py').write_text('fixture')
        with sqlite3.connect(state / 'portfolio.db') as db:
            for table in ('imports', 'import_records', 'review_decisions', 'cost_basis',
                          'market_quotes', 'chat_messages', 'transaction_proposals'):
                db.execute(f'CREATE TABLE {table} (id TEXT PRIMARY KEY)')
            db.execute("INSERT INTO imports VALUES ('fixture-import')")
        with sqlite3.connect(self.profile / 'state.db') as db:
            db.execute('CREATE TABLE session_fixture (value TEXT)')
            db.execute("INSERT INTO session_fixture VALUES ('synthetic')")

    def tearDown(self):
        self.temp.cleanup()

    def test_create_verify_and_restore_to_new_directory(self):
        with patch.object(backup_restore, 'SERVICES', ()):
            manifest = backup_restore.create(self.source, self.backup, self.profile)
        self.assertEqual(manifest['table_counts']['imports'], 1)
        self.assertEqual(backup_restore.verify(self.backup), manifest)
        restored = self.root / 'restored'
        result = backup_restore.restore(self.backup, restored)
        self.assertEqual(result, {'restored': True, 'credentials_copied': False,
                                  'hermes_state_copied': True, 'services_started': False})
        self.assertTrue((restored / 'state/portfolio.db').is_file())
        self.assertTrue((restored / 'source/app.py').is_file())
        self.assertTrue((restored / 'private/hermes-state.db').is_file())
        self.assertEqual((restored / 'private/hermes-state.db').stat().st_mode & 0o777, 0o600)
        self.assertFalse((restored / 'private/credentials.json').exists())

    def test_verify_checks_hermes_sqlite_integrity(self):
        with patch.object(backup_restore, 'SERVICES', ()):
            backup_restore.create(self.source, self.backup, self.profile)
        hermes = self.backup / 'private/hermes-state.db'
        hermes.write_bytes(b'broken sqlite')
        manifest = json.loads((self.backup / 'manifest.json').read_text())
        manifest['files']['private/hermes-state.db'] = backup_restore.digest(hermes)
        (self.backup / 'manifest.json').write_text(json.dumps(manifest))
        with self.assertRaises(sqlite3.DatabaseError):
            backup_restore.verify(self.backup)

    def test_verify_rejects_modified_backup_file(self):
        with patch.object(backup_restore, 'SERVICES', ()):
            backup_restore.create(self.source, self.backup, self.profile)
        (self.backup / 'state/portfolio.db').write_bytes(b'corrupted')
        with self.assertRaisesRegex(ValueError, 'manifest mismatch'):
            backup_restore.verify(self.backup)

    def test_verify_rejects_unlisted_file(self):
        with patch.object(backup_restore, 'SERVICES', ()):
            backup_restore.create(self.source, self.backup, self.profile)
        (self.backup / 'state/untracked.db').write_bytes(b'extra')
        with self.assertRaisesRegex(ValueError, 'file set differs'):
            backup_restore.verify(self.backup)

    def test_verify_rejects_manifest_path_traversal(self):
        with patch.object(backup_restore, 'SERVICES', ()):
            backup_restore.create(self.source, self.backup, self.profile)
        manifest = json.loads((self.backup / 'manifest.json').read_text())
        manifest['files']['../../outside'] = '0' * 64
        (self.backup / 'manifest.json').write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, 'manifest path'):
            backup_restore.verify(self.backup)

    def test_verify_rejects_symlinked_manifest_file(self):
        with patch.object(backup_restore, 'SERVICES', ()):
            backup_restore.create(self.source, self.backup, self.profile)
        source = self.backup / 'source/app.py'
        source.unlink()
        source.symlink_to(self.backup / 'state/portfolio.db')
        manifest = json.loads((self.backup / 'manifest.json').read_text())
        manifest['files']['source/app.py'] = backup_restore.digest(self.backup / 'state/portfolio.db')
        (self.backup / 'manifest.json').write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, 'manifest mismatch'):
            backup_restore.verify(self.backup)

    def test_restore_refuses_existing_destination(self):
        with patch.object(backup_restore, 'SERVICES', ()):
            backup_restore.create(self.source, self.backup, self.profile)
        existing = self.root / 'existing'
        existing.mkdir()
        with self.assertRaisesRegex(ValueError, 'new directory'):
            backup_restore.restore(self.backup, existing)

    def test_services_restart_after_backup_capture_failure_and_partial_copy_is_unmarked(self):
        calls = []

        def systemctl(args, check=False):
            calls.append((args, check))
            return type('Result', (), {'returncode': 0})()

        with patch.object(backup_restore, 'SERVICES', ('web', 'worker')), \
             patch.object(backup_restore.subprocess, 'run', side_effect=systemctl), \
             patch.object(backup_restore.shutil, 'copytree', side_effect=OSError('synthetic copy failure')):
            with self.assertRaisesRegex(OSError, 'synthetic copy failure'):
                backup_restore.create(self.source, self.backup, self.profile)

        self.assertIn((['systemctl', '--user', 'start', 'web', 'worker'], True), calls)
        self.assertTrue(self.backup.is_dir())
        self.assertFalse((self.backup / 'manifest.json').exists())


if __name__ == '__main__':
    unittest.main()
