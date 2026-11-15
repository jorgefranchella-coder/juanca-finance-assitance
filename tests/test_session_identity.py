import importlib.util
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('identity', Path(__file__).resolve().parents[1] / 'tools/check_session_identity.py')
identity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(identity)

class IdentityTest(unittest.TestCase):
    def test_live_and_unlinked_wal(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / 'state.db'
            writer = sqlite3.connect(db)
            try:
                writer.execute('PRAGMA journal_mode=WAL')
                writer.execute('CREATE TABLE t (x)')
                writer.execute('INSERT INTO t VALUES (1)')
                writer.commit()
                identity.check(os.getpid(), db)
                # This is an isolated fixture, never a live application database.
                os.unlink(str(db) + '-wal')
                with self.assertRaisesRegex(RuntimeError, 'deleted SQLite descriptor'):
                    identity.check(os.getpid(), db)
            finally:
                writer.close()

    def test_identity_pass_does_not_establish_history_equivalence(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            db = root / 'state.db'
            conn = sqlite3.connect(db)
            conn.execute('CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT)')
            conn.execute('INSERT INTO messages VALUES (1, ?)', ('current',))
            conn.commit()
            divergent = root / 'divergent.db'
            other = sqlite3.connect(divergent)
            other.execute('CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT)')
            other.execute('INSERT INTO messages VALUES (1, ?)', ('different history',))
            other.commit()
            try:
                identity.check(os.getpid(), db)
                current_rows = conn.execute('SELECT * FROM messages').fetchall()
                other_rows = other.execute('SELECT * FROM messages').fetchall()
                self.assertNotEqual(current_rows, other_rows)
            finally:
                other.close()
                conn.close()

    def test_path_replacement_with_distinct_history_is_detected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            db = root / 'state.db'
            writer = sqlite3.connect(db)
            writer.execute('CREATE TABLE messages (body TEXT)')
            writer.execute('INSERT INTO messages VALUES (?)', ('open history',))
            writer.commit()
            replacement = root / 'replacement.db'
            other = sqlite3.connect(replacement)
            other.execute('CREATE TABLE messages (body TEXT)')
            other.execute('INSERT INTO messages VALUES (?)', ('different history',))
            other.commit()
            other.close()
            db.unlink()
            replacement.rename(db)
            try:
                with self.assertRaisesRegex(RuntimeError, '(deleted SQLite descriptor|diverges from path)'):
                    identity.check(os.getpid(), db)
            finally:
                writer.close()

    def test_symlink_database_argument_resolves_to_opened_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            db = root / 'state.db'
            conn = sqlite3.connect(db)
            conn.execute('CREATE TABLE t (x)')
            conn.commit()
            alias = root / 'alias.db'
            alias.symlink_to(db)
            try:
                identity.check(os.getpid(), alias)
            finally:
                conn.close()

    def test_missing_pid_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / 'state.db'
            sqlite3.connect(db).close()
            with self.assertRaises(OSError):
                identity.check(999999999, db)
