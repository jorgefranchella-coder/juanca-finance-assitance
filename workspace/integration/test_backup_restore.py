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
        self.assertEqual(result, {'restored': True, 'credentials_copied': False, 'services_started': False})
        self.assertTrue((restored / 'state/portfolio.db').is_file())
        self.assertTrue((restored / 'source/app.py').is_file())
        self.assertFalse((restored / 'private').exists())

    def test_verify_rejects_modified_backup_file(self):
        with patch.object(backup_restore, 'SERVICES', ()):
            backup_restore.create(self.source, self.backup, self.profile)
        (self.backup / 'state/portfolio.db').write_bytes(b'corrupted')
        with self.assertRaisesRegex(ValueError, 'manifest mismatch'):
            backup_restore.verify(self.backup)

    def test_restore_refuses_existing_destination(self):
        with patch.object(backup_restore, 'SERVICES', ()):
            backup_restore.create(self.source, self.backup, self.profile)
        existing = self.root / 'existing'
        existing.mkdir()
        with self.assertRaisesRegex(ValueError, 'new directory'):
            backup_restore.restore(self.backup, existing)


if __name__ == '__main__':
    unittest.main()
