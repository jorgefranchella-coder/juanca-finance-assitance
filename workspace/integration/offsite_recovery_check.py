"""Retrieve, decrypt and validate offsite backups in isolated temporary paths."""
import argparse
import hashlib
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile
import tempfile

from backup_restore import restore, verify

KEY_DIR = Path(os.environ.get('JUANCA_OFFSITE_KEY_DIR', Path.home() / '.local/share/juanca/offsite-keys'))
REMOTE = os.environ.get('JUANCA_OFFSITE_REMOTE', 'pcloud:Backups/Juanca').rstrip('/')
REPO = Path(__file__).resolve().parents[2]


def safe_extract(ciphertext: Path, target: Path, homedir: Path):
    """Decrypt to a streaming tar reader and extract only regular files/directories."""
    process = subprocess.Popen(['gpg', '--homedir', str(homedir), '--batch', '--yes', '--decrypt', str(ciphertext)],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    seen = set()
    total = 0
    try:
        with tarfile.open(fileobj=process.stdout, mode='r|gz') as archive:
            for member in archive:
                path = PurePosixPath(member.name)
                if (path.is_absolute() or not path.parts or any(part in ('', '.', '..') for part in path.parts)
                        or '\\' in member.name or member.name in seen
                        or not (member.isdir() or member.isfile())):
                    raise ValueError('Unsafe or duplicate member in decrypted backup archive')
                seen.add(member.name)
                destination = target.joinpath(*path.parts)
                if member.isdir():
                    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
                    destination.chmod(0o700)
                    continue
                total += member.size
                if member.size < 0 or total > 20 * 1024**3:
                    raise ValueError('Decrypted archive exceeds the 20 GiB recovery limit')
                destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                if destination.exists():
                    raise ValueError('Archive file collides with an existing path')
                source = archive.extractfile(member)
                if source is None:
                    raise ValueError('Could not read archive member')
                with destination.open('xb') as output:
                    shutil.copyfileobj(source, output)
                destination.chmod(0o600)
        _, error = process.communicate()
        if process.returncode != 0:
            raise RuntimeError(f'GPG_DECRYPT_FAILED:{error.decode(errors="replace")[-500:]}')
        if not seen:
            raise ValueError('Decrypted archive is empty')
    except BaseException:
        process.kill()
        process.wait()
        raise


def retrieve_and_extract(name: str, category: str, work: Path):
    remote_path = f'{REMOTE}/{name}'
    ciphertext = work / f'{category}.tar.gz.gpg'
    with ciphertext.open('xb') as output:
        subprocess.run(['rclone', 'cat', remote_path], check=True, stdout=output)
    ciphertext.chmod(0o600)
    with ciphertext.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    extracted = work / category
    extracted.mkdir(mode=0o700)
    safe_extract(ciphertext, extracted, KEY_DIR / 'gnupg')
    roots = [path for path in extracted.iterdir() if path.is_dir()]
    if len(roots) != 1 or roots[0].name != category:
        raise ValueError(f'Unexpected archive root for {category}')
    backups = [path for path in roots[0].iterdir() if path.is_dir()]
    if len(backups) != 1:
        raise ValueError(f'Expected exactly one backup in {category} archive')
    return backups[0], {'category': category, 'remote_object': remote_path,
                        'ciphertext_sha256': digest, 'ciphertext_bytes': ciphertext.stat().st_size}


def latest_object(prefix: str, names: list[str]):
    matches = sorted(name for name in names if name.startswith(prefix) and name.endswith('.tar.gz.gpg'))
    if not matches:
        raise ValueError(f'No remote offsite artifact found for {prefix}')
    return matches[-1]


def run():
    names = subprocess.run(['rclone', 'lsf', REMOTE], check=True, capture_output=True, text=True).stdout.splitlines()
    authority_name = latest_object('juanca-authority-', names)
    postgres_name = latest_object('juanca-postgresql-shadow-', names)
    os.umask(0o077)
    with tempfile.TemporaryDirectory(prefix='juanca-offsite-recovery-', dir=Path.home() / '.local/share/juanca/backups') as temp:
        work = Path(temp)
        authority, authority_info = retrieve_and_extract(authority_name, 'authority', work)
        manifest = verify(authority)
        authority_restore = work / 'authority-restored'
        restore(authority, authority_restore)
        postgres, postgres_info = retrieve_and_extract(postgres_name, 'postgresql-shadow', work)
        subprocess.run(['node', '--experimental-strip-types', 'infra/backup/restore_existing.ts', str(postgres)],
                       cwd=REPO, check=True)
        return {'offsite_recovery_verified': True,
                'authority': {**authority_info, 'manifest_files': len(manifest['files']),
                              'sqlite_tables': len(manifest['table_counts']),
                              'isolated_restore': True, 'credentials_copied': False},
                'postgresql_shadow': {**postgres_info, 'isolated_restore': True}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    print(__import__('json').dumps(run(), sort_keys=True))


if __name__ == '__main__':
    main()
