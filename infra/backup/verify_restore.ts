import {spawnSync} from 'node:child_process';
import {dirname,join} from 'node:path';
import {mkdir,readFile,writeFile,chmod,copyFile} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {pool} from '../../services/application/src/db.ts';
import {hashBackupFiles,verifyBackupManifest} from './manifest.ts';
const destination=process.argv[2];if(!destination)throw new Error('Use a new private backup directory');
await mkdir(dirname(destination),{recursive:true,mode:0o700});
await mkdir(destination,{mode:0o700});
const runtime=process.env.JUANCA_RUNTIME_ROOT??'/home/jorge/.local/share/juanca-shadow';const binary=runtime+'/runtime/root/usr/lib/postgresql/16/bin/';const socket=process.env.JUANCA_PG_SOCKET??runtime+'/socket';
const env={...process.env,LD_LIBRARY_PATH:runtime+'/runtime/root/usr/lib/x86_64-linux-gnu'+(process.env.LD_LIBRARY_PATH?':'+process.env.LD_LIBRARY_PATH:'')};
function tool(command:string,args:string[]){const r=spawnSync(binary+command,args,{env,encoding:'utf8'});if(r.status!==0)throw new Error('POSTGRES_BACKUP_TOOL_FAILED:'+command);}
const source=pool();const ingestion=pool('juanca_ingestion');const market=pool('juanca_market');const admin=pool('jorge','postgres');const database='juanca_restore_'+randomUUID().replaceAll('-','');const restored=pool('juanca_app',database);const restoredIngestion=pool('juanca_ingestion',database);const restoredMarket=pool('juanca_market',database);
try{
 tool('pg_dump',['-h',socket,'-p','55432','-U','juanca_app','-d','juanca_shadow','-n','app','-Fc','--no-owner','--no-acl','-f',destination+'/application.dump']);
 await chmod(destination+'/application.dump',0o600);
 const digest=createHash('sha256').update(await readFile(destination+'/application.dump')).digest('hex');
 const ingestionPresent=Boolean((await ingestion.query("SELECT to_regclass('ingestion.documents') AS name")).rows[0].name);
 if(ingestionPresent){tool('pg_dump',['-h',socket,'-p','55432','-U','juanca_ingestion','-d','juanca_shadow','-n','ingestion','-Fc','--no-owner','--no-acl','-f',destination+'/ingestion.dump']);await chmod(destination+'/ingestion.dump',0o600);}
 const marketPresent=Boolean((await market.query("SELECT to_regclass('market.schema_migrations') AS name")).rows[0].name);
 if(marketPresent){tool('pg_dump',['-h',socket,'-p','55432','-U','juanca_market','-d','juanca_shadow','-n','market','-Fc','--no-owner','--no-acl','-f',destination+'/market.dump']);await chmod(destination+'/market.dump',0o600);await writeFile(destination+'/market.json',await readFile(runtime+'/market.json'),{mode:0o600});}
 await writeFile(destination+'/roles.sql',await readFile(new URL('../postgres/roles.sql',import.meta.url)),{mode:0o600});
 await writeFile(destination+'/application.json',await readFile(runtime+'/application.json'),{mode:0o600});
 await admin.query('CREATE DATABASE "'+database+'"');await admin.query('GRANT CREATE ON DATABASE "'+database+'" TO juanca_app,juanca_ingestion,juanca_market');
 tool('pg_restore',['-h',socket,'-p','55432','-U','juanca_app','-d',database,'--no-owner','--no-acl','--exit-on-error',destination+'/application.dump']);
 if(ingestionPresent)tool('pg_restore',['-h',socket,'-p','55432','-U','juanca_ingestion','-d',database,'--no-owner','--no-acl','--exit-on-error',destination+'/ingestion.dump']);
 if(marketPresent)tool('pg_restore',['-h',socket,'-p','55432','-U','juanca_market','-d',database,'--no-owner','--no-acl','--exit-on-error',destination+'/market.dump']);
 await admin.query('REVOKE CREATE ON DATABASE "'+database+'" FROM juanca_app,juanca_ingestion,juanca_market');
 const names=await source.query("SELECT tablename FROM pg_tables WHERE schemaname='app' ORDER BY tablename");const checks:Record<string,boolean>={};
 for(const row of names.rows){const table='app."'+String(row.tablename).replaceAll('"','""')+'"';const query='SELECT row_to_json(t)::text AS payload FROM '+table+' t ORDER BY row_to_json(t)::text';const a=await source.query(query);const b=await restored.query(query);checks[row.tablename]=JSON.stringify(a.rows)===JSON.stringify(b.rows);}
 if(!Object.values(checks).every(Boolean))throw new Error('RESTORE_DATA_MISMATCH');
 const ingestionChecks:Record<string,boolean>={};const ingestionObjects:Record<string,string>={};
 if(ingestionPresent){
  const names=await ingestion.query("SELECT tablename FROM pg_tables WHERE schemaname='ingestion' ORDER BY tablename");
  for(const row of names.rows){const table='ingestion."'+String(row.tablename).replaceAll('"','""')+'"';const query='SELECT row_to_json(t)::text AS payload FROM '+table+' t ORDER BY row_to_json(t)::text';const a=await ingestion.query(query),b=await restoredIngestion.query(query);ingestionChecks[row.tablename]=JSON.stringify(a.rows)===JSON.stringify(b.rows);}
  if(!Object.values(ingestionChecks).every(Boolean))throw new Error('INGESTION_RESTORE_DATA_MISMATCH');
  const cfg=JSON.parse(await readFile(runtime+'/ingestion.json','utf8')) as {object_root:string};await writeFile(destination+'/ingestion.json',JSON.stringify(cfg),{mode:0o600});
  const objects=await ingestion.query('SELECT content_sha256,object_key FROM ingestion.documents ORDER BY content_sha256');
  for(const row of objects.rows){const digest=String(row.content_sha256),expected=join(cfg.object_root,'objects',digest.slice(0,2),digest);if(String(row.object_key)!==expected)throw new Error('INVALID_INGESTION_OBJECT_KEY');const bytes=await readFile(expected);if(createHash('sha256').update(bytes).digest('hex')!==digest)throw new Error('INGESTION_OBJECT_HASH_MISMATCH');const dir=join(destination,'ingestion-objects',digest.slice(0,2));await mkdir(dir,{recursive:true,mode:0o700});const target=join(dir,digest);await copyFile(expected,target);await chmod(target,0o600);if(createHash('sha256').update(await readFile(target)).digest('hex')!==digest)throw new Error('BACKUP_INGESTION_HASH_MISMATCH');ingestionObjects[digest]=digest;}
 }
 const marketChecks:Record<string,boolean>={};if(marketPresent){const names=await market.query("SELECT tablename FROM pg_tables WHERE schemaname='market' ORDER BY tablename");for(const row of names.rows){const table='market."'+String(row.tablename).replaceAll('"','""')+'"',query='SELECT row_to_json(t)::text AS payload FROM '+table+' t ORDER BY row_to_json(t)::text';const a=await market.query(query),b=await restoredMarket.query(query);marketChecks[row.tablename]=JSON.stringify(a.rows)===JSON.stringify(b.rows);}if(!Object.values(marketChecks).every(Boolean))throw new Error('MARKET_RESTORE_DATA_MISMATCH');}
 const sourceDocs=await source.query("SELECT DISTINCT storage_key,content_sha256 FROM app.source_documents WHERE source_system='B3' ORDER BY storage_key");
 const copied:Record<string,string>={},linked:Record<string,string>={};if(sourceDocs.rowCount){const archive=join(destination,'evidence','b3');await mkdir(archive,{recursive:true,mode:0o700});
  for(const row of sourceDocs.rows){const key=String(row.storage_key),expected=String(row.content_sha256);if(key.startsWith('ingestion:')){const id=key.slice('ingestion:'.length);if(!/^[0-9a-f-]{36}$/.test(id))throw new Error('INVALID_INGESTION_EVIDENCE_KEY');const original=await ingestion.query('SELECT content_sha256 FROM ingestion.documents WHERE id=$1',[id]),copy=await restoredIngestion.query('SELECT content_sha256 FROM ingestion.documents WHERE id=$1',[id]);if(original.rows[0]?.content_sha256!==expected||copy.rows[0]?.content_sha256!==expected)throw new Error('INGESTION_EVIDENCE_LINK_MISMATCH');linked[id]=expected;continue;}if(!/^[0-9a-f]{64}\.xlsx$/.test(key)||key!==expected+'.xlsx')throw new Error('INVALID_EVIDENCE_KEY');
   const original=join(runtime,'evidence','b3',key),copy=join(archive,key),actual=createHash('sha256').update(await readFile(original)).digest('hex');if(actual!==expected)throw new Error('SOURCE_EVIDENCE_HASH_MISMATCH');
   await copyFile(original,copy);await chmod(copy,0o600);if(createHash('sha256').update(await readFile(copy)).digest('hex')!==expected)throw new Error('BACKUP_EVIDENCE_HASH_MISMATCH');copied[key]=expected;
  }
 }
 await writeFile(destination+'/manifest.json',JSON.stringify({format:5,sha256:digest,ingestion_sha256:ingestionPresent?createHash('sha256').update(await readFile(destination+'/ingestion.dump')).digest('hex'):null,market_sha256:marketPresent?createHash('sha256').update(await readFile(destination+'/market.dump')).digest('hex'):null,scope:'application, ingestion and market schemas and registered bytes; legacy R2 is not included',restoration_verified:true,table_checks:checks,ingestion_table_checks:ingestionChecks,market_table_checks:marketChecks,evidence_files:copied,ingestion_links:linked,ingestion_objects:ingestionObjects,files_sha256:await hashBackupFiles(destination),created_at:new Date().toISOString()},null,2),{mode:0o600});const files=await verifyBackupManifest(destination);console.log(JSON.stringify({backup_verified:true,manifest_files:files.files,restored_tables:names.rowCount,ingestion_tables:Object.keys(ingestionChecks).length,market_tables:Object.keys(marketChecks).length,b3_evidence_files:sourceDocs.rowCount,ingestion_objects:Object.keys(ingestionObjects).length,private_directory:destination}));
}finally{
 await source.end();await ingestion.end();await market.end();await restored.end();await restoredIngestion.end();await restoredMarket.end();await admin.query('DROP DATABASE IF EXISTS "'+database+'"');await admin.end();
}
