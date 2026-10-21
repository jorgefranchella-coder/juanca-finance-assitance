"""Check that the newest daily authority and shadow backups are fresh and valid."""
import json
import os
from datetime import datetime, timezone
from pathlib import Path
import subprocess
import sys

from backup_restore import verify as verify_authority

SHADOW_SOURCE = Path(os.environ.get('JUANCA_SHADOW_SOURCE_ROOT', '/home/jorge/juanca'))
AUTHORITY = Path(os.environ.get('JUANCA_AUTHORITY_BACKUP_ROOT', Path.home() / '.local/share/juanca/backups/authority'))
SHADOW = Path(os.environ.get('JUANCA_SHADOW_BACKUP_ROOT', Path.home() / '.local/share/juanca/backups/postgres'))
MAX_AGE_HOURS = float(os.environ.get('JUANCA_BACKUP_MAX_AGE_HOURS', '32'))


def verify_shadow(path):
    node = os.environ.get('JUANCA_NODE', '/home/jorge/.local/bin/node')
    script = SHADOW_SOURCE / 'infra/backup/verify_manifest.ts'
    subprocess.run([node, '--experimental-strip-types', str(script), str(path)],
                   check=True, capture_output=True, text=True)


def latest_check(root, prefix, verifier, now=None, max_age_hours=MAX_AGE_HOURS):
    now = now or datetime.now(timezone.utc)
    candidates = sorted((path for path in root.glob(prefix + '*') if path.is_dir()),
                        key=lambda path: path.name)
    if not candidates:
        raise ValueError(f'No backup found under {root}')
    latest = candidates[-1]
    manifest_path = latest / 'manifest.json'
    manifest = json.loads(manifest_path.read_text())
    if manifest.get('restoration_verified') is not True:
        raise ValueError(f'Backup has no successful restore check: {latest.name}')
    verifier(latest)
    created = datetime.fromisoformat(manifest['created_at'].replace('Z', '+00:00'))
    if created.tzinfo is None:
        raise ValueError(f'Backup timestamp has no timezone: {latest.name}')
    age_hours = (now - created.astimezone(timezone.utc)).total_seconds() / 3600
    if age_hours < -0.1:
        raise ValueError(f'Backup timestamp is in the future: {latest.name}')
    if age_hours > max_age_hours:
        raise ValueError(f'Latest backup is stale ({age_hours:.1f} hours): {latest.name}')
    return {'path': str(latest), 'created_at': created.isoformat(),
            'age_hours': round(max(0, age_hours), 2), 'verified': True}


def run(now=None):
    result = {
        'authority': latest_check(AUTHORITY, 'juanca-authority-', verify_authority, now),
        'shadow': latest_check(SHADOW, 'postgres-verified-', verify_shadow, now),
    }
    return {'backups_healthy': True, **result}


if __name__ == '__main__':
    try:
        print(json.dumps(run(), sort_keys=True))
    except Exception as error:
        print(json.dumps({'backups_healthy': False, 'error': str(error)}, sort_keys=True), file=sys.stderr)
        raise SystemExit(1)
