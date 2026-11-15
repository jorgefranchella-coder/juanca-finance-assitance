#!/usr/bin/env python3
"""Detect SQLite file descriptors whose identity differs from their pathname."""
import argparse
import os
from pathlib import Path
import sys


def check(pid, database, proc=Path('/proc')):
    database = Path(database).resolve(strict=True)
    names = {str(database) + suffix for suffix in ('', '-wal', '-shm')}
    seen_main = False
    for fd in (proc / str(pid) / 'fd').iterdir():
        try:
            target = os.readlink(fd)
            deleted = target.endswith(' (deleted)')
            name = target[:-10] if deleted else target
            if name not in names:
                continue
            if deleted:
                raise RuntimeError(f'deleted SQLite descriptor: {name}')
            opened = fd.stat()
            try:
                current = os.stat(name)
            except FileNotFoundError:
                raise RuntimeError(f'SQLite path missing: {name}') from None
            if (opened.st_dev, opened.st_ino) != (current.st_dev, current.st_ino):
                raise RuntimeError(f'SQLite descriptor diverges from path: {name}')
            if name == str(database):
                seen_main = True
        except FileNotFoundError:
            # A descriptor may close during enumeration.
            continue
    if not seen_main:
        raise RuntimeError('gateway database descriptor not found')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('pid', type=int)
    parser.add_argument('database', type=Path)
    parser.add_argument('--proc-root', type=Path, default=Path(os.environ.get('JUANCA_PROC_ROOT', '/proc')))
    args = parser.parse_args()
    try:
        check(args.pid, args.database, proc=args.proc_root)
    except (OSError, RuntimeError) as exc:
        print(f'degraded: {exc}', file=sys.stderr)
        return 1
    print('SQLite descriptors match visible paths; logical history not verified')
    return 0


if __name__ == '__main__':
    sys.exit(main())
