import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {pool} from '../../services/application/src/db.ts';
import {verifyBackupManifest} from '../backup/manifest.ts';

const [backup,envelope,legacy,report]=process.argv.slice(2);
if(!report)throw new Error('Usage: node --experimental-strip-types infra/migration/reconcile_isolated.ts backup-dir envelope.json legacy-module private-report.json');
const check=await verifyBackupManifest(backup);
if(check.files<10)throw new Error('BACKUP_MANIFEST_INCOMPLETE');
const manifest=JSON.parse(await readFile(join(backup,'manifest.json'),'utf8')) as {format:number;ingestion_sha256:string|null;market_sha256:string|null;ingestion_table_checks:Record<string,boolean>;market_table_checks:Record<string,boolean>};
if(manifest.format!==5||!manifest.ingestion_sha256||!manifest.market_sha256)throw new Error('COMPLETE_SHADOW_BACKUP_REQUIRED');
const envelopeData=JSON.parse(await readFile(envelope,'utf8')) as {source_sha256:string;exported_at:string};
const runtime=process.env.JUANCA_RUNTIME_ROOT??'/home/jorge/.local/share/juanca-shadow';
const binary=join(runtime,'runtime/root/usr/lib/postgresql/16/bin');
const socket=process.env.JUANCA_PG_SOCKET??join(runtime,'socket');
const env={...process.env,LD_LIBRARY_PATH:join(runtime,'runtime/root/usr/lib/x86_64-linux-gnu')+(process.env.LD_LIBRARY_PATH?`:${process.env.LD_LIBRARY_PATH}`:'')};
function tool(command:string,args:string[]){const r=spawnSync(join(binary,command),args,{env,encoding:'utf8'});if(r.error)throw r.error;if(r.status!==0)throw new Error(`ISOLATED_RESTORE_FAILED:${command}:${r.stderr.trim()}`);return r.stdout;}
const admin=pool('jorge','postgres'),database=`juanca_reconcile_${randomUUID().replaceAll('-','')}`;
let created=false;
try{
 process.umask(0o077);await mkdir(dirname(report),{recursive:true,mode:0o700});
 await admin.query(`CREATE DATABASE "${database}"`);created=true;
 await admin.query(`GRANT CREATE ON DATABASE "${database}" TO juanca_app,juanca_ingestion,juanca_market`);
 tool('pg_restore',['-h',socket,'-p','55432','-U','juanca_app','-d',database,'--no-owner','--no-acl','--exit-on-error',join(backup,'application.dump')]);
 tool('pg_restore',['-h',socket,'-p','55432','-U','juanca_ingestion','-d',database,'--no-owner','--no-acl','--exit-on-error',join(backup,'ingestion.dump')]);
 tool('pg_restore',['-h',socket,'-p','55432','-U','juanca_market','-d',database,'--no-owner','--no-acl','--exit-on-error',join(backup,'market.dump')]);
 await admin.query(`REVOKE CREATE ON DATABASE "${database}" FROM juanca_app,juanca_ingestion,juanca_market`);
 const command=spawnSync('/home/jorge/.local/bin/node',['--experimental-strip-types','infra/migration/reconcile.ts',envelope,legacy,report],{
  cwd:process.cwd(),env:{...process.env,JUANCA_DATABASE:database},encoding:'utf8'});
 if(command.error)throw command.error;
 if(command.status!==0)throw new Error(`ISOLATED_RECONCILIATION_FAILED:${command.stderr.trim()}`);
 const parsed=JSON.parse(command.stdout.trim().split('\n').at(-1)??'{}');
 const privateReport=JSON.parse(await readFile(report,'utf8')) as {source_sha256:string;differences:unknown[];identity_complete:boolean};
 if(privateReport.source_sha256!==envelopeData.source_sha256)throw new Error('RECONCILIATION_SOURCE_MISMATCH');
 await writeFile(report,JSON.stringify(privateReport,null,2),{mode:0o600});
 const juliaResolver='infra/migration/resolve_current_b3_position_accounts.ts';
 const juliaDry=spawnSync('/home/jorge/.local/bin/node',['--experimental-strip-types',juliaResolver],{cwd:process.cwd(),env:{...env,JUANCA_DATABASE:database},encoding:'utf8'});
 if(juliaDry.error)throw juliaDry.error;
 if(juliaDry.status!==0)throw new Error(`ISOLATED_JULIA_IDENTITY_CHECK_FAILED:${juliaDry.stderr.trim()}`);
 const juliaResolution=JSON.parse(juliaDry.stdout.trim().split('\n').at(-1)??'{}');
 const juliaComplete=juliaResolution.candidates===21&&juliaResolution.ready_to_resolve===21
  &&juliaResolution.unmapped_institution===0&&juliaResolution.account_not_unique===0
  &&juliaResolution.no_exact_assertion===0&&juliaResolution.ambiguous===0&&juliaResolution.other_review_reasons===0;
 let juliaApplied:Record<string,unknown>|null=null;
 if(juliaComplete){
  const applied=spawnSync('/home/jorge/.local/bin/node',['--experimental-strip-types',juliaResolver,'--apply'],{cwd:process.cwd(),env:{...env,JUANCA_DATABASE:database},encoding:'utf8'});
  if(applied.error)throw applied.error;
  if(applied.status!==0)throw new Error(`ISOLATED_JULIA_IDENTITY_RESOLUTION_FAILED:${applied.stderr.trim()}`);
  juliaApplied=JSON.parse(applied.stdout.trim().split('\n').at(-1)??'{}');
 }
 const resolver='infra/migration/resolve_b3_position_accounts.ts';
 const resolverDry=spawnSync('/home/jorge/.local/bin/node',['--experimental-strip-types',resolver],{cwd:process.cwd(),env:{...env,JUANCA_DATABASE:database},encoding:'utf8'});
 if(resolverDry.error)throw resolverDry.error;
 if(resolverDry.status!==0)throw new Error(`ISOLATED_IDENTITY_CHECK_FAILED:${resolverDry.stderr.trim()}`);
 const resolution=JSON.parse(resolverDry.stdout.trim().split('\n').at(-1)??'{}');
 const allResolved=resolution.projection_bucket_counts_aligned===true
  &&resolution.ready_to_resolve===resolution.positions_relabeled
  &&resolution.unmapped_institution===0&&(resolution.no_unique_assertion===0
    ||(juliaComplete&&juliaApplied!==null&&resolution.no_unique_assertion===21))
  &&resolution.ambiguous===0&&resolution.account_not_unique===0;
 let resolutionApplied:Record<string,unknown>|null=null,identityComplete=privateReport.identity_complete;
 if(allResolved&&resolution.ready_to_resolve>0){
  const applied=spawnSync('/home/jorge/.local/bin/node',['--experimental-strip-types',resolver,'--apply'],{cwd:process.cwd(),env:{...env,JUANCA_DATABASE:database},encoding:'utf8'});
  if(applied.error)throw applied.error;
  if(applied.status!==0)throw new Error(`ISOLATED_IDENTITY_RESOLUTION_FAILED:${applied.stderr.trim()}`);
  resolutionApplied=JSON.parse(applied.stdout.trim().split('\n').at(-1)??'{}');
  const db=pool('juanca_app',database);try{const final=await db.query(`SELECT (v.view->>'identity_complete')::boolean AS identity_complete,
    jsonb_array_length(v.view->'positions')::int AS positions FROM app.household_state s JOIN app.portfolio_versions v
    ON v.household_id=s.household_id AND v.id=s.latest_version`);identityComplete=final.rows[0]?.identity_complete===true;}finally{await db.end();}
 }
 let identityBreakdown:unknown[]=[];
 if(resolutionApplied){const db=pool('juanca_app',database);try{const final=await db.query(`SELECT p->>'owner' owner,p->>'institution' institution,p->>'identity_status' identity_status,
   count(*)::int count FROM app.household_state s JOIN app.portfolio_versions v ON v.household_id=s.household_id AND v.id=s.latest_version,
   LATERAL jsonb_array_elements(v.view->'positions') p GROUP BY 1,2,3 ORDER BY 1,2,3`);identityBreakdown=final.rows;}finally{await db.end();}}
 console.log(JSON.stringify({isolated_reconciliation:true,backup_manifest_files:check.files,source_sha256:envelopeData.source_sha256,
  exported_at:envelopeData.exported_at,previous_count:parsed.previous_count,current_count:parsed.current_count,
  quantities_match:parsed.quantities_match,values_match:parsed.values_match,total_match:parsed.total_match,
  differences:parsed.differences,issue_codes:parsed.new_issue_codes,julia_identity_resolution_preview:juliaResolution,
  julia_identity_resolution_applied_in_isolated_database:juliaApplied,identity_resolution_preview:resolution,
  identity_resolution_applied_in_isolated_database:resolutionApplied,identity_complete_after_resolution:identityComplete,
  identity_breakdown:identityBreakdown,private_report:report,production_pointer_changed:false}));
}finally{
 if(created)await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
 await admin.end();
}
