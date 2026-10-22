"""Prepare client-side encrypted Juanca backups and optionally copy them to rclone."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import posixpath
import subprocess
import tarfile
import tempfile
from datetime import datetime, timezone

from backup_health import latest_check, verify_authority, verify_shadow

KEY_DIR = Path(os.environ.get('JUANCA_OFFSITE_KEY_DIR', Path.home() / '.local/share/juanca/offsite-keys'))
AUTHORITY = Path(os.environ.get('JUANCA_AUTHORITY_BACKUP_ROOT', Path.home() / '.local/share/juanca/backups/authority'))
SHADOW = Path(os.environ.get('JUANCA_SHADOW_BACKUP_ROOT', Path.home() / '.local/share/juanca/backups/postgres'))
OUTBOX = Path(os.environ.get('JUANCA_OFFSITE_OUTBOX', Path.home() / '.local/share/juanca/backups/offsite-outbox'))


def require_upload_authorized(upload, env=None):
    env = os.environ if env is None else env
    if not upload:
        return None
    if env.get('JUANCA_OFFSITE_KEY_RECOVERY_CONFIRMED') != '1':
        raise ValueError('Confirm the private recipient key is recoverable from a separate protected location before uploading')
    remote = env.get('JUANCA_OFFSITE_REMOTE', '')
    if ':' not in remote or not remote.split(':', 1)[0] or not remote.split(':', 1)[1].strip('/'):
        raise ValueError('Set JUANCA_OFFSITE_REMOTE to a configured remote and destination folder')
    return remote.rstrip('/')


def configured_remotes():
    result = subprocess.run(['rclone', 'listremotes'], check=True, capture_output=True, text=True)
    return {line.strip().removesuffix(':') for line in result.stdout.splitlines() if line.strip()}


def validate_remote(remote, remotes):
    name, separator, destination = remote.partition(':')
    if not separator or name not in remotes or not destination.strip('/'):
        raise ValueError('Offsite destination is not a configured rclone remote path')
    if '..' in Path(destination).parts:
        raise ValueError('Offsite destination cannot traverse parent folders')


def load_public_recipient(key_dir):
    public_key = key_dir / 'public.asc'
    fingerprint_path = key_dir / 'fingerprint.txt'
    fingerprint = fingerprint_path.read_text().strip().upper()
    if not public_key.is_file() or not fingerprint or any(c not in '0123456789ABCDEF' for c in fingerprint):
        raise ValueError('Dedicated public key or fingerprint is missing or invalid')
    return public_key, fingerprint


def encrypt_backup(source, category, key_dir=KEY_DIR, outbox=OUTBOX):
    public_key, fingerprint = load_public_recipient(key_dir)
    outbox.mkdir(parents=True, exist_ok=True, mode=0o700)
    outbox.chmod(0o700)
    destination = outbox / f'juanca-{category}-{source.name}.tar.gz.gpg'
    with tempfile.TemporaryDirectory(prefix='juanca-gpg-public-', dir=outbox) as gpg_home:
        Path(gpg_home).chmod(0o700)
        subprocess.run(['gpg', '--homedir', gpg_home, '--batch', '--import', str(public_key)],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        listed = subprocess.run(['gpg', '--homedir', gpg_home, '--batch', '--with-colons',
                                  '--fingerprint', '--list-keys', fingerprint],
                                check=True, capture_output=True, text=True)
        fingerprints = {row.split(':')[9].upper() for row in listed.stdout.splitlines()
                        if row.startswith('fpr:') and len(row.split(':')) > 9}
        if fingerprint not in fingerprints:
            raise ValueError('Public key fingerprint does not match the configured recipient')
        fd, encrypted_name = tempfile.mkstemp(prefix='.encrypted-', suffix='.tmp', dir=outbox)
        os.close(fd)
        encrypted_tmp = Path(encrypted_name)
        try:
            process = subprocess.Popen([
                'gpg', '--homedir', gpg_home, '--batch', '--yes', '--trust-model', 'always',
                '--recipient', fingerprint, '--encrypt', '--output', str(encrypted_tmp),
            ], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            try:
                with tarfile.open(fileobj=process.stdin, mode='w|gz') as archive:
                    archive.add(source, arcname=f'{category}/{source.name}', recursive=True)
            except Exception:
                process.kill()
                process.wait()
                raise
            _, stderr = process.communicate()
            status = process.wait()
            if status != 0:
                raise RuntimeError(f'GPG_ENCRYPTION_FAILED:{stderr.decode(errors="replace")[-500:]}')
            encrypted_tmp.chmod(0o600)
            os.replace(encrypted_tmp, destination)
            packets = subprocess.run(['gpg', '--homedir', gpg_home, '--batch', '--list-packets', str(destination)],
                                     capture_output=True, text=True)
            if not packets.stdout.strip() or ':pubkey enc packet:' not in packets.stdout:
                raise RuntimeError('GPG_OUTPUT_INVALID: ciphertext has no public-key encryption packet')
        finally:
            encrypted_tmp.unlink(missing_ok=True)
    with destination.open('rb') as ciphertext:
        digest = hashlib.file_digest(ciphertext, 'sha256').hexdigest()
    return {'category': category, 'source': str(source), 'encrypted_file': str(destination),
            'encrypted_sha256': digest, 'encrypted_bytes': destination.stat().st_size,
            'recipient_fingerprint': fingerprint}


def hash_stream(stream):
    digest = hashlib.sha256()
    size = 0
    while True:
        chunk = stream.read(1024 * 1024)
        if not chunk:
            break
        digest.update(chunk)
        size += len(chunk)
    return digest.hexdigest(), size


def upload_encrypted(artifact, remote, remotes=None):
    remotes = configured_remotes() if remotes is None else remotes
    validate_remote(remote, remotes)
    filename = Path(artifact['encrypted_file']).name
    destination = f'{remote.rstrip("/")}/{filename}'
    subprocess.run(['rclone', 'copyto', artifact['encrypted_file'], destination, '--checksum'], check=True)
    result = subprocess.Popen(['rclone', 'cat', destination], stdout=subprocess.PIPE)
    remote_hash, remote_bytes = hash_stream(result.stdout)
    status = result.wait()
    if status != 0:
        raise RuntimeError('Could not read back encrypted remote object')
    if remote_hash != artifact['encrypted_sha256'] or remote_bytes != artifact['encrypted_bytes']:
        raise ValueError('Encrypted remote object differs from local ciphertext')
    return {'remote_object': destination, 'encrypted_sha256': remote_hash,
            'encrypted_bytes': remote_bytes, 'verified': True}


def run(upload=False):
    remote = require_upload_authorized(upload)
    authority = latest_check(AUTHORITY, 'juanca-authority-', verify_authority)
    shadow = latest_check(SHADOW, 'postgres-verified-', verify_shadow)
    artifacts = [encrypt_backup(Path(authority['path']), 'authority'),
                 encrypt_backup(Path(shadow['path']), 'postgresql-shadow')]
    uploaded = []
    if upload:
        remotes = configured_remotes()
        validate_remote(remote, remotes)
        uploaded = [upload_encrypted(artifact, remote, remotes) for artifact in artifacts]
    return {'offsite_prepared': True, 'uploaded': upload,
            'prepared_at': datetime.now(timezone.utc).isoformat(),
            'artifacts': artifacts, 'remote_objects': uploaded}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--upload', action='store_true', help='upload encrypted objects after explicit offline-key confirmation')
    args = parser.parse_args()
    print(json.dumps(run(upload=args.upload), sort_keys=True))


if __name__ == '__main__':
    main()
