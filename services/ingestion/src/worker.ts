import {readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import type pg from 'pg';
import {pool} from './db.ts';
import {config} from './config.ts';
import {objectPath} from './object-store.ts';
import {parseB3,B3_PARSER_VERSION} from './b3-parser.ts';
import {parseAvenue,parseAvenueConfirmation,AVENUE_CONFIRMATION_PARSER_VERSION,AVENUE_PARSER_VERSION} from './avenue-parser.ts';

const once=process.argv.includes('--once');
const db=pool(),cfg=await config();let stopping=false;
async function claim(){const token=randomUUID();const result=await db.query(`WITH next AS (
 SELECT j.id FROM ingestion.import_jobs j JOIN ingestion.document_assignments a ON a.id=j.assignment_id
 WHERE ((a.source='b3' AND a.file_type IN ('positions','movements')) OR (a.source='avenue' AND a.file_type IN ('avenue_statement','avenue_confirmation')))
 AND (j.status IN ('queued','failed_retryable') AND j.available_at<=now() OR j.status='parsing' AND j.lease_until<now())
 ORDER BY j.created_at FOR UPDATE OF j SKIP LOCKED LIMIT 1
 ) UPDATE ingestion.import_jobs j SET status='parsing',lease_token=$1::uuid,lease_until=now()+interval '5 minutes',attempts=attempts+1,updated_at=now()
 FROM next WHERE j.id=next.id RETURNING j.id,j.document_id,j.assignment_id,j.attempts`,[token]);return result.rowCount?{...result.rows[0],token}:null;}
async function processJob(job:Record<string,unknown>){
 const input=await db.query(`SELECT d.content_sha256,d.byte_size,a.household_ref,a.owner_ref,a.source,a.file_type,a.reference_date FROM ingestion.documents d JOIN ingestion.document_assignments a ON a.document_id=d.id WHERE d.id=$1 AND a.id=$2`,[job.document_id,job.assignment_id]);if(!input.rowCount)throw new Error('IMPORT_SOURCE_MISSING');
 const doc=input.rows[0];const isB3=doc.source==='b3'&&['positions','movements'].includes(doc.file_type);const isAvenue=doc.source==='avenue'&&doc.file_type==='avenue_statement';const isAvenueConfirmation=doc.source==='avenue'&&doc.file_type==='avenue_confirmation';if(!isB3&&!isAvenue&&!isAvenueConfirmation)throw new Error('UNSUPPORTED_SOURCE_TYPE');
 const bytes=await readFile(objectPath(cfg.object_root,String(doc.content_sha256)));
 if(bytes.length!==Number(doc.byte_size)||createHash('sha256').update(bytes).digest('hex')!==doc.content_sha256)throw new Error('DOCUMENT_CONTENT_MISMATCH');
 const parsed=isB3?parseB3(bytes,doc.file_type,doc.reference_date?String(doc.reference_date).slice(0,10):null):isAvenue?await parseAvenue(bytes,String(doc.owner_ref)):await parseAvenueConfirmation(bytes,String(doc.owner_ref));
 if(doc.reference_date&&isAvenue&&parsed.summary.reference_date!==String(doc.reference_date).slice(0,10))throw new Error('DOCUMENT_REFERENCE_DATE_MISMATCH');
 const parserVersion=isB3?B3_PARSER_VERSION:isAvenueConfirmation?AVENUE_CONFIRMATION_PARSER_VERSION:AVENUE_PARSER_VERSION;
 const c=await db.connect();try{await c.query('BEGIN');
  const current=await c.query("SELECT id FROM ingestion.import_jobs WHERE id=$1 AND lease_token=$2::uuid AND status='parsing' FOR UPDATE",[job.id,job.token]);if(!current.rowCount)throw new Error('IMPORT_LEASE_LOST');
  for(const row of parsed.rows)await c.query(`INSERT INTO ingestion.raw_records(import_job_id,source_sheet,source_ordinal,record_kind,original,original_sha256,parser_version) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(import_job_id,source_sheet,source_ordinal,parser_version) DO NOTHING`,[job.id,row.sheet,row.source_ordinal,row.record_kind,row.original,row.original_sha256,parserVersion]);
  const count=await c.query('SELECT count(*)::int AS n FROM ingestion.raw_records WHERE import_job_id=$1 AND parser_version=$2',[job.id,parserVersion]);if(count.rows[0].n!==parsed.rows.length)throw new Error('PARSED_ROW_COUNT_MISMATCH');
  await c.query("UPDATE ingestion.import_jobs SET status='awaiting_review',parser_version=$3,result=$4,lease_token=NULL,lease_until=NULL,last_error=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2::uuid",[job.id,job.token,parserVersion,parsed.summary]);
  await c.query('INSERT INTO ingestion.outbox(event_id,event_type,payload) VALUES($1,$2,$3)',[randomUUID(),'DocumentParsed',{document_id:job.document_id,assignment_id:job.assignment_id,import_job_id:job.id,household_ref:doc.household_ref,owner_ref:doc.owner_ref,source:doc.source,file_type:doc.file_type,parser_version:parserVersion,...parsed.summary}]);
  await c.query('COMMIT');return parsed.summary;
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
async function fail(job:Record<string,unknown>,error:unknown){const attempts=Number(job.attempts),terminal=attempts>=3;await db.query(`UPDATE ingestion.import_jobs SET status=$3,available_at=now()+interval '1 minute' * $4,lease_token=NULL,lease_until=NULL,last_error=$5,updated_at=now() WHERE id=$1 AND lease_token=$2::uuid`,[job.id,job.token,terminal?'failed_terminal':'failed_retryable',Math.min(2**attempts,30),error instanceof Error?error.message:'IMPORT_FAILED']);}
async function loop(){while(!stopping){const job=await claim();if(!job){if(once)break;await new Promise(resolve=>setTimeout(resolve,3000));continue;}try{const summary=await processJob(job);console.log(JSON.stringify({import_job_id:job.id,parser_version:B3_PARSER_VERSION,record_count:summary.record_count,status:'awaiting_review'}));}catch(error){await fail(job,error);console.error(JSON.stringify({import_job_id:job.id,failed:true,error:error instanceof Error?error.message:'IMPORT_FAILED'}));if(once)throw error;}}}
process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
try{await loop();}finally{await db.end();}
