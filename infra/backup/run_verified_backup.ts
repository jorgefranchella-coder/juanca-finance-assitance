import {spawnSync} from 'node:child_process';
import {chmod, mkdir, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';

const root = process.env.JUANCA_BACKUP_ROOT ?? '/home/jorge/.local/share/juanca/backups/postgres';
await mkdir(root, {recursive: true, mode: 0o700});
await chmod(root, 0o700);
const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const destination = join(root, `postgres-verified-${stamp}-${randomUUID()}`);
const script = fileURLToPath(new URL('./verify_restore.ts', import.meta.url));
try {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', script, destination], {
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`BACKUP_RESTORE_FAILED:${result.status ?? result.signal}`);
  console.log(JSON.stringify({scheduled_backup_completed: true, destination}));
} catch (error) {
  await rm(destination, {recursive: true, force: true});
  throw error;
}
