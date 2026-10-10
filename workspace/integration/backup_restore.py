"""Private coherent local backup; restoration is always to a new isolated directory."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
from datetime import datetime, timezone

SERVICES = ('patrimonio-juanca-web', 'patrimonio-juanca-worker')


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def check_databases(root):
    counts = {}
    for path in sorted(root.rglob('*')):
        if path.suffix not in ('.db', '.sqlite', '.sqlite3') or not path.is_file():
            continue
        with sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True) as db:
            if db.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                raise ValueError('SQLite integrity check failed')
            if db.execute('PRAGMA foreign_key_check').fetchall():
                raise ValueError('SQLite foreign key check failed')
            names = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if 'imports' in names:
                for name in ('imports', 'import_records', 'review_decisions', 'cost_basis',
                             'market_quotes', 'chat_messages', 'transaction_proposals'):
                    counts[name] = db.execute('SELECT COUNT(*) FROM ' + name).fetchone()[0]
    return counts


def verify(backup):
    manifest = json.loads((backup / 'manifest.json').read_text())
    for name, expected in manifest['files'].items():
        path = backup / name
        if path.resolve().is_relative_to(backup.resolve()) is False or digest(path) != expected:
            raise ValueError('Backup manifest mismatch')
    counts = check_databases(backup / 'state')
    if counts != manifest['table_counts']:
        raise ValueError('Backup row counts differ')
    return manifest


def create(source, destination, profile):
    if destination.exists() or destination.resolve().is_relative_to(source.resolve()):
        raise ValueError('Use a new destination outside the application')
    destination.mkdir(parents=True, mode=0o700)
    active = [s for s in SERVICES if subprocess.run(
        ['systemctl', '--user', 'is-active', '--quiet', s]).returncode == 0]
    try:
        if active:
            subprocess.run(['systemctl', '--user', 'stop', *active], check=True)
        shutil.copytree(source / 'integration/state', destination / 'state')
        shutil.copytree(source, destination / 'source', ignore=shutil.ignore_patterns(
            'node_modules', '.next', '.wrangler', '__pycache__', 'state', 'state-before-*',
            'credentials.json', 'access.txt', 'logs', '.git'))
        private = destination / 'private'
        private.mkdir(mode=0o700)
        shutil.copy2(source / 'integration/credentials.json', private / 'credentials.json')
        for name in ('config.yaml', 'profile.yaml'):
            if (profile / name).exists():
                shutil.copy2(profile / name, private / name)
        if (profile / 'state.db').exists():
            with sqlite3.connect((profile / 'state.db').resolve().as_uri() + '?mode=ro', uri=True) as src:
                with sqlite3.connect(private / 'hermes-state.db') as target:
                    src.backup(target)
        counts = check_databases(destination / 'state')
        manifest = {'format': 1, 'created_at': datetime.now(timezone.utc).isoformat(),
                    'source': str(source.resolve()), 'table_counts': counts,
                    'hermes_snapshot': 'Independent SQLite snapshot; no cross-channel atomicity claimed',
                    'files': {str(p.relative_to(destination)): digest(p)
                              for p in sorted(destination.rglob('*')) if p.is_file()}}
        (destination / 'manifest.json').write_text(json.dumps(manifest, indent=2))
        verify(destination)
    finally:
        if active:
            subprocess.run(['systemctl', '--user', 'start', *active], check=True)
    return manifest


def restore(backup, destination):
    verify(backup)
    if destination.exists():
        raise ValueError('Restoration requires a new directory; never overwrite live data')
    destination.mkdir(parents=True, mode=0o700)
    shutil.copytree(backup / 'state', destination / 'state')
    shutil.copytree(backup / 'source', destination / 'source')
    check_databases(destination / 'state')
    return {'restored': True, 'credentials_copied': False, 'services_started': False}


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('create', 'verify', 'restore'))
    parser.add_argument('--source', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--profile', type=Path)
    parser.add_argument('--backup', type=Path, required=True)
    parser.add_argument('--destination', type=Path)
    args = parser.parse_args()
    if args.action == 'create':
        if not args.profile:
            parser.error('--profile is required')
        create(args.source, args.backup, args.profile)
    elif args.action == 'verify':
        verify(args.backup)
    else:
        if not args.destination:
            parser.error('--destination is required')
        restore(args.backup, args.destination)
    print(json.dumps({'action': args.action, 'ok': True, 'backup': str(args.backup)}))


if __name__ == '__main__':
    main()
