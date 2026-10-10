import {createServer} from 'node:http';
import {createHash,randomUUID,timingSafeEqual} from 'node:crypto';
import {createWriteStream,createReadStream} from 'node:fs';
import {unlink,stat} from 'node:fs/promises';
import {basename,join} from 'node:path';
import {Transform,Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import type pg from 'pg';
import {pool} from './db.ts';
import {config} from './config.ts';
import {objectPath,publishObject} from './object-store.ts';

const MAX_BYTES=30_000_000;
const CONTENT_TYPES=new Set(['application/pdf','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','text/csv','application/csv']);
const IMAGE_TYPES=new Set(['image/jpeg','image/png','image/webp','image/heic']);
type UploadInput={household_ref:string;owner_ref:string;account_ref:string|null;source:'b3'|'avenue'|'pension'|'manual';file_type:'positions'|'movements'|'avenue_statement'|'avenue_confirmation'|'pension_statement'|'manual_evidence';reference_date:string|null;file_name:string;content_sha256:string;byte_size:number;content_type:string};
function cleanText(value:unknown,max:number){if(typeof value!=='string'||!value.trim()||value.length>max||/[\u0000-\u001f\u007f]/.test(value))throw new Error('INVALID_METADATA');return value.trim();}
function validateUpload(value:unknown):UploadInput{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('INVALID_BODY');const v=value as Record<string,unknown>;
 const allowed=['household_ref','owner_ref','account_ref','source','file_type','reference_date','file_name','content_sha256','byte_size','content_type'];if(Object.keys(v).some(k=>!allowed.includes(k))||allowed.some(k=>!(k in v)))throw new Error('INVALID_BODY');
 const source=cleanText(v.source,20),fileType=cleanText(v.file_type,32);const pairs:Record<string,string[]>={b3:['positions','movements'],avenue:['avenue_statement','avenue_confirmation'],pension:['pension_statement'],manual:['manual_evidence']};if(!pairs[source]?.includes(fileType))throw new Error('INVALID_FILE_TYPE');
 const digest=cleanText(v.content_sha256,64);if(!/^[0-9a-f]{64}$/.test(digest))throw new Error('INVALID_DIGEST');const size=Number(v.byte_size);if(!Number.isSafeInteger(size)||size<1||size>MAX_BYTES)throw new Error('INVALID_SIZE');
 const type=cleanText(v.content_type,100).toLowerCase();if(!(source==='manual'&&fileType==='manual_evidence'?IMAGE_TYPES.has(type)||CONTENT_TYPES.has(type):CONTENT_TYPES.has(type)))throw new Error('INVALID_CONTENT_TYPE');
 const fileName=basename(cleanText(v.file_name,240).replaceAll('\\','/'));if(!fileName||fileName==='.'||fileName==='..'||Buffer.byteLength(fileName)>180)throw new Error('INVALID_FILE_NAME');
 const date=v.reference_date===null?null:cleanText(v.reference_date,10);if(date&&!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new Error('INVALID_DATE');
 const account=v.account_ref===null?null:cleanText(v.account_ref,128);
 return{household_ref:cleanText(v.household_ref,100),owner_ref:cleanText(v.owner_ref,100),account_ref:account,source:source as UploadInput['source'],file_type:fileType as UploadInput['file_type'],reference_date:date,file_name:fileName,content_sha256:digest,byte_size:size,content_type:type};
}
function hash(value:unknown){return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
async function readJson(req:import('node:http').IncomingMessage,max:number){const chunks:Buffer[]=[];let size=0;for await(const part of req){size+=part.length;if(size>max)throw new Error('BODY_TOO_LARGE');chunks.push(part);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;}catch{throw new Error('INVALID_JSON');}}
async function claimUpload(db:pg.Pool,id:string){const token=randomUUID();const result=await db.query(`UPDATE ingestion.upload_jobs SET status='receiving',lease_until=now()+interval '10 minutes',lease_token=$2::uuid,updated_at=now() WHERE id=$1 AND (status IN ('awaiting_upload','failed_retryable') OR status='receiving' AND lease_until<now()) RETURNING *`,[id,token]);return result.rowCount?{job:result.rows[0],token}:null;}
async function matchesBody(req:import('node:http').IncomingMessage,expectedSize:number,expectedHash:string){
 const hash=createHash('sha256');let size=0;const meter=new Transform({transform(chunk:Buffer,_encoding,done){size+=chunk.length;if(size>MAX_BYTES){done(new Error('BODY_TOO_LARGE'));return;}hash.update(chunk);done(null,chunk);}});
 await pipeline(req,meter,new Writable({write(_chunk,_encoding,done){done();}}));return size===expectedSize&&hash.digest('hex')===expectedHash;
}
async function saveDocument(db:pg.Pool,job:Record<string,unknown>,token:string,objectKey:string){
 const c=await db.connect();try{
  await c.query('BEGIN');const current=await c.query("SELECT id FROM ingestion.upload_jobs WHERE id=$1 AND status='receiving' AND lease_token=$2::uuid FOR UPDATE",[job.id,token]);if(!current.rowCount)throw new Error('UPLOAD_LEASE_LOST');
  const doc=await c.query('INSERT INTO ingestion.documents(id,content_sha256,byte_size,content_type,object_key) VALUES($1,$2,$3,$4,$5) ON CONFLICT(content_sha256) DO NOTHING RETURNING id',[randomUUID(),job.content_sha256,job.expected_size,job.content_type,objectKey]);
  const documentId=doc.rowCount?doc.rows[0].id:(await c.query('SELECT id FROM ingestion.documents WHERE content_sha256=$1',[job.content_sha256])).rows[0].id;
  const conflict=await c.query(`SELECT 1 FROM ingestion.document_assignments WHERE document_id=$1 AND household_ref=$2 AND (owner_ref<>$3 OR account_ref IS DISTINCT FROM $4 OR source<>$5 OR file_type<>$6 OR reference_date IS DISTINCT FROM $7::date) LIMIT 1`,[documentId,job.household_ref,job.owner_ref,job.account_ref,job.source,job.file_type,job.reference_date]);
  const assignment=await c.query(`INSERT INTO ingestion.document_assignments(id,document_id,household_ref,owner_ref,account_ref,source,file_type,reference_date) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING id`,[randomUUID(),documentId,job.household_ref,job.owner_ref,job.account_ref,job.source,job.file_type,job.reference_date]);
  const assignmentId=assignment.rowCount?assignment.rows[0].id:(await c.query(`SELECT id FROM ingestion.document_assignments WHERE document_id=$1 AND household_ref=$2 AND owner_ref=$3 AND source=$4 AND file_type=$5 AND reference_date IS NOT DISTINCT FROM $6::date AND account_ref IS NOT DISTINCT FROM $7 LIMIT 1`,[documentId,job.household_ref,job.owner_ref,job.source,job.file_type,job.reference_date,job.account_ref])).rows[0].id;
  await c.query('INSERT INTO ingestion.import_jobs(id,upload_job_id,document_id,assignment_id,status) VALUES($1,$2,$3,$4,\'queued\') ON CONFLICT DO NOTHING',[randomUUID(),job.id,documentId,assignmentId]);
  const importJob=await c.query('SELECT id,status FROM ingestion.import_jobs WHERE document_id=$1 AND assignment_id=$2 ORDER BY created_at DESC LIMIT 1',[documentId,assignmentId]);
  const payload={document_id:documentId,assignment_id:assignmentId,import_job_id:importJob.rows[0]?.id??null,import_job_status:importJob.rows[0]?.status??null,household_ref:job.household_ref,owner_ref:job.owner_ref,account_ref:job.account_ref,source:job.source,file_type:job.file_type,reference_date:job.reference_date,content_sha256:job.content_sha256,byte_size:job.expected_size,assignment_warning:Boolean(conflict.rowCount)};
  await c.query('INSERT INTO ingestion.outbox(event_id,event_type,payload) VALUES($1,$2,$3)',[randomUUID(),'DocumentStored',payload]);
  await c.query("UPDATE ingestion.upload_jobs SET status='stored',document_id=$3,assignment_id=$4,lease_token=NULL,lease_until=NULL,last_error=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2::uuid",[job.id,token,documentId,assignmentId]);await c.query('COMMIT');return payload;
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
export async function startIngestion(){
 const cfg=await config(),db=pool();const server=createServer(async(req,res)=>{
  const requestId=randomUUID();res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Request-Id',requestId);const reply=(status:number,value:unknown)=>{if(res.headersSent){res.destroy();return;}res.statusCode=status;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
  let tempPath:string|undefined;
  try{
   const url=new URL(req.url??'/','http://localhost');if(url.pathname==='/health/ready'&&req.method==='GET'){await db.query('SELECT 1');reply(200,{status:'ready',service:'ingestion'});return;}
   const provided=createHash('sha256').update(req.headers.authorization??'').digest(),expected=createHash('sha256').update('Bearer '+cfg.token).digest();if(!timingSafeEqual(provided,expected)){reply(401,{code:'UNAUTHENTICATED',request_id:requestId});return;}
   if(url.pathname==='/v1/uploads'&&req.method==='POST'){
    if(String(req.headers['content-type']??'').split(';')[0]!=='application/json'){reply(415,{code:'INVALID_CONTENT_TYPE',request_id:requestId});return;}
    const input=validateUpload(await readJson(req,16000)),key=String(req.headers['idempotency-key']??'');if(!/^[A-Za-z0-9._:-]{8,128}$/.test(key))throw new Error('INVALID_IDEMPOTENCY_KEY');const requestHash=hash(input),id=randomUUID();
    const inserted=await db.query(`INSERT INTO ingestion.upload_jobs(id,request_key,request_hash,household_ref,owner_ref,account_ref,source,file_type,reference_date,file_name,content_sha256,expected_size,content_type,status)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'awaiting_upload') ON CONFLICT(request_key) DO NOTHING RETURNING id,status`,[id,key,requestHash,input.household_ref,input.owner_ref,input.account_ref,input.source,input.file_type,input.reference_date,input.file_name,input.content_sha256,input.byte_size,input.content_type]);
    let job=inserted.rows[0];if(!job){const old=await db.query('SELECT id,status,request_hash FROM ingestion.upload_jobs WHERE request_key=$1',[key]);if(old.rows[0]?.request_hash!==requestHash){reply(409,{code:'IDEMPOTENCY_MISMATCH',request_id:requestId});return;}job=old.rows[0];}
    reply(202,{upload_id:job.id,status:job.status,content_url:`/v1/uploads/${job.id}/content`,request_id:requestId});return;
   }
   const contentMatch=url.pathname.match(/^\/v1\/uploads\/([0-9a-f-]{36})\/content$/);
   if(contentMatch&&req.method==='PUT'){
    const id=contentMatch[1],contentLength=Number(req.headers['content-length']);if(!Number.isSafeInteger(contentLength)||contentLength<1||contentLength>MAX_BYTES){req.resume();reply(413,{code:'INVALID_CONTENT_LENGTH',request_id:requestId});return;}
    const claimed=await claimUpload(db,id);if(!claimed){const existing=await db.query('SELECT status,content_sha256,expected_size,content_type,document_id,assignment_id FROM ingestion.upload_jobs WHERE id=$1',[id]);if(existing.rowCount&&existing.rows[0].status==='stored'){
      const row=existing.rows[0];if(contentLength!==Number(row.expected_size)||String(req.headers['content-type']??'').split(';')[0]!==row.content_type){req.resume();reply(422,{code:'UPLOAD_METADATA_MISMATCH',request_id:requestId});return;}
      try{if(!await matchesBody(req,Number(row.expected_size),row.content_sha256)){reply(422,{code:'CONTENT_HASH_MISMATCH',request_id:requestId});return;}}catch{reply(422,{code:'CONTENT_HASH_MISMATCH',request_id:requestId});return;}
      reply(200,{upload_id:id,status:'stored',document_id:row.document_id,assignment_id:row.assignment_id,replayed:true,request_id:requestId});return;
    }reply(existing.rowCount?409:404,{code:existing.rowCount?'UPLOAD_IN_PROGRESS':'NOT_FOUND',request_id:requestId});return;}
    const {job,token}=claimed;tempPath=join(cfg.object_root,'tmp',`${id}-${token}.part`);
    if(contentLength!==Number(job.expected_size)||String(req.headers['content-type']??'').split(';')[0]!==job.content_type){await db.query("UPDATE ingestion.upload_jobs SET status='failed_terminal',last_error='UPLOAD_METADATA_MISMATCH',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2::uuid",[id,token]);req.resume();reply(422,{code:'UPLOAD_METADATA_MISMATCH',request_id:requestId});return;}
    const digest=createHash('sha256');let actual=0;const meter=new Transform({transform(chunk:Buffer,_encoding,done){actual+=chunk.length;if(actual>MAX_BYTES){done(new Error('BODY_TOO_LARGE'));return;}digest.update(chunk);done(null,chunk);}});
    try{await pipeline(req,meter,createWriteStream(tempPath,{flags:'wx',mode:0o600}));}catch(error){await unlink(tempPath).catch(()=>{});await db.query("UPDATE ingestion.upload_jobs SET status='failed_retryable',last_error='INCOMPLETE_UPLOAD',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2::uuid",[id,token]);reply(400,{code:(error as Error).message==='BODY_TOO_LARGE'?'BODY_TOO_LARGE':'INCOMPLETE_UPLOAD',request_id:requestId});return;}
    const actualHash=digest.digest('hex');if(actual!==Number(job.expected_size)||actualHash!==job.content_sha256){await unlink(tempPath).catch(()=>{});await db.query("UPDATE ingestion.upload_jobs SET status='failed_terminal',last_error='CONTENT_HASH_MISMATCH',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2::uuid",[id,token]);reply(422,{code:'CONTENT_HASH_MISMATCH',request_id:requestId});return;}
    await publishObject(cfg.object_root,tempPath,actualHash,actual);tempPath=undefined;const saved=await saveDocument(db,job,token,objectPath(cfg.object_root,actualHash));reply(201,{upload_id:id,status:'stored',...saved,request_id:requestId});return;
   }
   const statusMatch=url.pathname.match(/^\/v1\/uploads\/([0-9a-f-]{36})$/);if(statusMatch&&req.method==='GET'){
    const household=String(req.headers['x-household-ref']??'');const result=await db.query(`SELECT u.id,u.status,u.owner_ref,u.source,u.file_type,u.file_name,u.content_type,u.document_id,u.assignment_id,u.content_sha256,u.expected_size,u.last_error,u.created_at,u.updated_at,i.id AS import_job_id,i.status AS import_job_status,i.parser_version FROM ingestion.upload_jobs u LEFT JOIN LATERAL(SELECT id,status,parser_version FROM ingestion.import_jobs j WHERE j.document_id=u.document_id AND j.assignment_id=u.assignment_id ORDER BY j.created_at DESC LIMIT 1)i ON true WHERE u.id=$1 AND u.household_ref=$2`,[statusMatch[1],household]);if(!result.rowCount){reply(404,{code:'NOT_FOUND',request_id:requestId});return;}reply(200,{...result.rows[0],request_id:requestId});return;
   }
   if(url.pathname==='/v1/manual-evidence/photos'&&req.method==='GET'){
    const household=String(req.headers['x-household-ref']??'');if(!household){reply(422,{code:'HOUSEHOLD_REQUIRED',request_id:requestId});return;}
    const limit=Number(url.searchParams.get('limit')??'50');if(!Number.isInteger(limit)||limit<1||limit>100){reply(422,{code:'INVALID_LIMIT',request_id:requestId});return;}
    const result=await db.query(`SELECT u.id AS upload_id,u.owner_ref,u.file_name,u.status,u.content_type,u.expected_size AS byte_size,u.document_id,u.content_sha256,u.last_error,u.created_at,u.updated_at,a.reference_date AS occurred_on,j.status AS processing_status,j.parser_version AS ocr_parser_version,j.result->>'ocr_status' AS ocr_status,j.result->>'ocr_text' AS ocr_text,COALESCE((j.result->>'ocr_truncated')::boolean,false) AS ocr_truncated
     FROM ingestion.upload_jobs u LEFT JOIN ingestion.document_assignments a ON a.id=u.assignment_id LEFT JOIN LATERAL(SELECT status,parser_version,result FROM ingestion.import_jobs j WHERE j.upload_job_id=u.id ORDER BY j.created_at DESC LIMIT 1)j ON true
     WHERE u.household_ref=$1 AND u.source='manual' AND u.file_type='manual_evidence' ORDER BY u.created_at DESC,u.id LIMIT $2`,[household,limit]);
    reply(200,{items:result.rows,mode:'shadow',request_id:requestId});return;
   }
   if(url.pathname==='/v1/import-jobs/ready'&&req.method==='GET'){
    const household=String(req.headers['x-household-ref']??'');if(!household){reply(422,{code:'HOUSEHOLD_REQUIRED',request_id:requestId});return;}
    const offset=Number(url.searchParams.get('offset')??'0');if(!Number.isSafeInteger(offset)||offset<0||offset>1_000_000){reply(422,{code:'INVALID_OFFSET',request_id:requestId});return;}
    const result=await db.query(`SELECT j.id,j.document_id,j.assignment_id,j.parser_version,j.result,d.content_sha256,a.owner_ref,a.file_type,a.reference_date,u.file_name FROM ingestion.import_jobs j JOIN ingestion.document_assignments a ON a.id=j.assignment_id JOIN ingestion.documents d ON d.id=j.document_id JOIN ingestion.upload_jobs u ON u.id=j.upload_job_id WHERE a.household_ref=$1 AND a.source='b3' AND j.status='awaiting_review' ORDER BY j.created_at,j.id LIMIT 100 OFFSET $2`,[household,offset]);reply(200,{jobs:result.rows,request_id:requestId});return;
   }
   const recordsMatch=url.pathname.match(/^\/v1\/import-jobs\/([0-9a-f-]{36})\/records$/);if(recordsMatch&&req.method==='GET'){
    const household=String(req.headers['x-household-ref']??'');const header=await db.query(`SELECT j.id,j.document_id,j.assignment_id,j.parser_version,j.result,d.content_sha256,a.owner_ref,a.file_type,a.reference_date,u.file_name FROM ingestion.import_jobs j JOIN ingestion.document_assignments a ON a.id=j.assignment_id JOIN ingestion.documents d ON d.id=j.document_id JOIN ingestion.upload_jobs u ON u.id=j.upload_job_id WHERE j.id=$1 AND a.household_ref=$2 AND a.source='b3' AND j.status='awaiting_review'`,[recordsMatch[1],household]);if(!header.rowCount){reply(404,{code:'NOT_FOUND',request_id:requestId});return;}
    const records=await db.query('SELECT source_sheet,source_ordinal,record_kind,original,original_sha256 FROM ingestion.raw_records WHERE import_job_id=$1 AND parser_version=$2 ORDER BY source_sheet,source_ordinal',[recordsMatch[1],header.rows[0].parser_version]);reply(200,{job:header.rows[0],records:records.rows,request_id:requestId});return;
   }
   const documentMatch=url.pathname.match(/^\/v1\/documents\/([0-9a-f-]{36})\/content$/);if(documentMatch&&req.method==='GET'){
    const household=String(req.headers['x-household-ref']??'');const result=await db.query(`SELECT d.object_key,d.content_type,d.content_sha256,d.byte_size,u.file_name FROM ingestion.documents d JOIN ingestion.document_assignments a ON a.document_id=d.id JOIN ingestion.upload_jobs u ON u.document_id=d.id AND u.assignment_id=a.id WHERE d.id=$1 AND a.household_ref=$2 ORDER BY u.created_at DESC LIMIT 1`,[documentMatch[1],household]);if(!result.rowCount){reply(404,{code:'NOT_FOUND',request_id:requestId});return;}
    const row=result.rows[0],path=objectPath(cfg.object_root,row.content_sha256);await stat(path);res.statusCode=200;res.setHeader('Content-Type',row.content_type);res.setHeader('Content-Length',String(row.byte_size));res.setHeader('Content-Disposition',`attachment; filename="${String(row.file_name).replace(/["\\\r\n]/g,'_')}"`);res.setHeader('X-Document-SHA256',row.content_sha256);createReadStream(path).on('error',()=>res.destroy()).pipe(res);return;
   }
   reply(404,{code:'NOT_FOUND',request_id:requestId});
  }catch(error){if(tempPath)await unlink(tempPath).catch(()=>{});const code=error instanceof Error?error.message:'DEPENDENCY_UNAVAILABLE';const status=['INVALID_BODY','INVALID_METADATA','INVALID_FILE_TYPE','INVALID_DIGEST','INVALID_SIZE','INVALID_CONTENT_TYPE','INVALID_FILE_NAME','INVALID_DATE','INVALID_IDEMPOTENCY_KEY','BODY_TOO_LARGE'].includes(code)?422:503;reply(status,{code,request_id:requestId,retryable:status===503});}
 });server.requestTimeout=120000;server.headersTimeout=15000;server.listen(cfg.port,'127.0.0.1',()=>console.log('Juanca ingestion API ready on loopback.'));return{server,db};
}
const {db}=await startIngestion();
async function stop(){await db.end();process.exit(0);}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
