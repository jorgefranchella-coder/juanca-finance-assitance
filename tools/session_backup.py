#!/usr/bin/env python3
"""Create and verify a private SQLite online backup without replacing live files."""
import argparse
import os
from pathlib import Path
import sqlite3


def backup(source: Path, destination: Path):
    source = source.resolve(strict=True)
    destination = destination.absolute()
    source_parent = source.parent.resolve()
    destination_parent = destination.parent.resolve()
    if destination_parent == source_parent or source_parent in destination_parent.parents:
        raise ValueError('backup must be outside the live database directory tree')
    # Exclusive creation prevents accidental overwrite, including symlinks.
    fd = os.open(destination, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(fd)
    try:
        with sqlite3.connect(source.as_uri() + '?mode=ro', uri=True) as src:
            with sqlite3.connect(destination) as dst:
                src.backup(dst)
                if dst.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                    raise RuntimeError('backup integrity check failed')
                if dst.execute('PRAGMA foreign_key_check').fetchone() is not None:
                    raise RuntimeError('backup foreign key check failed')
    except BaseException:
        destination.unlink(missing_ok=True)
        raise


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    backup(args.source, args.destination)
    print('Backup verified; validate recovery on an isolated copy before any restart.')
