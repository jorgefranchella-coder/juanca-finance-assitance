"""Private coherent local backup; restoration is always to a new isolated directory."""
import argparse
import hashlib
import json
import os
from pathlib import Path
from pathlib import PurePosixPath
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
    backup = backup.resolve()
    manifest_path = backup / 'manifest.json'
    manifest = json.loads(manifest_path.read_text())
    if (not isinstance(manifest, dict) or manifest.get('format') != 1
            or not isinstance(manifest.get('files'), dict)
            or not isinstance(manifest.get('table_counts'), dict)):
        raise ValueError('Invalid backup manifest')

    expected_files = set()
    for name, expected in manifest['files'].items():
        relative = PurePosixPath(name) if isinstance(name, str) else None
        if (relative is None or relative.is_absolute() or not relative.parts
                or any(part in ('', '.', '..') for part in relative.parts)
                or '\\' in name or name == 'manifest.json'
                or not isinstance(expected, str) or len(expected) != 64):
            raise ValueError('Invalid backup manifest path or digest')
        path = backup.joinpath(*relative.parts)
        if path.is_symlink() or not path.is_file() or digest(path) != expected:
            raise ValueError('Backup manifest mismatch')
        expected_files.add(name)

    actual_files = {path.relative_to(backup).as_posix() for path in backup.rglob('*')
                    if path.is_file() or path.is_symlink()}
    actual_files.discard('manifest.json')
    if actual_files != expected_files:
        raise ValueError('Backup file set differs from manifest')

    for directory in (backup / 'state', backup / 'source'):
        if not directory.is_dir() or directory.is_symlink():
            raise ValueError('Backup is missing a required directory')
    counts = check_databases(backup / 'state')
    if (backup / 'private').exists():
        check_databases(backup / 'private')
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
    hermes_state = backup / 'private/hermes-state.db'
    if hermes_state.is_file():
        private = destination / 'private'
        private.mkdir(mode=0o700)
        shutil.copy2(hermes_state, private / 'hermes-state.db')
        (private / 'hermes-state.db').chmod(0o600)
        check_databases(private)
    return {'restored': True, 'credentials_copied': False,
            'hermes_state_copied': hermes_state.is_file(), 'services_started': False}


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
