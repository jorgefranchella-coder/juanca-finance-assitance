import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';

const database='juanca_ingestion_test_'+randomUUID().replaceAll('-','');
const root=await mkdtemp(join(tmpdir(),'juanca-ingestion-test-'));
const admin=new pg.Client({host:'/home/jorge/.local/share/juanca-shadow/socket',port:55432,user:'jorge',database:'postgres'});
const testDb=new pg.Client({host:'/home/jorge/.local/share/juanca-shadow/socket',port:55432,user:'jorge',database});
let child:ReturnType<typeof spawn>|undefined;
let adminConnected=false;
try{
 await admin.connect();adminConnected=true;await admin.query('CREATE DATABASE "'+database+'"');await testDb.connect();
 await testDb.query(await readFile(new URL('../../../infra/postgres/roles.sql',import.meta.url),'utf8'));
 await admin.query('GRANT CREATE ON DATABASE "'+database+'" TO juanca_ingestion');
 const ing=new pg.Client({host:'/home/jorge/.local/share/juanca-shadow/socket',port:55432,user:'juanca_ingestion',database});await ing.connect();
 try{for(const migration of ['006_ingestion','007_ingestion_raw_sheet','008_ingestion_reference_date_correction','009_ingestion_evidence_archive_status'])await ing.query(await readFile(new URL('../../../infra/postgres/'+migration+'.sql',import.meta.url),'utf8'));}finally{await ing.end();}
 const listener=createServer();await new Promise<void>(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=(listener.address() as {port:number}).port;await new Promise<void>(resolve=>listener.close(()=>resolve()));
 const token=randomBytes(32).toString('hex');const config=join(root,'config.json');await writeFile(config,JSON.stringify({token,port,object_root:join(root,'objects')}),{mode:0o600});
 child=spawn(process.execPath,['--experimental-strip-types','services/ingestion/src/server.ts'],{cwd:new URL('../../../',import.meta.url),env:{...process.env,JUANCA_DATABASE:database,JUANCA_INGESTION_CONFIG:config},stdio:'ignore'});
 const base=`http://127.0.0.1:${port}`;let ready=false;for(let i=0;i<60;i++){try{const response=await fetch(base+'/health/ready');if(response.ok){ready=true;break;}}catch{}await delay(100);}assert.ok(ready,'ingestion did not become ready');
 const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lC8AAAAASUVORK5CYII=','base64');const digest=createHash('sha256').update(image).digest('hex');
 const headers={Authorization:'Bearer '+token,'Content-Type':'application/json','Idempotency-Key':'photo-smoke-001'};
 const intent={household_ref:'test-family',owner_ref:'test-owner',account_ref:null,source:'manual',file_type:'manual_evidence',reference_date:null,file_name:'sample.png',content_sha256:digest,byte_size:image.length,content_type:'image/png'};
 const accepted=await fetch(base+'/v1/uploads',{method:'POST',headers,body:JSON.stringify(intent)});assert.equal(accepted.status,202);const upload=await accepted.json() as {upload_id:string};
 const stored=await fetch(base+`/v1/uploads/${upload.upload_id}/content`,{method:'PUT',headers:{Authorization:'Bearer '+token,'Content-Type':'image/png','Content-Length':String(image.length)},body:Uint8Array.from(image)});assert.equal(stored.status,201);
 // Existing jobs used to hash the transport filename. Replays must also work for them.
 await testDb.query('UPDATE ingestion.upload_jobs SET request_hash=$2 WHERE id=$1',[upload.upload_id,createHash('sha256').update(JSON.stringify(intent)).digest('hex')]);
 for(const name of ['sample.png','telegram-other-name.png']){
  const retried=await fetch(base+'/v1/uploads',{method:'POST',headers,body:JSON.stringify({...intent,file_name:name})});assert.equal(retried.status,202);assert.equal((await retried.json() as {upload_id:string}).upload_id,upload.upload_id);
  const again=await fetch(base+`/v1/uploads/${upload.upload_id}/content`,{method:'PUT',headers:{Authorization:'Bearer '+token,'Content-Type':'image/png','Content-Length':String(image.length)},body:Uint8Array.from(image)});assert.equal(again.status,200);const body=await again.json() as {replayed:boolean;import_job_id:string;import_job_status:string};assert.equal(body.replayed,true);assert.ok(body.import_job_id);assert.equal(body.import_job_status,'queued');
 }
 for(const change of [{owner_ref:'other'}, {account_ref:'other'}, {source:'avenue',file_type:'avenue_statement',content_type:'application/pdf'}, {reference_date:'2026-11-01'}, {content_sha256:'a'.repeat(64)}]){
  const conflict=await fetch(base+'/v1/uploads',{method:'POST',headers,body:JSON.stringify({...intent,...change})});assert.equal(conflict.status,409);assert.equal((await conflict.json() as {code:string}).code,'IDEMPOTENCY_MISMATCH');
 }
 assert.equal((await testDb.query('SELECT id FROM ingestion.upload_jobs')).rowCount,1);assert.equal((await testDb.query('SELECT id FROM ingestion.import_jobs')).rowCount,1);
 const status=await fetch(base+`/v1/uploads/${upload.upload_id}`,{headers:{Authorization:'Bearer '+token,'X-Household-Ref':'test-family'}});assert.equal(status.status,200);assert.equal((await status.json() as {status:string}).status,'stored');
 const wrongScope=await fetch(base+`/v1/uploads/${upload.upload_id}`,{headers:{Authorization:'Bearer '+token,'X-Household-Ref':'another-family'}});assert.equal(wrongScope.status,404);
 const rows=await testDb.query('SELECT d.object_key,d.content_sha256 FROM ingestion.documents d');assert.equal(rows.rowCount,1);assert.equal(createHash('sha256').update(await readFile(rows.rows[0].object_key)).digest('hex'),digest);
 const pdf=Buffer.from('%PDF-1.4 synthetic fixture');const pdfHeaders={...headers,'Idempotency-Key':'avenue-smoke-001'};
 const pdfIntent={...intent,source:'avenue',file_type:'avenue_confirmation',file_name:'telegram-one.pdf',content_type:'application/pdf',byte_size:pdf.length,content_sha256:createHash('sha256').update(pdf).digest('hex')};
 const pdfAccepted=await fetch(base+'/v1/uploads',{method:'POST',headers:pdfHeaders,body:JSON.stringify(pdfIntent)});assert.equal(pdfAccepted.status,202);const pdfUpload=await pdfAccepted.json() as {upload_id:string};
 const pdfPut=()=>fetch(base+`/v1/uploads/${pdfUpload.upload_id}/content`,{method:'PUT',headers:{Authorization:'Bearer '+token,'Content-Type':'application/pdf','Content-Length':String(pdf.length)},body:Uint8Array.from(pdf)});
 assert.equal((await pdfPut()).status,201);
 const pdfAgain=await fetch(base+'/v1/uploads',{method:'POST',headers:pdfHeaders,body:JSON.stringify({...pdfIntent,file_name:'telegram-two.pdf'})});assert.equal(pdfAgain.status,202);assert.equal((await pdfAgain.json() as {upload_id:string}).upload_id,pdfUpload.upload_id);
 const pdfReplay=await pdfPut();assert.equal(pdfReplay.status,200);assert.equal((await pdfReplay.json() as {import_job_status:string}).import_job_status,'queued');
 await testDb.query(`UPDATE ingestion.import_jobs SET status='awaiting_review',parser_version='avenue-statement-v2-coverage-2026-11-06',result=$2::jsonb WHERE upload_job_id=$1`,[pdfUpload.upload_id,JSON.stringify({record_count:0,review_issues:[{code:'portfolio_total_mismatch'}]})]);
 const incomplete=(await testDb.query('SELECT id FROM ingestion.import_jobs WHERE upload_job_id=$1',[pdfUpload.upload_id])).rows[0].id;
 const incompleteAck=await fetch(base+`/v1/import-jobs/${incomplete}/acknowledge`,{method:'POST',headers:{Authorization:'Bearer '+token,'X-Household-Ref':'test-family'}});assert.equal(incompleteAck.status,200);assert.equal((await incompleteAck.json() as {status:string}).status,'evidence_archived');
 const pdfChanged=await fetch(base+'/v1/uploads',{method:'POST',headers:pdfHeaders,body:JSON.stringify({...pdfIntent,file_type:'avenue_statement'})});assert.equal(pdfChanged.status,409);
 const pdfConflict=await pdfChanged.json() as {details:{changed_fields:string[];previous:{upload_id:string;file_type:string;import_job_status:string}}};assert.deepEqual(pdfConflict.details.changed_fields,['file_type']);assert.equal(pdfConflict.details.previous.upload_id,pdfUpload.upload_id);assert.equal(pdfConflict.details.previous.file_type,'avenue_confirmation');assert.equal(pdfConflict.details.previous.import_job_status,'evidence_archived');
 const outside=await fetch(base+'/v1/uploads',{method:'POST',headers:pdfHeaders,body:JSON.stringify({...pdfIntent,household_ref:'another-family'})});assert.equal(outside.status,409);assert.deepEqual((await outside.json() as {details:object}).details,{});
 const stmtHeaders={...headers,'Idempotency-Key':'avenue-statement-old-01'};const stmtIntent={...pdfIntent,file_type:'avenue_statement',file_name:'old-statement.pdf'};
 const stmtStart=await fetch(base+'/v1/uploads',{method:'POST',headers:stmtHeaders,body:JSON.stringify(stmtIntent)});assert.equal(stmtStart.status,202);const stmtUpload=(await stmtStart.json() as {upload_id:string}).upload_id;
 const stmtStored=await fetch(base+`/v1/uploads/${stmtUpload}/content`,{method:'PUT',headers:{Authorization:'Bearer '+token,'Content-Type':'application/pdf','Content-Length':String(pdf.length)},body:Uint8Array.from(pdf)});assert.equal(stmtStored.status,201);const stmtResult=await stmtStored.json() as {document_id:string;import_job_id:string};
 await testDb.query(`UPDATE ingestion.import_jobs SET status='evidence_archived',parser_version='avenue-statement-v1-2026-10-22' WHERE id=$1`,[stmtResult.import_job_id]);
 const reprocess=()=>fetch(base+`/v1/documents/${stmtResult.document_id}/reprocess-avenue`,{method:'POST',headers:{Authorization:'Bearer '+token,'X-Household-Ref':'test-family','X-Owner-Ref':'test-owner'}});
 const responses=await Promise.all([reprocess(),reprocess()]);assert.deepEqual(responses.map(r=>r.status).sort(),[200,202]);
 const bodies=await Promise.all(responses.map(r=>r.json() as Promise<{import_job_id:string;replayed:boolean}>));assert.equal(bodies[0].import_job_id,bodies[1].import_job_id);assert.equal(bodies.filter(r=>r.replayed).length,1);
 const second=await reprocess();assert.equal(second.status,200);const secondResult=await second.json() as {import_job_id:string;replayed:boolean};assert.equal(secondResult.import_job_id,bodies[0].import_job_id);assert.equal(secondResult.replayed,true);
 const foreign=await fetch(base+`/v1/documents/${stmtResult.document_id}/reprocess-avenue`,{method:'POST',headers:{Authorization:'Bearer '+token,'X-Household-Ref':'other-family','X-Owner-Ref':'test-owner'}});assert.equal(foreign.status,404);
 assert.equal((await testDb.query('SELECT id FROM ingestion.import_jobs WHERE assignment_id=(SELECT assignment_id FROM ingestion.upload_jobs WHERE id=$1)',[stmtUpload])).rowCount,2);
 const documentId=randomUUID(),assignmentId=randomUUID(),uploadJobId=randomUUID(),importJobId=randomUUID(),jobHash='a'.repeat(64),parser='b3-test-v1',rowHash='c'.repeat(64);
 await testDb.query('INSERT INTO ingestion.documents(id,content_sha256,byte_size,content_type,object_key) VALUES($1,$2,1,$3,$4)',[documentId,jobHash,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',join(root,'b3.xlsx')]);
 await testDb.query("INSERT INTO ingestion.document_assignments(id,document_id,household_ref,owner_ref,source,file_type,reference_date) VALUES($1,$2,'test-family','test-owner','b3','positions','2026-10-21')",[assignmentId,documentId]);
 await testDb.query("INSERT INTO ingestion.upload_jobs(id,request_key,request_hash,household_ref,owner_ref,source,file_type,reference_date,file_name,content_sha256,expected_size,content_type,status,document_id,assignment_id) VALUES($1,'b3-smoke',$2,'test-family','test-owner','b3','positions','2026-10-21','b3.xlsx',$2,1,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','stored',$3,$4)",[uploadJobId,jobHash,documentId,assignmentId]);
 await testDb.query("INSERT INTO ingestion.import_jobs(id,upload_job_id,document_id,assignment_id,status,parser_version,result) VALUES($1,$2,$3,$4,'awaiting_review',$5,$6)",[importJobId,uploadJobId,documentId,assignmentId,parser,JSON.stringify({record_count:1})]);
 await testDb.query('INSERT INTO ingestion.raw_records(import_job_id,source_ordinal,record_kind,original,original_sha256,parser_version) VALUES($1,2,\'position\',$2,$3,$4)',[importJobId,JSON.stringify({Produto:'PETR4'}),rowHash,parser]);
 const archived=await fetch(base+`/v1/import-jobs/${importJobId}/acknowledge`,{method:'POST',headers:{Authorization:'Bearer '+token,'X-Household-Ref':'test-family'}});assert.equal(archived.status,200);const archivedBody=await archived.json() as {status:string;portfolio_published:boolean};assert.equal(archivedBody.status,'evidence_archived');assert.equal(archivedBody.portfolio_published,false);
 const replay=await fetch(base+`/v1/import-jobs/${importJobId}/acknowledge`,{method:'POST',headers:{Authorization:'Bearer '+token,'X-Household-Ref':'test-family'}});assert.equal(replay.status,200);const replayBody=await replay.json() as {status:string;portfolio_published:boolean;replayed:boolean};assert.equal(replayBody.status,'evidence_archived');assert.equal(replayBody.portfolio_published,false);assert.equal(replayBody.replayed,true);
 // A previously unsupported HEIC is reprocessed as a new immutable OCR job.
 const heic=await readFile(new URL('./fixtures/synthetic-gray-32.heic',import.meta.url)),heicHash=createHash('sha256').update(heic).digest('hex');
 const heicIntent={...intent,file_name:'synthetic.heic',content_sha256:heicHash,byte_size:heic.length,content_type:'image/heic'};
 const heicStart=await fetch(base+'/v1/uploads',{method:'POST',headers:{...headers,'Idempotency-Key':'heic-synthetic-001'},body:JSON.stringify(heicIntent)});assert.equal(heicStart.status,202);const heicId=(await heicStart.json() as {upload_id:string}).upload_id;
 const heicStored=await fetch(base+`/v1/uploads/${heicId}/content`,{method:'PUT',headers:{Authorization:'Bearer '+token,'Content-Type':'image/heic','Content-Length':String(heic.length)},body:Uint8Array.from(heic)});assert.equal(heicStored.status,201);
 await testDb.query("UPDATE ingestion.import_jobs SET status='awaiting_review',parser_version='old-unsupported-v1',result=$2 WHERE upload_job_id=$1",[heicId,JSON.stringify({ocr_status:'unsupported_image_format'})]);
 await testDb.query("UPDATE ingestion.import_jobs j SET status='awaiting_review' FROM ingestion.upload_jobs u WHERE j.upload_job_id=u.id AND u.source='manual' AND u.id<>$1 AND j.status='queued'",[heicId]);
 async function runOcr(){const worker=spawn(process.execPath,['--experimental-strip-types','services/ingestion/src/manual-ocr-worker.ts','--once'],{cwd:new URL('../../../',import.meta.url),env:{...process.env,JUANCA_DATABASE:database,JUANCA_INGESTION_CONFIG:config},stdio:'inherit'});const exit=await new Promise<number|null>((resolve,reject)=>{worker.once('error',reject);worker.once('exit',resolve);});assert.equal(exit,0);}
 await runOcr();await runOcr();
 const ocr=await testDb.query("SELECT status,parser_version,result FROM ingestion.import_jobs WHERE upload_job_id=$1 ORDER BY created_at DESC",[heicId]);assert.equal(ocr.rowCount,2);assert.equal(ocr.rows[0].status,'awaiting_review');assert.equal(ocr.rows[0].result.ocr_status,'completed');assert.equal(ocr.rows[0].result.source_content_sha256,heicHash);assert.equal(ocr.rows[0].result.conversion.width,32);assert.equal(ocr.rows[0].result.portfolio_changed,false);
 const original=await fetch(base+`/v1/documents/${(await heicStored.json() as {document_id:string}).document_id}/content`,{headers:{Authorization:'Bearer '+token,'X-Household-Ref':'test-family'}});assert.equal(createHash('sha256').update(Buffer.from(await original.arrayBuffer())).digest('hex'),heicHash);
 for(let n=0;n<51;n++)await testDb.query("INSERT INTO ingestion.upload_jobs(id,request_key,request_hash,household_ref,owner_ref,source,file_type,file_name,content_sha256,expected_size,content_type,status,created_at) VALUES($1,$2,$3,'page-family','owner','manual','manual_evidence','fixture.png',$3,1,'image/png','awaiting_upload','2026-01-01'::timestamptz+$4*interval '1 second')",[randomUUID(),'photo-page-'+n,'f'.repeat(64),n]);
 const pageHeaders={Authorization:'Bearer '+token,'X-Household-Ref':'page-family'};
 const firstPage=await (await fetch(base+'/v1/manual-evidence/photos?limit=50',{headers:pageHeaders})).json() as {items:Array<{upload_id:string}>;next_cursor:string|null};assert.equal(firstPage.items.length,50);assert.ok(firstPage.next_cursor);
 const secondPage=await (await fetch(base+'/v1/manual-evidence/photos?limit=50&cursor='+encodeURIComponent(firstPage.next_cursor!),{headers:pageHeaders})).json() as {items:Array<{upload_id:string}>;next_cursor:string|null};assert.equal(secondPage.items.length,1);assert.equal(secondPage.next_cursor,null);assert.equal(new Set([...firstPage.items,...secondPage.items].map(x=>x.upload_id)).size,51);
 const emptyPage=await (await fetch(base+'/v1/manual-evidence/photos?limit=50',{headers:{...pageHeaders,'X-Household-Ref':'another-family'}})).json() as {items:unknown[]};assert.equal(emptyPage.items.length,0);
 console.log(JSON.stringify({photo_upload_verified:true,isolated_database:true}));
}finally{
 if(child){child.kill('SIGTERM');await delay(150);if(child.exitCode===null)child.kill('SIGKILL');}
 await testDb.end().catch(()=>{});if(database.match(/^juanca_ingestion_test_[0-9a-f]+$/)&&adminConnected)await admin.query('DROP DATABASE IF EXISTS "'+database+'" WITH (FORCE)').catch(()=>{});await admin.end().catch(()=>{});await rm(root,{recursive:true,force:true});
}
