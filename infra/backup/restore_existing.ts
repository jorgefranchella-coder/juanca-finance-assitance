import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {pool} from '../../services/application/src/db.ts';
import {verifyBackupManifest} from './manifest.ts';

type Manifest = {
  format: number;
  restoration_verified: boolean;
  table_checks: Record<string, boolean>;
  ingestion_table_checks: Record<string, boolean>;
  market_table_checks: Record<string, boolean>;
  evidence_files: Record<string, string>;
  ingestion_objects: Record<string, string>;
  ingestion_sha256: string | null;
  market_sha256: string | null;
};

const backup = process.argv[2];
if (!backup) throw new Error('Usage: node --experimental-strip-types infra/backup/restore_existing.ts <backup-directory>');
const manifestCheck = await verifyBackupManifest(backup);
const manifest = JSON.parse(await readFile(join(backup, 'manifest.json'), 'utf8')) as Manifest;
if (manifest.format !== 5 || manifest.restoration_verified !== true) throw new Error('BACKUP_NOT_RESTORE_VERIFIED');
for (const checks of [manifest.table_checks, manifest.ingestion_table_checks, manifest.market_table_checks]) {
  if (!checks || Object.values(checks).some(value => value !== true)) throw new Error('BACKUP_SOURCE_RESTORE_CHECK_FAILED');
}
if (!Object.keys(manifest.table_checks).length) throw new Error('BACKUP_APPLICATION_SCHEMA_MISSING');

const runtime = process.env.JUANCA_RUNTIME_ROOT ?? '/home/jorge/.local/share/juanca-shadow';
const binary = join(runtime, 'runtime/root/usr/lib/postgresql/16/bin');
const socket = process.env.JUANCA_PG_SOCKET ?? join(runtime, 'socket');
const env = {
  ...process.env,
  LD_LIBRARY_PATH: join(runtime, 'runtime/root/usr/lib/x86_64-linux-gnu')
    + (process.env.LD_LIBRARY_PATH ? `:${process.env.LD_LIBRARY_PATH}` : ''),
};

function tool(command: string, args: string[]): string {
  const result = spawnSync(join(binary, command), args, {env, encoding: 'utf8'});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`POSTGRES_RESTORE_TOOL_FAILED:${command}:${result.stderr.trim()}`);
  return result.stdout;
}

function hash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function verifyBundledObjects(): Promise<number> {
  let checked = 0;
  for (const [filename, digest] of Object.entries(manifest.evidence_files ?? {})) {
    if (!/^[0-9a-f]{64}\.xlsx$/.test(filename) || digest !== filename.slice(0, -5)) {
      throw new Error('INVALID_B3_EVIDENCE_MANIFEST_ENTRY');
    }
    if (hash(await readFile(join(backup, 'evidence/b3', filename))) !== digest) throw new Error('B3_EVIDENCE_HASH_MISMATCH');
    checked++;
  }
  for (const [digest, expected] of Object.entries(manifest.ingestion_objects ?? {})) {
    if (!/^[0-9a-f]{64}$/.test(digest) || digest !== expected) throw new Error('INVALID_INGESTION_OBJECT_MANIFEST_ENTRY');
    const path = join(backup, 'ingestion-objects', digest.slice(0, 2), digest);
    if (hash(await readFile(path)) !== digest) throw new Error('INGESTION_OBJECT_HASH_MISMATCH');
    checked++;
  }
  return checked;
}

const evidenceObjects = await verifyBundledObjects();
for (const [filename, expected] of [['application.dump', undefined], ['ingestion.dump', manifest.ingestion_sha256], ['market.dump', manifest.market_sha256]] as const) {
  const present = await readFile(join(backup, filename)).then(() => true).catch(() => false);
  if (filename === 'application.dump' && !present) throw new Error('APPLICATION_DUMP_MISSING');
  if (filename !== 'application.dump' && Boolean(expected) !== present) throw new Error(`OPTIONAL_DUMP_PRESENCE_MISMATCH:${filename}`);
  if (expected && hash(await readFile(join(backup, filename))) !== expected) throw new Error(`DUMP_HASH_MISMATCH:${filename}`);
  if (present) tool('pg_restore', ['--list', join(backup, filename)]);
}

const admin = pool('jorge', 'postgres');
const database = `juanca_verify_${randomUUID().replaceAll('-', '')}`;
const restoredApp = pool('juanca_app', database);
const restoredIngestion = pool('juanca_ingestion', database);
const restoredMarket = pool('juanca_market', database);
let created = false;
try {
  await admin.query(`CREATE DATABASE "${database}"`);
  created = true;
  await admin.query(`GRANT CREATE ON DATABASE "${database}" TO juanca_app,juanca_ingestion,juanca_market`);
  tool('pg_restore', ['-h', socket, '-p', '55432', '-U', 'juanca_app', '-d', database,
    '--no-owner', '--no-acl', '--exit-on-error', join(backup, 'application.dump')]);
  if (manifest.ingestion_sha256) tool('pg_restore', ['-h', socket, '-p', '55432', '-U', 'juanca_ingestion', '-d', database,
    '--no-owner', '--no-acl', '--exit-on-error', join(backup, 'ingestion.dump')]);
  if (manifest.market_sha256) tool('pg_restore', ['-h', socket, '-p', '55432', '-U', 'juanca_market', '-d', database,
    '--no-owner', '--no-acl', '--exit-on-error', join(backup, 'market.dump')]);
  await admin.query(`REVOKE CREATE ON DATABASE "${database}" FROM juanca_app,juanca_ingestion,juanca_market`);

  async function checkSchema(db: ReturnType<typeof pool>, schema: string, expected: Record<string, boolean>) {
    const result = await db.query('SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename', [schema]);
    const actual = result.rows.map(row => String(row.tablename));
    const names = Object.keys(expected).sort();
    if (JSON.stringify(actual) !== JSON.stringify(names)) throw new Error(`RESTORED_TABLE_SET_MISMATCH:${schema}`);
    return actual.length;
  }

  const tables = {
    application: await checkSchema(restoredApp, 'app', manifest.table_checks),
    ingestion: manifest.ingestion_sha256 ? await checkSchema(restoredIngestion, 'ingestion', manifest.ingestion_table_checks) : 0,
    market: manifest.market_sha256 ? await checkSchema(restoredMarket, 'market', manifest.market_table_checks) : 0,
  };
  console.log(JSON.stringify({restore_verified: true, backup, manifest_files: manifestCheck.files,
    isolated_database: database, tables, evidence_objects_verified: evidenceObjects}));
} finally {
  await Promise.all([restoredApp.end(), restoredIngestion.end(), restoredMarket.end()]);
  if (created) await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
  await admin.end();
}
