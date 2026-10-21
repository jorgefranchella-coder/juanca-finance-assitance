import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {hashBackupFiles, verifyBackupManifest} from './manifest.ts';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'juanca-backup-'));
  await mkdir(join(root, 'evidence'));
  await writeFile(join(root, 'application.dump'), 'synthetic database');
  await writeFile(join(root, 'evidence', 'source.xlsx'), 'synthetic evidence');
  const manifest = {format: 5, files_sha256: await hashBackupFiles(root)};
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
  return root;
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

test('backup manifest verifies every file and exact file set', async () => {
  const root = await fixture();
  try {
    assert.deepEqual(await verifyBackupManifest(root), {files: 2});
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('backup manifest rejects modified and unexpected files', async () => {
  const root = await fixture();
  try {
    await writeFile(join(root, 'application.dump'), 'changed');
    await assert.rejects(verifyBackupManifest(root), /BACKUP_FILE_HASH_MISMATCH/);
    const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
    manifest.files_sha256['application.dump'] = hash('changed');
    await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
    await writeFile(join(root, 'unexpected.txt'), 'extra');
    await assert.rejects(verifyBackupManifest(root), /BACKUP_FILE_SET_MISMATCH/);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('backup manifest rejects traversal paths', async () => {
  const root = await fixture();
  try {
    const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
    manifest.files_sha256['../outside'] = hash('synthetic');
    await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
    await assert.rejects(verifyBackupManifest(root), /INVALID_BACKUP_MANIFEST_PATH/);
  } finally { await rm(root, {recursive: true, force: true}); }
});
