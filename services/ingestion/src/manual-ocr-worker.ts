import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {pool} from './db.ts';
import {config} from './config.ts';
import {objectPath} from './object-store.ts';

const VERSION='tesseract-5.3.4-por-eng-v1';
const MAX_TEXT=30000;
const TESSERACT=process.env.JUANCA_TESSERACT_BIN??'/home/jorge/.local/opt/juanca-tesseract/root/usr/bin/tesseract';
const TESSDATA=process.env.JUANCA_TESSDATA_PREFIX??'/home/jorge/.local/opt/juanca-tesseract/root/usr/share/tesseract-ocr/5/tessdata';
const LIBS='/home/jorge/.local/opt/juanca-tesseract/root/usr/lib/x86_64-linux-gnu';
const once=process.argv.includes('--once');const db=pool();await config();let stopping=false;

async function claim(){
 const token=randomUUID();
 const result=await db.query(`WITH next AS (
  SELECT j.id FROM ingestion.import_jobs j JOIN ingestion.document_assignments a ON a.id=j.assignment_id JOIN ingestion.upload_jobs u ON u.id=j.upload_job_id
  WHERE a.source='manual' AND a.file_type='manual_evidence' AND u.status='stored'
   AND ((j.status IN ('queued','failed_retryable') AND j.available_at<=now()) OR (j.status='parsing' AND j.lease_until<now()))
  ORDER BY j.created_at FOR UPDATE OF j SKIP LOCKED LIMIT 1
 ) UPDATE ingestion.import_jobs j SET status='parsing',lease_token=$1::uuid,lease_until=now()+interval '5 minutes',attempts=attempts+1,updated_at=now()
 FROM next WHERE j.id=next.id RETURNING j.id,j.document_id,j.assignment_id,j.attempts`,[token]);
 return result.rowCount?{...result.rows[0],token}:null;
}

function recognize(bytes:Buffer){return new Promise<{text:string;truncated:boolean}>((resolve,reject)=>{
 const child=spawn(TESSERACT,['stdin','stdout','-l','por+eng','--psm','6','--tessdata-dir',TESSDATA],{env:{...process.env,LD_LIBRARY_PATH:LIBS},stdio:['pipe','pipe','pipe']});
 const out:Buffer[]=[];let size=0;let err='';const timer=setTimeout(()=>child.kill('SIGKILL'),90000);
 child.stdout.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>MAX_TEXT*4){child.kill('SIGKILL');return;}out.push(chunk);});
 child.stderr.on('data',(chunk:Buffer)=>{if(err.length<2000)err+=chunk.toString('utf8');});
 child.on('error',error=>{clearTimeout(timer);reject(error);});
 child.on('close',code=>{clearTimeout(timer);if(code!==0){reject(new Error(`TESSERACT_EXIT_${code}:${err.slice(0,500)}`));return;}const full=Buffer.concat(out).toString('utf8').replace(/\u0000/g,'').trim();resolve({text:full.slice(0,MAX_TEXT),truncated:full.length>MAX_TEXT});});
 child.stdin.on('error',()=>{});child.stdin.end(bytes);
 });}

async function processJob(job:Record<string,unknown>){
 const input=await db.query(`SELECT d.content_sha256,d.byte_size,d.content_type,a.household_ref,a.owner_ref FROM ingestion.documents d JOIN ingestion.document_assignments a ON a.document_id=d.id WHERE d.id=$1 AND a.id=$2`,[job.document_id,job.assignment_id]);
 if(!input.rowCount)throw new Error('IMPORT_SOURCE_MISSING');const doc=input.rows[0];
 const bytes=await readFile(objectPath((await config()).object_root,String(doc.content_sha256)));
 if(bytes.length!==Number(doc.byte_size)||createHash('sha256').update(bytes).digest('hex')!==doc.content_sha256)throw new Error('DOCUMENT_CONTENT_MISMATCH');
 const supported=['image/jpeg','image/png','image/webp'].includes(String(doc.content_type));
 const recognized=supported?await recognize(bytes):{text:'',truncated:false};const text=recognized.text;
 const digest=createHash('sha256').update(text,'utf8').digest('hex');
 const result={ocr_status:supported?'completed':'unsupported_image_format',ocr_engine:'Tesseract 5.3.4',ocr_languages:['por','eng'],ocr_parser_version:VERSION,ocr_text:text,ocr_text_sha256:digest,ocr_truncated:recognized.truncated,review_required:true,portfolio_changed:false};
 const c=await db.connect();try{await c.query('BEGIN');
  const current=await c.query("SELECT id FROM ingestion.import_jobs WHERE id=$1 AND lease_token=$2::uuid AND status='parsing' FOR UPDATE",[job.id,job.token]);if(!current.rowCount)throw new Error('IMPORT_LEASE_LOST');
  if(supported){const original={text,engine:'Tesseract 5.3.4',languages:['por','eng'],truncated:result.ocr_truncated};const originalHash=createHash('sha256').update(JSON.stringify(original),'utf8').digest('hex');await c.query(`INSERT INTO ingestion.raw_records(import_job_id,source_sheet,source_ordinal,record_kind,original,original_sha256,parser_version) VALUES($1,'OCR',1,'ocr_text',$2,$3,$4) ON CONFLICT(import_job_id,source_sheet,source_ordinal,parser_version) DO NOTHING`,[job.id,original,originalHash,VERSION]);}
  await c.query("UPDATE ingestion.import_jobs SET status='awaiting_review',parser_version=$3,result=$4,lease_token=NULL,lease_until=NULL,last_error=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2::uuid",[job.id,job.token,VERSION,result]);
  await c.query('INSERT INTO ingestion.outbox(event_id,event_type,payload) VALUES($1,$2,$3)',[randomUUID(),'ManualEvidenceInterpreted',{document_id:job.document_id,assignment_id:job.assignment_id,import_job_id:job.id,household_ref:doc.household_ref,owner_ref:doc.owner_ref,source:'manual',file_type:'manual_evidence',parser_version:VERSION,ocr_status:result.ocr_status,portfolio_changed:false}]);
  await c.query('COMMIT');return result;
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
async function fail(job:Record<string,unknown>,error:unknown){const attempts=Number(job.attempts),terminal=attempts>=3;await db.query(`UPDATE ingestion.import_jobs SET status=$3,available_at=now()+interval '1 minute' * $4,lease_token=NULL,lease_until=NULL,last_error=$5,updated_at=now() WHERE id=$1 AND lease_token=$2::uuid`,[job.id,job.token,terminal?'failed_terminal':'failed_retryable',Math.min(2**attempts,30),error instanceof Error?error.message:'OCR_FAILED']);}
async function loop(){while(!stopping){const job=await claim();if(!job){if(once)break;await new Promise(resolve=>setTimeout(resolve,3000));continue;}try{const result=await processJob(job);console.log(JSON.stringify({import_job_id:job.id,parser_version:VERSION,ocr_status:result.ocr_status,review_required:true}));}catch(error){await fail(job,error);console.error(JSON.stringify({import_job_id:job.id,failed:true,error:error instanceof Error?error.message:'OCR_FAILED'}));if(once)throw error;}}}
process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});try{await loop();}finally{await db.end();}
