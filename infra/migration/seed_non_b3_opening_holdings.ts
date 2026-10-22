/** Seed invested holdings from already-transferred Avenue and pension statements. Defaults to dry-run. */
import {readFile} from 'node:fs/promises';
import {pool as applicationPool} from '../../services/application/src/db.ts';
import {pool as ingestionPool} from '../../services/ingestion/src/db.ts';
import {exact} from '../../services/application/src/money.ts';

type Json=Record<string,unknown>;
type Source={id:string;owner:string;file_type:'avenue_statement'|'pension_statement';reference_date:string;sha256:string;file_name:string;rows:Json[]};
type SeedRow={owner:string;account_id:string;instrument_code:string;currency:string;quantity:string;opening_as_of:string;document_id:string};
const configPath=process.env.JUANCA_SHADOW_CONFIG??'/home/jorge/.local/share/juanca-shadow/application.json';
const config=JSON.parse(await readFile(configPath,'utf8')) as {household_id:string};
const household=config.household_id,apply=process.argv.includes('--apply');
const app=applicationPool(),ingestion=ingestionPool();
try{
 const owners=await app.query('SELECT id,display_name FROM app.owners WHERE household_id=$1',[household]);
 const ownerByName=new Map(owners.rows.map(row=>[String(row.display_name),String(row.id)]));
 const run=await app.query('SELECT id FROM app.migration_runs ORDER BY created_at DESC LIMIT 1');
 if(!run.rowCount)throw new Error('LEGACY_SOURCE_RUN_MISSING');
 const runId=String(run.rows[0].id);
 const imported=await app.query(`SELECT original::jsonb AS row FROM app.received_sources
   WHERE household_id=$1 AND run_id=$2 AND source_table='imports' AND original::jsonb->>'status'='processed'
     AND original::jsonb->>'file_type' IN ('avenue_statement','pension_statement')`,[household,runId]);
 const latest=new Map<string,Json>();
 for(const {row} of imported.rows){const key=`${row.owner}\0${row.file_type}`,prior=latest.get(key);
   if(!prior||String(row.reference_date)>String(prior.reference_date))latest.set(key,row as Json);}
 if(latest.size!==2)throw new Error('EXPECTED_LATEST_AVENUE_AND_PENSION_IMPORTS');
 const sources:Source[]=[];
 for(const row of latest.values()){
  const owner=String(row.owner),fileType=String(row.file_type) as Source['file_type'];
  if(!ownerByName.has(owner)||!row.reference_date||!row.sha256||!row.id)throw new Error('LEGACY_IMPORT_METADATA_INCOMPLETE');
  const rawRows=await app.query(`SELECT original::jsonb->>'payload' AS payload FROM app.received_sources
    WHERE household_id=$1 AND run_id=$2 AND source_table='import_records' AND original::jsonb->>'import_id'=$3 ORDER BY source_ordinal`,[household,runId,String(row.id)]);
  const positions=rawRows.rows.map(item=>JSON.parse(String(item.payload)) as Json);
  const assetRows=positions.filter(item=>String(item.instrument_code??'')!=='USD_CASH'&&String(item.asset_class??'')!=='cash');
  if(!assetRows.length||assetRows.some(item=>!item.instrument_code||!item.currency||!item.quantity||!item.reference_date))throw new Error('LEGACY_POSITION_ROW_INCOMPLETE');
  sources.push({id:String(row.id),owner,file_type:fileType,reference_date:String(row.reference_date),sha256:String(row.sha256),file_name:String(row.file_name??''),rows:assetRows});
 }
 const evidence=await ingestion.query(`SELECT d.id::text AS document_id,d.content_sha256,d.object_key,u.file_name,da.owner_ref,da.source,da.file_type,da.reference_date::text
   FROM ingestion.documents d JOIN ingestion.document_assignments da ON da.document_id=d.id
   JOIN ingestion.import_jobs j ON j.document_id=d.id AND j.assignment_id=da.id
   JOIN ingestion.upload_jobs u ON u.id=j.upload_job_id
   WHERE da.household_ref=$1 AND da.source IN ('avenue','pension') AND da.file_type IN ('avenue_statement','pension_statement')`,[household]);
 const sourceDocs=new Map<string,{document_id:string;content_sha256:string;object_key:string;file_name:string;owner_ref:string;source:string;file_type:string;reference_date:string}>();
 for(const item of evidence.rows){const key=`${item.content_sha256}\0${item.owner_ref}\0${item.file_type}\0${item.reference_date}`;sourceDocs.set(key,item);}
 const seeds:SeedRow[]=[],documentRows:{id:string;owner_id:string;source_system:string;report_kind:string;original_name:string;sha256:string;storage_key:string;as_of:string;rows:number;cash_excluded:number}[]=[];
 for(const source of sources){
  const ownerId=ownerByName.get(source.owner)!;
  const sourceType=source.file_type==='avenue_statement'?'avenue':'pension';
  const ownerRef=ownerId;
  const doc=sourceDocs.get(`${source.sha256}\0${ownerRef}\0${source.file_type}\0${source.reference_date}`);
  if(!doc||doc.content_sha256!==source.sha256||!doc.object_key)throw new Error(`ORIGINAL_EVIDENCE_NOT_MATCHED:${source.file_type}:${source.reference_date}`);
  const accountRefs=new Set(source.rows.map(row=>String(row.account??'')).filter(Boolean));
  let accountId:string;
  if(source.file_type==='avenue_statement'){
   if(accountRefs.size!==1)throw new Error('AVENUE_ACCOUNT_NOT_UNIQUE');
   const scope=JSON.stringify([source.owner,`account:${[...accountRefs][0]}`]);
   const account=await app.query('SELECT id,identity_status FROM app.accounts WHERE household_id=$1 AND owner_id=$2 AND source_scope=$3',[household,ownerId,scope]);
   if(account.rowCount!==1||account.rows[0].identity_status!=='known')throw new Error('AVENUE_ACCOUNT_IDENTITY_NOT_VERIFIED');
   accountId=String(account.rows[0].id);
  }else{
   const institutions=new Set(source.rows.map(row=>String(row.institution??'')).filter(Boolean));
   if(institutions.size!==1)throw new Error('PENSION_PROVIDER_NOT_UNIQUE');
   const scope=JSON.stringify([source.owner,`unresolved:pension_statement:${[...institutions][0]}`]);
   const account=await app.query('SELECT id FROM app.accounts WHERE household_id=$1 AND owner_id=$2 AND source_scope=$3',[household,ownerId,scope]);
   if(account.rowCount!==1)throw new Error('PENSION_POSITION_SCOPE_NOT_FOUND');
   accountId=String(account.rows[0].id);
  }
  const docId=`legacy-position-${source.sha256.slice(0,32)}`;
  documentRows.push({id:docId,owner_id:ownerId,source_system:sourceType==='avenue'?'Avenue':String(source.rows[0].institution??'Santander Previdência'),report_kind:'position',original_name:doc.file_name,sha256:source.sha256,storage_key:`ingestion:${doc.document_id}`,as_of:source.reference_date,rows:source.rows.length,cash_excluded:(await app.query(`SELECT count(*)::int n FROM app.received_sources WHERE household_id=$1 AND run_id=$2 AND source_table='import_records' AND original::jsonb->>'import_id'=$3 AND ((original::jsonb->>'payload')::jsonb->>'instrument_code'='USD_CASH' OR (original::jsonb->>'payload')::jsonb->>'asset_class'='cash')`,[household,runId,source.id])).rows[0].n});
  for(const row of source.rows){const currency=String(row.currency),code=String(row.instrument_code),quantity=exact(String(row.quantity)).toFixed();
   if(!['BRL','USD'].includes(currency)||exact(quantity).lte(0))throw new Error('INVALID_INVESTED_POSITION');
   seeds.push({owner:source.owner,account_id:accountId,instrument_code:code,currency,quantity,opening_as_of:source.reference_date,document_id:docId});
  }
 }
 const keys=new Set<string>();for(const row of seeds){const key=[row.account_id,row.instrument_code,row.currency].join('\0');if(keys.has(key))throw new Error('DUPLICATE_OPENING_ASSET');keys.add(key);}
 const existing=await app.query(`SELECT account_id,instrument_code,currency,quantity::text,coverage_status,opening_as_of::text,opening_document_id
   FROM app.holdings WHERE household_id=$1 AND (account_id,instrument_code,currency) IN (SELECT * FROM unnest($2::text[],$3::text[],$4::text[]))`,[household,seeds.map(r=>r.account_id),seeds.map(r=>r.instrument_code),seeds.map(r=>r.currency)]);
 const byKey=new Map(existing.rows.map(row=>[[row.account_id,row.instrument_code,row.currency].join('\0'),row]));
 let insertCount=0,replayed=0;
 for(const row of seeds){const prior=byKey.get([row.account_id,row.instrument_code,row.currency].join('\0'));
  if(!prior){insertCount++;continue;}
  if(String(prior.quantity)!==row.quantity||prior.coverage_status!=='verified'||prior.opening_as_of!==row.opening_as_of||prior.opening_document_id!==row.document_id)throw new Error('EXISTING_OPENING_LEDGER_CONFLICT');
  replayed++;
 }
 const summary={mode:apply?'apply':'dry_run',source_run:runId,source_files:documentRows.map(({source_system,original_name,as_of,rows,cash_excluded})=>({source_system,original_name,as_of,invested_positions:rows,cash_excluded})),opening_positions:seeds.length,opening_rows_to_insert:insertCount,replayed,portfolio_published:false,transactions_applied:false,production_authority_changed:false};
 if(!apply){console.log(JSON.stringify(summary));process.exitCode=0;}
 else{
  const actor=await app.query("SELECT actor_id FROM app.memberships WHERE household_id=$1 AND role='migration' ORDER BY actor_id LIMIT 1",[household]);if(!actor.rowCount)throw new Error('AUDIT_ACTOR_NOT_FOUND');
  const c=await app.connect();try{await c.query('BEGIN');
   for(const doc of documentRows){
    const prior=await c.query('SELECT owner_id,source_system,content_sha256,storage_key,effective_as_of::text FROM app.source_documents WHERE household_id=$1 AND id=$2',[household,doc.id]);
    if(prior.rowCount){const p=prior.rows[0];if(p.owner_id!==doc.owner_id||p.source_system!==doc.source_system||p.content_sha256!==doc.sha256||p.storage_key!==doc.storage_key||p.effective_as_of!==doc.as_of)throw new Error('SOURCE_DOCUMENT_CONFLICT');}
    else await c.query(`INSERT INTO app.source_documents(household_id,id,owner_id,source_system,report_kind,original_name,content_sha256,storage_key,effective_as_of,date_basis)
      VALUES($1,$2,$3,$4,'position',$5,$6,$7,$8,'statement_reference_date')`,[household,doc.id,doc.owner_id,doc.source_system,doc.original_name,doc.sha256,doc.storage_key,doc.as_of]);
   }
   for(const row of seeds)if(!byKey.has([row.account_id,row.instrument_code,row.currency].join('\0')))
    await c.query(`INSERT INTO app.holdings(household_id,account_id,instrument_code,currency,quantity,coverage_status,opening_as_of,opening_document_id)
      VALUES($1,$2,$3,$4,$5,'verified',$6,$7)`,[household,row.account_id,row.instrument_code,row.currency,row.quantity,row.opening_as_of,row.document_id]);
   if(insertCount)await c.query(`INSERT INTO app.audit_log(household_id,actor_id,action,resource_id,details) VALUES($1,$2,'non_b3_invested_opening_holdings_seeded',$3,$4)`,[household,actor.rows[0].actor_id,'non-b3-invested-opening',{source_run:runId,positions:insertCount,source_documents:documentRows.map(d=>d.id),cash_excluded:true,portfolio_published:false,transactions_applied:false}]);
   await c.query('COMMIT');
  }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
  console.log(JSON.stringify({...summary,applied:true}));
 }
}finally{await app.end();await ingestion.end();}
