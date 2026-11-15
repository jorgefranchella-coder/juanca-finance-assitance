import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('compare_sqlite_history', Path(__file__).resolve().parents[1] / 'tools/compare_sqlite_history.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CompareHistoryTest(unittest.TestCase):
    def _db(self, path, body):
        with sqlite3.connect(path) as connection:
            connection.execute('CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT, payload BLOB)')
            connection.execute('INSERT INTO messages VALUES (1, ?, ?)', (body, b'\x00data'))

    def test_equal_logical_content_matches_even_when_file_layout_differs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            a, b = root / 'a.db', root / 'b.db'
            self._db(a, 'same')
            self._db(b, 'same')
            self.assertEqual(module.fingerprint(a), module.fingerprint(b))

    def test_different_history_is_detected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            a, b = root / 'a.db', root / 'b.db'
            self._db(a, 'first history')
            self._db(b, 'different history')
            self.assertNotEqual(module.fingerprint(a), module.fingerprint(b))

    def test_rowid_difference_is_detected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            a, b = root / 'a.db', root / 'b.db'
            for path in (a, b):
                with sqlite3.connect(path) as connection:
                    connection.execute('CREATE TABLE records (body TEXT)')
            with sqlite3.connect(a) as connection:
                connection.execute('INSERT INTO records (body) VALUES (?)', ('same',))
            with sqlite3.connect(b) as connection:
                connection.execute('INSERT INTO records (body) VALUES (?)', ('discard',))
                connection.execute('INSERT INTO records (body) VALUES (?)', ('same',))
                connection.execute('DELETE FROM records WHERE body = ?', ('discard',))
            self.assertNotEqual(module.fingerprint(a), module.fingerprint(b))

    def test_virtual_tables_fail_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / 'fts.db'
            try:
                with sqlite3.connect(db) as connection:
                    connection.execute('CREATE VIRTUAL TABLE search USING fts5(body)')
            except sqlite3.OperationalError as exc:
                self.skipTest(f'FTS5 unavailable: {exc}')
            with self.assertRaisesRegex(ValueError, 'virtual tables require'):
                module.fingerprint(db)


if __name__ == '__main__':
    unittest.main()
