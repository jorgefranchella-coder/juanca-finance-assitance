import {resolve} from 'node:path';
import {verifyBackupManifest} from './manifest.ts';

const directory = process.argv[2];
if (!directory) throw new Error('Usage: npm run backup:verify -- <backup-directory>');
const result = await verifyBackupManifest(resolve(directory));
console.log(JSON.stringify({backup_manifest_verified: true, ...result}));
