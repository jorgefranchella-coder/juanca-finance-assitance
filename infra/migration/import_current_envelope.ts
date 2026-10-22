import {readFile} from 'node:fs/promises';
import {pool} from '../../services/application/src/db.ts';
import {importEnvelope,type Envelope} from '../../services/application/src/migration.ts';

const path=process.argv[2];
if(!path)throw new Error('Usage: node --experimental-strip-types infra/migration/import_current_envelope.ts private-envelope.json');
const envelope=JSON.parse(await readFile(path,'utf8')) as Envelope;
if(envelope.content.format!==1||!envelope.content.tables.imports.length)throw new Error('INVALID_AUTHORITY_ENVELOPE');
const db=pool();
try{
  const result=await importEnvelope(db,path);
  const count=await db.query('SELECT source_counts FROM app.migration_runs WHERE id=$1',[result.run_id]);
  console.log(JSON.stringify({authority_evidence_imported:true,replayed:result.replayed,run_id:result.run_id,
    exported_at:envelope.exported_at,counts:count.rows[0]?.source_counts,
    published:false,portfolio_pointer_changed:false,commands_applied:0}));
}finally{await db.end();}
