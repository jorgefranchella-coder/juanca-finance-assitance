import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import type {IncomingMessage} from 'node:http';
import type pg from 'pg';
import {Conflict} from './commands.ts';
import {interpretManualTrade} from './manual-trade-parse.ts';

const IMAGE_TYPES=new Set(['image/jpeg','image/png','image/webp','image/heic']);
const MAX_PHOTO_BYTES=20_000_000;
const KEY=/^[A-Za-z0-9._:-]{8,128}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Conflict('VALIDATION',422);return value as Record<string,unknown>;}
function fields(value:Record<string,unknown>,allowed:string[]){if(Object.keys(value).some(k=>!allowed.includes(k)))throw new Conflict('VALIDATION',422);}
function date(value:unknown){if(value===null)return null;if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||Number.isNaN(Date.parse(value+'T00:00:00Z'))||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)throw new Conflict('VALIDATION',422);return value;}
async function ownerId(db:pg.Pool,household:string,name:unknown){if(typeof name!=='string'||!['Jorge','Julia'].includes(name))throw new Conflict('VALIDATION',422);const result=await db.query('SELECT id FROM app.owners WHERE household_id=$1 AND display_name=$2',[household,name]);if(!result.rowCount)throw new Conflict('UNKNOWN_OWNER',422);return String(result.rows[0].id);}
export async function readJson(req:IncomingMessage,max=16000){if(String(req.headers['content-type']??'').split(';')[0]!=='application/json'||req.headers['transfer-encoding'])throw new Conflict('INVALID_CONTENT_TYPE',415);const chunks:Buffer[]=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>max)throw new Conflict('BODY_TOO_LARGE',413);chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;}catch{throw new Conflict('INVALID_JSON',422);}}
export async function recordText(db:pg.Pool,household:string,body:unknown){
 const input=object(body);fields(input,['request_id','owner','text','occurred_on']);
 if(typeof input.request_id!=='string'||!KEY.test(input.request_id)||typeof input.text!=='string'||!input.text.trim()||input.text.length>8000)throw new Conflict('VALIDATION',422);
 const owner=await ownerId(db,household,input.owner),occurred=date(input.occurred_on??null);
 const digest=createHash('sha256').update(JSON.stringify([owner,input.text,occurred])).digest('hex'),id=randomUUID();
 const c=await db.connect();
 try {
  await c.query('BEGIN');
  const saved=await c.query(`INSERT INTO app.manual_intakes(household_id,id,request_key,request_hash,owner_id,original_text,occurred_on) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(household_id,request_key) DO NOTHING RETURNING id,status,received_at`,[household,id,input.request_id,digest,owner,input.text,occurred]);
  let intake;
  if(saved.rowCount){
   intake=saved.rows[0];const parsed=interpretManualTrade(input.text,occurred);
   await c.query(`INSERT INTO app.manual_trade_interpretations(household_id,intake_id,parser_version,interpretation_status,fields,review_reasons) VALUES($1,$2,$3,$4,$5,$6)`,[household,id,parsed.parser_version,parsed.status,JSON.stringify(parsed.fields),parsed.review_reasons]);
  }else{
   const prior=await c.query('SELECT id,status,received_at,request_hash FROM app.manual_intakes WHERE household_id=$1 AND request_key=$2',[household,input.request_id]);
   if(prior.rows[0]?.request_hash!==digest)throw new Conflict('IDEMPOTENCY_MISMATCH',409);
   intake=prior.rows[0];
  }
  const parsed=await c.query('SELECT interpretation_status,fields,review_reasons,parser_version FROM app.manual_trade_interpretations WHERE household_id=$1 AND intake_id=$2',[household,intake.id]);
  await c.query('COMMIT');
  return{intake_id:intake.id,status:intake.status,received_at:intake.received_at,interpretation:parsed.rows[0]??null,mode:'shadow',replayed:!saved.rowCount};
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
export async function textStatus(db:pg.Pool,household:string,id:string){if(!UUID.test(id))throw new Conflict('NOT_FOUND',404);const found=await db.query(`SELECT i.id,i.owner_id,i.original_text,i.occurred_on,i.status,i.received_at,t.interpretation_status,t.fields,t.review_reasons,t.parser_version FROM app.manual_intakes i LEFT JOIN app.manual_trade_interpretations t ON t.household_id=i.household_id AND t.intake_id=i.id WHERE i.household_id=$1 AND i.id=$2`,[household,id]);if(!found.rowCount)throw new Conflict('NOT_FOUND',404);return{...found.rows[0],mode:'shadow',portfolio_changed:false};}
export async function listTextIntakes(db:pg.Pool,household:string,limit:number){
 const found=await db.query(`SELECT i.id,i.owner_id,o.display_name AS owner,i.original_text,i.occurred_on,i.status,i.received_at,t.interpretation_status,t.fields,t.review_reasons,t.parser_version FROM app.manual_intakes i JOIN app.owners o ON o.household_id=i.household_id AND o.id=i.owner_id LEFT JOIN app.manual_trade_interpretations t ON t.household_id=i.household_id AND t.intake_id=i.id WHERE i.household_id=$1 ORDER BY i.received_at DESC,i.id LIMIT $2`,[household,limit]);
 return{items:found.rows,mode:'shadow',portfolio_changed:false};
}
type IngestionConfig={token:string;port:number};
let ingestionConfig:Promise<IngestionConfig>|undefined;
async function config(){return ingestionConfig??=readFile(process.env.JUANCA_INGESTION_CONFIG??'/home/jorge/.local/share/juanca-shadow/ingestion.json','utf8').then(raw=>{const value=JSON.parse(raw) as IngestionConfig;if(typeof value.token!=='string'||value.token.length<32||!Number.isInteger(value.port))throw new Error('INVALID_INGESTION_CONFIG');return value;});}
async function call(path:string,method:string,body?:Buffer|string,headers:Record<string,string>={}){const cfg=await config();let response:Response;try{response=await fetch(`http://127.0.0.1:${cfg.port}${path}`,{method,headers:{Authorization:`Bearer ${cfg.token}`,...headers},body:Buffer.isBuffer(body)?Uint8Array.from(body):body,signal:AbortSignal.timeout(120000)});}catch{throw new Conflict('INGESTION_UNAVAILABLE',503);}const result=await response.json() as Record<string,unknown>;if(!response.ok)throw new Conflict(String(result.code??'INGESTION_ERROR'),response.status);return result;}
async function callBinary(path:string,headers:Record<string,string>={}){const cfg=await config();let response:Response;try{response=await fetch(`http://127.0.0.1:${cfg.port}${path}`,{method:'GET',headers:{Authorization:`Bearer ${cfg.token}`,...headers},signal:AbortSignal.timeout(120000)});}catch{throw new Conflict('INGESTION_UNAVAILABLE',503);}if(!response.ok){let code='INGESTION_ERROR';try{code=String(((await response.json()) as Record<string,unknown>).code??code);}catch{}throw new Conflict(code,response.status);}return{bytes:Buffer.from(await response.arrayBuffer()),contentType:String(response.headers.get('content-type')??''),sha256:String(response.headers.get('x-document-sha256')??'')};}
export {call as ingestionCall};
export async function startPhoto(db:pg.Pool,household:string,req:IncomingMessage,body:unknown){const input=object(body);fields(input,['request_id','owner','occurred_on','file_name','content_sha256','byte_size','content_type']);if(typeof input.request_id!=='string'||!KEY.test(input.request_id)||typeof input.file_name!=='string'||!input.file_name.trim()||input.file_name.length>180||typeof input.content_sha256!=='string'||!/^[0-9a-f]{64}$/.test(input.content_sha256)||!Number.isSafeInteger(input.byte_size)||Number(input.byte_size)<1||Number(input.byte_size)>MAX_PHOTO_BYTES||!IMAGE_TYPES.has(String(input.content_type)))throw new Conflict('VALIDATION',422);const owner=await ownerId(db,household,input.owner);const occurred=date(input.occurred_on??null);const key=String(req.headers['idempotency-key']??input.request_id);if(!KEY.test(key))throw new Conflict('INVALID_IDEMPOTENCY_KEY',422);const payload={household_ref:household,owner_ref:owner,account_ref:null,source:'manual',file_type:'manual_evidence',reference_date:occurred,file_name:input.file_name,content_sha256:input.content_sha256,byte_size:input.byte_size,content_type:input.content_type};const result=await call('/v1/uploads','POST',JSON.stringify(payload),{'Content-Type':'application/json','Idempotency-Key':key});return{upload_id:result.upload_id,status:result.status,content_url:`/v1/evidence/photos/${result.upload_id}/content`,mode:'shadow'};}
async function photoStatus(household:string,id:string){if(!UUID.test(id))throw new Conflict('NOT_FOUND',404);const status=await call(`/v1/uploads/${id}`,'GET',undefined,{'X-Household-Ref':household});if(status.source!=='manual'||status.file_type!=='manual_evidence')throw new Conflict('NOT_FOUND',404);return status;}
export async function getPhotoStatus(household:string,id:string){const status=await photoStatus(household,id);return{...status,mode:'shadow'};}
export async function getPhotoContent(household:string,id:string){
 const status=await photoStatus(household,id);if(status.status!=='stored'||typeof status.document_id!=='string'||!IMAGE_TYPES.has(String(status.content_type)))throw new Conflict('PHOTO_NOT_READY',409);
 const content=await callBinary(`/v1/documents/${status.document_id}/content`,{'X-Household-Ref':household});
 if(content.contentType!==status.content_type||content.sha256!==status.content_sha256||content.bytes.length!==Number(status.expected_size)||createHash('sha256').update(content.bytes).digest('hex')!==status.content_sha256)throw new Conflict('PHOTO_CONTENT_VERIFICATION_FAILED',502);
 return{bytes:content.bytes,contentType:content.contentType,fileName:String(status.file_name??'photo')};
}
export async function listPhotoEvidence(db:pg.Pool,household:string,limit:number){
 const result=await call(`/v1/manual-evidence/photos?limit=${limit}`,'GET',undefined,{'X-Household-Ref':household});
 const items=Array.isArray(result.items)?result.items as Array<Record<string,unknown>>:[];
 const names=await db.query('SELECT id,display_name FROM app.owners WHERE household_id=$1',[household]);
 const owners=new Map(names.rows.map(row=>[String(row.id),String(row.display_name)]));
 const uploadIds=items.map(item=>String(item.upload_id)).filter(id=>UUID.test(id));
 const saved=uploadIds.length?await db.query(`SELECT upload_id,ocr_text_sha256,parser_version,interpretation_status,fields,review_reasons FROM app.manual_photo_trade_interpretations WHERE household_id=$1 AND upload_id=ANY($2::uuid[]) ORDER BY created_at DESC`,[household,uploadIds]):{rows:[]};
 const interpretations=new Map<string,Record<string,unknown>>();for(const row of saved.rows){const key=[row.upload_id,row.ocr_text_sha256,row.parser_version].join('|');if(!interpretations.has(key))interpretations.set(key,{parser_version:row.parser_version,status:row.interpretation_status,fields:row.fields,review_reasons:row.review_reasons});}
 return{items:items.map(item=>{const key=[item.upload_id,item.ocr_text_sha256,item.ocr_parser_version].join('|');return{...item,ocr_trade_interpretation:interpretations.get(key)??null,owner:owners.get(String(item.owner_ref))??'Titular pendiente',owner_ref:undefined,mode:'shadow',content_interpretation:'pending_manual_review'};}),mode:'shadow',portfolio_changed:false};
}
export async function putPhoto(household:string,id:string,req:IncomingMessage){const status=await photoStatus(household,id);const length=Number(req.headers['content-length']);const type=String(req.headers['content-type']??'').split(';')[0];if(!Number.isSafeInteger(length)||length<1||length>MAX_PHOTO_BYTES||length!==Number(status.expected_size)||!IMAGE_TYPES.has(type))throw new Conflict('UPLOAD_METADATA_MISMATCH',422);const chunks:Buffer[]=[];let count=0;for await(const chunk of req){count+=chunk.length;if(count>MAX_PHOTO_BYTES)throw new Conflict('BODY_TOO_LARGE',413);chunks.push(chunk);}if(count!==length)throw new Conflict('UPLOAD_METADATA_MISMATCH',422);const result=await call(`/v1/uploads/${id}/content`,'PUT',Buffer.concat(chunks),{'Content-Type':type,'Content-Length':String(length)});return{...result,mode:'shadow'};}

const DOCUMENT_TYPES:Record<string,{fileTypes:string[];contentType:string}>={
 b3:{fileTypes:['positions','movements'],contentType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'},
 avenue:{fileTypes:['avenue_statement','avenue_confirmation'],contentType:'application/pdf'},
 pension:{fileTypes:['pension_statement'],contentType:'application/pdf'}
};
const MAX_DOCUMENT_BYTES=30_000_000;
export async function startSourceDocument(db:pg.Pool,household:string,body:unknown){const input=object(body);fields(input,['request_id','owner','source','file_type','reference_date','file_name','content_sha256','byte_size','content_type']);const source=String(input.source??''),fileType=String(input.file_type??''),expected=DOCUMENT_TYPES[source];if(!expected?.fileTypes.includes(fileType)||input.content_type!==expected.contentType||typeof input.request_id!=='string'||!KEY.test(input.request_id)||typeof input.file_name!=='string'||!input.file_name.trim()||input.file_name.length>180||typeof input.content_sha256!=='string'||!/^[0-9a-f]{64}$/.test(input.content_sha256)||!Number.isSafeInteger(input.byte_size)||Number(input.byte_size)<1||Number(input.byte_size)>MAX_DOCUMENT_BYTES)throw new Conflict('VALIDATION',422);const owner=await ownerId(db,household,input.owner);const referenceDate=date(input.reference_date??null);if(source==='b3'&&fileType==='positions'&&!referenceDate)throw new Conflict('REFERENCE_DATE_REQUIRED',422);const payload={household_ref:household,owner_ref:owner,account_ref:null,source,file_type:fileType,reference_date:referenceDate,file_name:input.file_name,content_sha256:input.content_sha256,byte_size:input.byte_size,content_type:input.content_type};const result=await call('/v1/uploads','POST',JSON.stringify(payload),{'Content-Type':'application/json','Idempotency-Key':input.request_id});return{upload_id:result.upload_id,status:result.status,content_url:`/v1/evidence/documents/${result.upload_id}/content`,mode:'shadow'};}
async function sourceStatus(household:string,id:string){if(!UUID.test(id))throw new Conflict('NOT_FOUND',404);const status=await call(`/v1/uploads/${id}`,'GET',undefined,{'X-Household-Ref':household});if(!DOCUMENT_TYPES[String(status.source)]?.fileTypes.includes(String(status.file_type)))throw new Conflict('NOT_FOUND',404);return status;}
export async function getSourceStatus(household:string,id:string){return{...await sourceStatus(household,id),mode:'shadow'};}
export async function putSourceDocument(household:string,id:string,req:IncomingMessage){const status=await sourceStatus(household,id);const length=Number(req.headers['content-length']);const type=String(req.headers['content-type']??'').split(';')[0],expected=DOCUMENT_TYPES[String(status.source)]?.contentType;if(!Number.isSafeInteger(length)||length<1||length>MAX_DOCUMENT_BYTES||length!==Number(status.expected_size)||type!==expected)throw new Conflict('UPLOAD_METADATA_MISMATCH',422);const chunks:Buffer[]=[];let count=0;for await(const chunk of req){count+=chunk.length;if(count>MAX_DOCUMENT_BYTES)throw new Conflict('BODY_TOO_LARGE',413);chunks.push(chunk);}if(count!==length)throw new Conflict('UPLOAD_METADATA_MISMATCH',422);return{...await call(`/v1/uploads/${id}/content`,'PUT',Buffer.concat(chunks),{'Content-Type':type,'Content-Length':String(length)}),mode:'shadow'};}
