"""Create and restore-test a private backup of Juanca's current D1 authority."""
import json
import os
from pathlib import Path
import tempfile
from os import replace
from datetime import datetime, timezone
from uuid import uuid4

from backup_restore import create, restore, verify

ROOT = Path(os.environ.get('JUANCA_SOURCE_ROOT', Path(__file__).resolve().parents[1]))
PROFILE = Path(os.environ.get('JUANCA_HERMES_PROFILE', Path.home() / '.hermes/profiles/juanca'))
BACKUPS = Path(os.environ.get('JUANCA_BACKUP_ROOT', Path.home() / '.local/share/juanca/backups/authority'))


def run():
    os.umask(0o077)
    BACKUPS.mkdir(parents=True, exist_ok=True, mode=0o700)
    BACKUPS.chmod(0o700)
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    destination = BACKUPS / f'juanca-authority-{stamp}-{uuid4().hex[:10]}'
    manifest = create(ROOT, destination, PROFILE)
    with tempfile.TemporaryDirectory(prefix='juanca-restore-check-') as temporary:
        restore(destination, Path(temporary) / 'restored')
    record_restore_success(destination)
    verified = verify(destination)
    return {
        'backup_verified': True,
        'files': len(manifest['files']),
        'sqlite_tables': len(verified['table_counts']),
        'destination': str(destination),
    }


def record_restore_success(destination):
    manifest_path = destination / 'manifest.json'
    manifest = json.loads(manifest_path.read_text())
    manifest['restoration_verified'] = True
    manifest['restore_verified_at'] = datetime.now(timezone.utc).isoformat()
    temporary = destination / '.manifest.json.tmp'
    temporary.write_text(json.dumps(manifest, indent=2))
    temporary.chmod(0o600)
    replace(temporary, manifest_path)


if __name__ == '__main__':
    print(json.dumps(run()))
