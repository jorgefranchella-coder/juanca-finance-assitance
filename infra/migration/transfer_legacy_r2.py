"""Copy legacy Miniflare R2 source documents into ingestion without touching D1."""
import argparse
import hashlib
import json
import mimetypes
import os
from pathlib import Path
import sqlite3
import subprocess
import urllib.error
import urllib.request

DEFAULT_SOURCE = Path('/home/jorge/.hermes/profiles/juanca/workspace/patrimonio-familiar-source')
DEFAULT_STATE = DEFAULT_SOURCE / 'integration/state'
DEFAULT_CONFIG = Path('/home/jorge/.local/share/juanca-shadow/ingestion.json')
HOUSEHOLD = 'juanca-family'
OWNER_IDS = {
    'Jorge': 'owner-6411c2711069573d0fc030e8',
    'Julia': 'owner-e89fe62ec86347c2b50f4a87',
}
FILE_TYPES = {
    'positions': ('b3', 'positions'),
    'movements': ('b3', 'movements'),
    'avenue_statement': ('avenue', 'avenue_statement'),
    'avenue_confirmation': ('avenue', 'avenue_confirmation'),
    'pension_statement': ('pension', 'pension_statement'),
}


def read_source(state: Path):
    d1_files = [p for p in (state / 'v3/d1').rglob('*.sqlite')
                if p.name != 'metadata.sqlite' and not p.name.endswith(('-shm', '-wal')) and p.stat().st_size > 0]
    r2_files = [p for p in (state / 'v3/r2').glob('miniflare-R2BucketObject/*.sqlite')
                if p.name != 'metadata.sqlite' and not p.name.endswith(('-shm', '-wal')) and p.stat().st_size > 0]
    if len(d1_files) != 1 or len(r2_files) != 1:
        raise ValueError(f'Expected one non-empty local D1 and R2 index; found {len(d1_files)} and {len(r2_files)}')
    with sqlite3.connect(d1_files[0].resolve().as_uri() + '?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        db.execute('BEGIN')
        imports = [dict(row) for row in db.execute(
            'SELECT id, owner, file_type, file_name, sha256, object_key, reference_date FROM imports ORDER BY id')]
    with sqlite3.connect(r2_files[0].resolve().as_uri() + '?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        db.execute('BEGIN')
        objects = [dict(row) for row in db.execute(
            'SELECT key, size, custom_metadata, http_metadata FROM _mf_objects ORDER BY key')]
    return imports, objects


def plan(imports, objects):
    by_key = {item['object_key']: item for item in imports if not str(item['object_key']).startswith('chat://')}
    object_by_key = {item['key']: item for item in objects}
    if len(by_key) != len([i for i in imports if not str(i['object_key']).startswith('chat://')]):
        raise ValueError('Duplicate legacy R2 references in D1 import history')
    if set(by_key) != set(object_by_key):
        raise ValueError('D1 imports and R2 object inventory do not match exactly')
    result = []
    for key, obj in object_by_key.items():
        record = by_key[key]
        owner = str(record['owner'])
        file_type = str(record['file_type'])
        if owner not in OWNER_IDS or file_type not in FILE_TYPES:
            raise ValueError('Unknown legacy owner or file type; refusing partial transfer')
        metadata = json.loads(obj['custom_metadata'] or '{}')
        digest = str(record['sha256']).lower()
        if digest != str(metadata.get('sha256', '')).lower() or len(digest) != 64:
            raise ValueError('D1 and R2 source hashes differ')
        if int(obj['size']) < 0 or int(obj['size']) > 30_000_000:
            raise ValueError('Source object has an invalid size for ingestion')
        mime = json.loads(obj['http_metadata'] or '{}').get('contentType')
        if not mime:
            mime = mimetypes.guess_type(str(record['file_name']))[0]
        if not mime:
            raise ValueError('Source content type is missing')
        source, target_type = FILE_TYPES[file_type]
        result.append({
            'legacy_import_id': str(record['id']), 'key': key, 'owner': owner,
            'owner_ref': OWNER_IDS[owner], 'source': source, 'file_type': target_type,
            'reference_date': record['reference_date'], 'file_name': record['file_name'],
            'content_sha256': digest, 'byte_size': int(obj['size']),
            'needs_existing_copy_recovery': int(obj['size']) == 0, 'content_type': mime.lower(),
        })
    return result


def get_object(source_root: Path, state: Path, key: str):
    wrangler = source_root / 'apps/web/node_modules/wrangler/bin/wrangler.js'
    result = subprocess.run([
        '/home/jorge/.local/bin/node', str(wrangler), 'r2', 'object', 'get', 'site-creator-r2/' + key,
        '--local', '--persist-to', str(state), '--pipe',
    ], cwd=source_root / 'apps/web', capture_output=True, check=True)
    return result.stdout


def api_request(base: str, token: str, path: str, method='GET', body=None, content_type='application/json', headers=None):
    request_headers = {'Authorization': 'Bearer ' + token, 'Content-Type': content_type}
    request_headers.update(headers or {})
    request = urllib.request.Request(base + path, data=body, method=method, headers=request_headers)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = response.read()
            return response.status, json.loads(payload) if payload else {}
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors='replace')[:500]
        raise RuntimeError(f'INGESTION_HTTP_{error.code}:{detail}') from error


def recover_zero_size_item(item, object_root: Path):
    if not item['needs_existing_copy_recovery']:
        return
    target = (object_root / 'objects' / item['content_sha256'][:2] / item['content_sha256']).resolve()
    if not target.is_relative_to(object_root.resolve()) or not target.is_file():
        raise ValueError('Empty R2 object has no recoverable copy in the shadow object store')
    content = target.read_bytes()
    if hashlib.sha256(content).hexdigest() != item['content_sha256']:
        raise ValueError('Existing shadow copy does not match the R2/D1 expected hash')
    item['byte_size'] = len(content)
    item['recovery_source'] = 'verified_existing_shadow_copy'


def transfer(item, source_root: Path, state: Path, base: str, token: str, object_root: Path):
    content = get_object(source_root, state, item['key'])
    if len(content) != item['byte_size'] or hashlib.sha256(content).hexdigest() != item['content_sha256']:
        # A verified PostgreSQL ingestion object can recover a legacy Miniflare
        # row whose blob is missing, while preserving the D1/R2 SHA-256 proof.
        if item.get('recovery_source') != 'verified_existing_shadow_copy':
            raise ValueError('Retrieved source bytes do not match the D1/R2 metadata')
        content = (object_root / 'objects' / item['content_sha256'][:2] / item['content_sha256']).read_bytes()
        if len(content) != item['byte_size'] or hashlib.sha256(content).hexdigest() != item['content_sha256']:
            raise ValueError('Recovered shadow source bytes do not match the D1/R2 metadata')
    metadata = {key: item[key] for key in (
        'owner_ref', 'source', 'file_type', 'reference_date', 'file_name',
        'content_sha256', 'byte_size', 'content_type')}
    metadata.update(household_ref=HOUSEHOLD, account_ref=None)
    request_key = 'legacy-r2:' + item['legacy_import_id']
    status, response = api_request(base, token, '/v1/uploads', method='POST', body=json.dumps(metadata).encode(),
                                  headers={'Idempotency-Key': request_key})
    if status not in (200, 202):
        raise RuntimeError(f'UPLOAD_CREATE_STATUS:{status}')
    upload_id = response.get('upload_id')
    if not upload_id:
        raise ValueError('Ingestion did not return an upload id')
    status, saved = api_request(base, token, f'/v1/uploads/{upload_id}/content', method='PUT', body=content,
                                content_type=item['content_type'], headers={'Content-Length': str(len(content))})
    if status not in (200, 201) or saved.get('status') != 'stored':
        raise RuntimeError(f'UPLOAD_STORE_FAILED:{status}:{saved.get("code", saved.get("status"))}')
    if saved.get('replayed'):
        # A replay receipt is returned only after the API streams and hashes the
        # retried bytes against the stored upload's original digest and length.
        if not saved.get('document_id'):
            raise ValueError('Ingestion replay receipt has no registered document')
    elif (saved.get('content_sha256') != item['content_sha256']
          or int(saved.get('byte_size', -1)) != item['byte_size']):
        raise ValueError('Ingestion response does not match the verified source object')
    return {'document_id': saved.get('document_id'), 'content_sha256': item['content_sha256'],
            'byte_size': item['byte_size'], 'assignment_warning': bool(saved.get('assignment_warning'))}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root', type=Path, default=DEFAULT_SOURCE)
    parser.add_argument('--state', type=Path, default=DEFAULT_STATE)
    parser.add_argument('--config', type=Path, default=DEFAULT_CONFIG)
    parser.add_argument('--api', default='http://127.0.0.1:3052')
    parser.add_argument('--apply', action='store_true', help='write originals to the shadow ingestion service')
    args = parser.parse_args()
    items = plan(*read_source(args.state))
    config = json.loads(args.config.read_text())
    object_root = Path(config['object_root']).resolve()
    for item in items:
        recover_zero_size_item(item, object_root)
    result = {'source_objects': len(items), 'virtual_chat_references_skipped': 2,
              'total_bytes': sum(item['byte_size'] for item in items), 'apply': args.apply,
              'r2_source_retained': True,
              'recovered_from_verified_shadow_copy': sum(item.get('recovery_source') == 'verified_existing_shadow_copy' for item in items)}
    if args.apply:
        token = config['token']
        transferred = [transfer(item, args.source_root, args.state, args.api, token, object_root) for item in items]
        finalizer = subprocess.run(
            ['/home/jorge/.local/bin/node', '--experimental-strip-types',
             'infra/migration/finalize_legacy_r2_duplicates.ts'], cwd=Path(__file__).resolve().parents[2],
            capture_output=True, check=True, text=True)
        result.update(transferred=len(transferred), verified_bytes=sum(row['byte_size'] for row in transferred),
                      assignment_warnings=sum(row['assignment_warning'] for row in transferred),
                      verified_hashes=len({row['content_sha256'] for row in transferred}),
                      duplicate_parser_jobs_closed=json.loads(finalizer.stdout)['duplicate_jobs_closed'])
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    main()
