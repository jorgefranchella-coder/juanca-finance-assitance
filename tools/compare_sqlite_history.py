#!/usr/bin/env python3
"""Compare SQLite schema and table contents through read-only snapshots.

Use only with isolated copies or during a coordinated maintenance window: an
online SQLite read can interact with WAL/SHM sidecars even when opened read-only.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sqlite3
import sys


def _scalar(value):
    if value is None:
        return ['null']
    if isinstance(value, bytes):
        return ['blob', value.hex()]
    if isinstance(value, int):
        return ['integer', str(value)]
    if isinstance(value, float):
        return ['real', value.hex()]
    if isinstance(value, str):
        return ['text', value]
    raise TypeError(f'unsupported SQLite value type: {type(value).__name__}')


def _feed(digest, value):
    encoded = json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    digest.update(len(encoded).to_bytes(8, 'big'))
    digest.update(encoded)


def fingerprint(database: Path) -> str:
    """Return a content fingerprint of a consistent read-only SQLite snapshot."""
    database = Path(database).resolve(strict=True)
    uri = database.as_uri() + '?mode=ro'
    digest = hashlib.sha256()
    with sqlite3.connect(uri, uri=True) as source:
        with sqlite3.connect(':memory:') as snapshot:
            source.backup(snapshot)
            schema = snapshot.execute(
                "SELECT type, name, tbl_name, sql FROM sqlite_schema "
                "WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name, tbl_name"
            ).fetchall()
            virtual_tables = [
                row[1] for row in schema
                if row[0] == 'table' and row[3] and row[3].lstrip().upper().startswith('CREATE VIRTUAL TABLE')
            ]
            if virtual_tables:
                raise ValueError('virtual tables require module-specific logical comparison: ' + ', '.join(virtual_tables))
            _feed(digest, ['schema', schema])
            table_modes = {
                row[1]: row[4]
                for row in snapshot.execute('PRAGMA table_list')
                if row[0] == 'main' and row[2] == 'table'
            }
            tables = [row[1] for row in schema if row[0] == 'table']
            for table in tables:
                quoted = '"' + table.replace('"', '""') + '"'
                columns = {
                    row[1].casefold()
                    for row in snapshot.execute(f'PRAGMA table_info({quoted})')
                }
                rowid_alias = None
                if not table_modes.get(table, 0):
                    rowid_alias = next((candidate for candidate in ('rowid', '_rowid_', 'oid') if candidate not in columns), None)
                    if rowid_alias is None:
                        raise ValueError(f'cannot read hidden rowid for table {table}')
                selection = (f'"{rowid_alias}", ' if rowid_alias else '') + '*'
                rows = [json.dumps([_scalar(v) for v in row], ensure_ascii=False, separators=(',', ':')) for row in snapshot.execute(f'SELECT {selection} FROM {quoted}')]
                rows.sort()
                _feed(digest, ['table', table, len(rows)])
                for row in rows:
                    raw = row.encode('utf-8')
                    digest.update(len(raw).to_bytes(8, 'big'))
                    digest.update(raw)
            if snapshot.execute("SELECT 1 FROM sqlite_schema WHERE name='sqlite_sequence'").fetchone():
                sequence = snapshot.execute('SELECT name, seq FROM sqlite_sequence ORDER BY name').fetchall()
                _feed(digest, ['sqlite_sequence', sequence])
    return digest.hexdigest()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('database_a', type=Path)
    parser.add_argument('database_b', type=Path)
    args = parser.parse_args(argv)
    try:
        a = fingerprint(args.database_a)
        b = fingerprint(args.database_b)
    except (OSError, sqlite3.Error, RuntimeError, TypeError, ValueError) as exc:
        print(f'comparison unavailable: {exc}', file=sys.stderr)
        return 2
    print(f'A {a}\nB {b}')
    if a != b:
        print('divergent SQLite histories')
        return 1
    print('SQLite logical contents match for supported tables')
    return 0


if __name__ == '__main__':
    sys.exit(main())
