import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {pool} from '../../services/application/src/db.ts';
import {listB3PositionSnapshots,publishB3PositionSnapshot} from '../../services/application/src/b3-snapshot-publications.ts';
import {listExternalPositionSnapshots,publishExternalPositionSnapshot} from '../../services/application/src/external-snapshot-publications.ts';

const runtime=process.env.JUANCA_RUNTIME_ROOT??'/home/jorge/.local/share/juanca-shadow';
const config=JSON.parse(await readFile(join(runtime,'application.json'),'utf8')) as {household_id:string};
if(!config.household_id)throw new Error('HOUSEHOLD_REQUIRED');
const database='juanca_preview_'+randomUUID().replaceAll('-','').slice(0,20);
const directory=await mkdtemp(join(tmpdir(),'juanca-snapshot-preview-'));
const socket=process.env.JUANCA_PG_SOCKET??join(runtime,'socket');
const binary=join(runtime,'runtime/root/usr/lib/postgresql/16/bin');
const environment={...process.env,LD_LIBRARY_PATH:join(runtime,'runtime/root/usr/lib/x86_64-linux-gnu')};
const admin=pool('jorge','postgres'),source=pool('juanca_app'),preview=pool('juanca_app',database);
// DROP DATABASE terminates any idle connection that a pool failed to release.
preview.on('error',()=>{});
let created=false;

function run(binaryName:string,args:string[]){
 const result=spawnSync(join(binary,binaryName),args,{encoding:'utf8',timeout:120_000,env:environment});
 if(result.status!==0)throw new Error(`${binaryName.toUpperCase()}_FAILED:${(result.stderr||String(result.error)||'').slice(0,500)}`);
}

try{
 const baseline=await source.query('SELECT latest_version,facts_revision FROM app.household_state WHERE household_id=$1',[config.household_id]);
 const membership=await source.query("SELECT actor_id FROM app.memberships WHERE household_id=$1 AND role IN ('owner','approver') ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END,actor_id LIMIT 1",[config.household_id]);
 if(!membership.rowCount)throw new Error('APPROVER_ID_UNAVAILABLE');
 const actor=String(membership.rows[0].actor_id),dump=join(directory,'application.dump');
 run('pg_dump',['-h',socket,'-p','55432','-U','juanca_app','-d','juanca_shadow','-n','app','-Fc','--no-owner','--no-acl','-f',dump]);
 await admin.query(`CREATE DATABASE "${database}"`);created=true;
 await admin.query(`GRANT CREATE ON DATABASE "${database}" TO juanca_app`);
 run('pg_restore',['-h',socket,'-p','55432','-U','juanca_app','-d',database,'--no-owner','--no-acl','--exit-on-error',dump]);
 await admin.query(`REVOKE CREATE ON DATABASE "${database}" FROM juanca_app`);

 const b3=await listB3PositionSnapshots(source,config.household_id);
 const external=await listExternalPositionSnapshots(source,config.household_id);
 const candidates=[
  ...b3.snapshots.filter(row=>row.latest&&!row.published).map(row=>({kind:'B3',owner:String(row.owner),date:String(row.effective_as_of),rows:Number(row.rows),document:String(row.document_id),sha:String(row.content_sha256)})),
  ...external.snapshots.filter(row=>row.latest&&!row.published).map(row=>({kind:String(row.source_system),owner:String(row.owner),date:String(row.effective_as_of),rows:Number(row.rows),document:String(row.document_id),sha:String(row.content_sha256)})),
 ];
 const results:Record<string,unknown>[]=[];
 for(const row of candidates){
  try{
   const body={request_key:`preview-${randomUUID()}`,content_sha256:row.sha};
   const result=row.kind==='B3'
    ?await publishB3PositionSnapshot(preview,config.household_id,actor,row.document,body)
    :await publishExternalPositionSnapshot(preview,config.household_id,actor,row.document,body);
   results.push({source:row.kind,owner:row.owner,reference_date:row.date,source_rows:row.rows,preview:'passed',positions:result.positions});
  }catch(error){
   results.push({source:row.kind,owner:row.owner,reference_date:row.date,source_rows:row.rows,preview:'blocked',reason:error instanceof Error&&'code' in error?String(error.code):'VALIDATION_FAILED'});
  }
 }
 const current=await source.query('SELECT latest_version,facts_revision FROM app.household_state WHERE household_id=$1',[config.household_id]);
 if(JSON.stringify(baseline.rows)!==JSON.stringify(current.rows))throw new Error('SOURCE_VERSION_CHANGED');
 console.log(JSON.stringify({mode:'isolated_preview',source_version_unchanged:true,candidate_count:candidates.length,results}));
 if(results.some(result=>result.preview!=='passed'))process.exitCode=2;
}finally{
 await preview.end();
 await source.end();
 if(created){
  await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',[database]);
  await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
 }
 await admin.end();
 await rm(directory,{recursive:true,force:true});
}
