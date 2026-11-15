import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('session_backup', Path(__file__).resolve().parents[1] / 'tools/session_backup.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class BackupTest(unittest.TestCase):
    def test_live_wal_snapshot_and_recovery(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            live = root / 'live'
            live.mkdir()
            db = live / 'state.db'
            writer = sqlite3.connect(db)
            writer.execute('PRAGMA journal_mode=WAL')
            writer.execute('CREATE TABLE messages (id INTEGER PRIMARY KEY, result TEXT)')
            writer.execute('INSERT INTO messages VALUES (1, ?)', ('tool result',))
            writer.commit()
            reader = sqlite3.connect(db)
            target = root / 'backup.db'
            module.backup(db, target)
            writer.execute('INSERT INTO messages VALUES (2, ?)', ('later',))
            writer.commit()
            self.assertEqual(reader.execute('SELECT count(*) FROM messages').fetchone()[0], 2)
            writer.close()
            reader.close()
            with sqlite3.connect(target) as recovered:
                self.assertEqual(recovered.execute('SELECT * FROM messages').fetchall(), [(1, 'tool result')])
            with sqlite3.connect(db) as reopened:
                self.assertEqual(reopened.execute('SELECT count(*) FROM messages').fetchone()[0], 2)
            with self.assertRaises(FileExistsError):
                module.backup(db, target)
            with self.assertRaises(ValueError):
                module.backup(db, live / 'copy.db')
            nested = live / 'nested'
            nested.mkdir()
            with self.assertRaisesRegex(ValueError, 'outside the live database directory tree'):
                module.backup(db, nested / 'copy.db')
            alias = root / 'nested-alias'
            alias.symlink_to(nested, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, 'outside the live database directory tree'):
                module.backup(db, alias / 'copy.db')
            self.assertFalse((nested / 'copy.db').exists())

if __name__ == '__main__':
    unittest.main()
