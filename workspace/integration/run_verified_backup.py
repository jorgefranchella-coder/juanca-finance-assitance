"""Create and restore-test a private backup of Juanca's current D1 authority."""
import json
import os
from pathlib import Path
import tempfile
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
    verified = verify(destination)
    with tempfile.TemporaryDirectory(prefix='juanca-restore-check-') as temporary:
        restore(destination, Path(temporary) / 'restored')
    return {
        'backup_verified': True,
        'files': len(manifest['files']),
        'sqlite_tables': len(verified['table_counts']),
        'destination': str(destination),
    }


if __name__ == '__main__':
    print(json.dumps(run()))
