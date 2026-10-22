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
 try{await ing.query(await readFile(new URL('../../../infra/postgres/006_ingestion.sql',import.meta.url),'utf8'));await ing.query(await readFile(new URL('../../../infra/postgres/009_ingestion_evidence_archive_status.sql',import.meta.url),'utf8'));}finally{await ing.end();}
 const listener=createServer();await new Promise<void>(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=(listener.address() as {port:number}).port;await new Promise<void>(resolve=>listener.close(()=>resolve()));
 const token=randomBytes(32).toString('hex');const config=join(root,'config.json');await writeFile(config,JSON.stringify({token,port,object_root:join(root,'objects')}),{mode:0o600});
 child=spawn(process.execPath,['--experimental-strip-types','services/ingestion/src/server.ts'],{cwd:new URL('../../../',import.meta.url),env:{...process.env,JUANCA_DATABASE:database,JUANCA_INGESTION_CONFIG:config},stdio:'ignore'});
 const base=`http://127.0.0.1:${port}`;let ready=false;for(let i=0;i<60;i++){try{const response=await fetch(base+'/health/ready');if(response.ok){ready=true;break;}}catch{}await delay(100);}assert.ok(ready,'ingestion did not become ready');
 const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lC8AAAAASUVORK5CYII=','base64');const digest=createHash('sha256').update(image).digest('hex');
 const headers={Authorization:'Bearer '+token,'Content-Type':'application/json','Idempotency-Key':'photo-smoke-001'};
 const intent={household_ref:'test-family',owner_ref:'test-owner',account_ref:null,source:'manual',file_type:'manual_evidence',reference_date:null,file_name:'sample.png',content_sha256:digest,byte_size:image.length,content_type:'image/png'};
 const accepted=await fetch(base+'/v1/uploads',{method:'POST',headers,body:JSON.stringify(intent)});assert.equal(accepted.status,202);const upload=await accepted.json() as {upload_id:string};
 const stored=await fetch(base+`/v1/uploads/${upload.upload_id}/content`,{method:'PUT',headers:{Authorization:'Bearer '+token,'Content-Type':'image/png','Content-Length':String(image.length)},body:Uint8Array.from(image)});assert.equal(stored.status,201);
 const status=await fetch(base+`/v1/uploads/${upload.upload_id}`,{headers:{Authorization:'Bearer '+token,'X-Household-Ref':'test-family'}});assert.equal(status.status,200);assert.equal((await status.json() as {status:string}).status,'stored');
 const wrongScope=await fetch(base+`/v1/uploads/${upload.upload_id}`,{headers:{Authorization:'Bearer '+token,'X-Household-Ref':'another-family'}});assert.equal(wrongScope.status,404);
 const rows=await testDb.query('SELECT d.object_key,d.content_sha256 FROM ingestion.documents d');assert.equal(rows.rowCount,1);assert.equal(createHash('sha256').update(await readFile(rows.rows[0].object_key)).digest('hex'),digest);
 const documentId=randomUUID(),assignmentId=randomUUID(),uploadJobId=randomUUID(),importJobId=randomUUID(),jobHash='a'.repeat(64),parser='b3-test-v1',rowHash='c'.repeat(64);
 await testDb.query('INSERT INTO ingestion.documents(id,content_sha256,byte_size,content_type,object_key) VALUES($1,$2,1,$3,$4)',[documentId,jobHash,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',join(root,'b3.xlsx')]);
 await testDb.query("INSERT INTO ingestion.document_assignments(id,document_id,household_ref,owner_ref,source,file_type,reference_date) VALUES($1,$2,'test-family','test-owner','b3','positions','2026-10-21')",[assignmentId,documentId]);
 await testDb.query("INSERT INTO ingestion.upload_jobs(id,request_key,request_hash,household_ref,owner_ref,source,file_type,reference_date,file_name,content_sha256,expected_size,content_type,status,document_id,assignment_id) VALUES($1,'b3-smoke',$2,'test-family','test-owner','b3','positions','2026-10-21','b3.xlsx',$2,1,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','stored',$3,$4)",[uploadJobId,jobHash,documentId,assignmentId]);
 await testDb.query("INSERT INTO ingestion.import_jobs(id,upload_job_id,document_id,assignment_id,status,parser_version,result) VALUES($1,$2,$3,$4,'awaiting_review',$5,$6)",[importJobId,uploadJobId,documentId,assignmentId,parser,JSON.stringify({record_count:1})]);
 await testDb.query('INSERT INTO ingestion.raw_records(import_job_id,source_ordinal,record_kind,original,original_sha256,parser_version) VALUES($1,2,\'position\',$2,$3,$4)',[importJobId,JSON.stringify({Produto:'PETR4'}),rowHash,parser]);
 const archived=await fetch(base+`/v1/import-jobs/${importJobId}/acknowledge`,{method:'POST',headers:{Authorization:'Bearer '+token,'X-Household-Ref':'test-family'}});assert.equal(archived.status,200);const archivedBody=await archived.json() as {status:string;portfolio_published:boolean};assert.equal(archivedBody.status,'evidence_archived');assert.equal(archivedBody.portfolio_published,false);
 const replay=await fetch(base+`/v1/import-jobs/${importJobId}/acknowledge`,{method:'POST',headers:{Authorization:'Bearer '+token,'X-Household-Ref':'test-family'}});assert.equal(replay.status,200);const replayBody=await replay.json() as {status:string;portfolio_published:boolean;replayed:boolean};assert.equal(replayBody.status,'evidence_archived');assert.equal(replayBody.portfolio_published,false);assert.equal(replayBody.replayed,true);
 console.log(JSON.stringify({photo_upload_verified:true,isolated_database:true}));
}finally{
 if(child){child.kill('SIGTERM');await delay(150);if(child.exitCode===null)child.kill('SIGKILL');}
 await testDb.end().catch(()=>{});if(database.match(/^juanca_ingestion_test_[0-9a-f]+$/)&&adminConnected)await admin.query('DROP DATABASE IF EXISTS "'+database+'" WITH (FORCE)').catch(()=>{});await admin.end().catch(()=>{});await rm(root,{recursive:true,force:true});
}
