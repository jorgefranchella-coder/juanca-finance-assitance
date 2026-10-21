import {createHash} from 'node:crypto';
import {lstat, readdir, readFile} from 'node:fs/promises';
import {join, relative, resolve, sep} from 'node:path';

export type BackupManifest = {
  format: number;
  files_sha256: Record<string, string>;
  [key: string]: unknown;
};

export async function hashBackupFiles(root: string): Promise<Record<string, string>> {
  const base = resolve(root);
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, {withFileTypes: true})) {
      const path = join(directory, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error('BACKUP_SYMLINK_NOT_ALLOWED');
      if (info.isDirectory()) await walk(path);
      else if (info.isFile() && relative(base, path) === 'manifest.json') continue;
      else if (info.isFile()) files.push(path);
      else throw new Error('BACKUP_SPECIAL_FILE_NOT_ALLOWED');
    }
  }
  await walk(base);
  const hashes: Record<string, string> = {};
  for (const path of files.sort()) {
    const name = relative(base, path).split(sep).join('/');
    hashes[name] = createHash('sha256').update(await readFile(path)).digest('hex');
  }
  return hashes;
}

export async function verifyBackupManifest(root: string): Promise<{files: number}> {
  const base = resolve(root);
  const manifest = JSON.parse(await readFile(join(base, 'manifest.json'), 'utf8')) as BackupManifest;
  if (manifest.format !== 5) throw new Error('UNSUPPORTED_BACKUP_MANIFEST_FORMAT');
  if (!manifest.files_sha256 || typeof manifest.files_sha256 !== 'object' || Array.isArray(manifest.files_sha256)) {
    throw new Error('BACKUP_FILE_HASHES_MISSING');
  }
  const expectedNames = Object.keys(manifest.files_sha256).sort();
  for (const name of expectedNames) {
    const path = resolve(base, name);
    if (path === base || !path.startsWith(base + sep) || name === 'manifest.json') throw new Error('INVALID_BACKUP_MANIFEST_PATH');
    const info = await lstat(path).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink()) throw new Error('BACKUP_FILE_MISSING_OR_INVALID');
    const actual = createHash('sha256').update(await readFile(path)).digest('hex');
    if (!/^[0-9a-f]{64}$/.test(manifest.files_sha256[name]) || actual !== manifest.files_sha256[name]) {
      throw new Error('BACKUP_FILE_HASH_MISMATCH');
    }
  }
  const actualNames = Object.keys(await hashBackupFiles(base)).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) throw new Error('BACKUP_FILE_SET_MISMATCH');
  return {files: actualNames.length};
}
