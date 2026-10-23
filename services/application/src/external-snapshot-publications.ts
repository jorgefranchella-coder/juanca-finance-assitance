import {createHash} from 'node:crypto';
import type pg from 'pg';
import {accountId,hash,ownerId,publishInTransaction} from './migration.ts';
import {Conflict} from './commands.ts';
import {exact,minor} from './money.ts';

const KEY=/^[A-Za-z0-9._:-]{8,128}$/;
type Raw=Record<string,unknown>;
const clean=(value:unknown)=>String(value??'').trim().replace(/\s+/g,' ');
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');

export async function listExternalPositionSnapshots(db:pg.Pool,household:string){
 const result=await db.query(`SELECT d.id AS document_id,d.owner_id,o.display_name AS owner,d.source_system,d.original_name,d.content_sha256,
   d.effective_as_of::text AS effective_as_of,d.status,count(a.id)::int AS rows,
   count(*) FILTER(WHERE a.owner_id<>d.owner_id OR a.instrument_code IS NULL OR a.quantity IS NULL OR a.quantity<=0 OR ca.identity_basis='pending' OR
    (d.source_system='Avenue' AND (ca.id IS NULL OR ca.external_reference IS DISTINCT FROM NULLIF(btrim(a.raw_row->>'account'),''))) OR
    (a.custody_account_id IS NULL AND NOT (d.source_system<>'Avenue' AND a.raw_row->>'institution'=d.source_system AND regexp_replace(COALESCE(a.raw_row->>'fund_cnpj',''),'[^0-9]','','g') ~ '^[0-9]{14}$' AND a.instrument_code='PREV-'||regexp_replace(COALESCE(a.raw_row->>'fund_cnpj',''),'[^0-9]','','g'))))::int AS invalid_rows,
   bool_or(p.document_id IS NOT NULL) AS published,bool_or(d.id=latest.id) AS latest
   FROM app.source_documents d JOIN app.owners o ON o.household_id=d.household_id AND o.id=d.owner_id
   JOIN app.source_assertions a ON a.household_id=d.household_id AND a.document_id=d.id AND a.assertion_kind='position'
   LEFT JOIN app.custody_accounts ca ON ca.household_id=a.household_id AND ca.id=a.custody_account_id
   LEFT JOIN app.external_position_snapshot_publications p ON p.household_id=d.household_id AND p.document_id=d.id
   LEFT JOIN LATERAL (SELECT d2.id FROM app.source_documents d2 WHERE d2.household_id=d.household_id AND d2.owner_id=d.owner_id AND d2.source_system=d.source_system AND d2.report_kind='position'
     ORDER BY d2.effective_as_of DESC NULLS LAST,d2.registered_at DESC,d2.id DESC LIMIT 1) latest ON true
   WHERE d.household_id=$1 AND d.source_system<>'B3' AND d.report_kind='position'
   GROUP BY d.id,d.owner_id,o.display_name,d.source_system,d.original_name,d.content_sha256,d.effective_as_of,d.status,d.registered_at
   ORDER BY d.effective_as_of DESC,d.registered_at DESC LIMIT 50`,[household]);
 const current=await db.query(`SELECT v.effective_as_of::text AS portfolio_effective_as_of FROM app.household_state s
   JOIN app.portfolio_versions v ON v.household_id=s.household_id AND v.id=s.latest_version WHERE s.household_id=$1`,[household]);
 return{snapshots:result.rows,portfolio_effective_as_of:current.rows[0]?.portfolio_effective_as_of??null,mode:'shadow',authoritative:false};
}

/** Publish a complete reviewed Avenue or pension position cut, never movements or cash. */
export async function publishExternalPositionSnapshot(db:pg.Pool,household:string,actor:string,documentId:string,body:unknown){
 if(!body||typeof body!=='object'||Array.isArray(body))throw new Conflict('VALIDATION',422);
 const input=body as Record<string,unknown>;
 if(Object.keys(input).some(k=>!['request_key','content_sha256'].includes(k))||typeof input.request_key!=='string'||!KEY.test(input.request_key)||typeof input.content_sha256!=='string'||!/^[0-9a-f]{64}$/.test(input.content_sha256))throw new Conflict('VALIDATION',422);
 const c=await db.connect();
 try{
  await c.query('BEGIN');
  const member=await c.query("SELECT 1 FROM app.memberships WHERE household_id=$1 AND actor_id=$2 AND role IN ('owner','approver')",[household,actor]);if(!member.rowCount)throw new Conflict('FORBIDDEN',403);
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${household}:external-position-publication:${documentId}`]);
  const requestHash=hash(JSON.stringify([documentId,input.content_sha256]));
  const oldRequest=await c.query('SELECT document_id,request_hash,portfolio_version,position_count FROM app.external_position_snapshot_publications WHERE household_id=$1 AND actor_id=$2 AND request_key=$3',[household,actor,input.request_key]);
  if(oldRequest.rowCount){if(oldRequest.rows[0].document_id!==documentId||oldRequest.rows[0].request_hash!==requestHash)throw new Conflict('IDEMPOTENCY_MISMATCH',409);await c.query('COMMIT');return{document_id:documentId,portfolio_version:oldRequest.rows[0].portfolio_version,positions:oldRequest.rows[0].position_count,replayed:true,portfolio_published:true};}
  if((await c.query('SELECT 1 FROM app.external_position_snapshot_publications WHERE household_id=$1 AND document_id=$2',[household,documentId])).rowCount)throw new Conflict('SNAPSHOT_ALREADY_PUBLISHED',409);
  const doc=await c.query(`SELECT d.owner_id,d.source_system,d.content_sha256,d.effective_as_of::text,d.original_name,o.display_name
    FROM app.source_documents d JOIN app.owners o ON o.household_id=d.household_id AND o.id=d.owner_id
    WHERE d.household_id=$1 AND d.id=$2 AND d.source_system<>'B3' AND d.report_kind='position' FOR UPDATE OF d`,[household,documentId]);
  if(doc.rowCount!==1)throw new Conflict('NOT_FOUND',404);if(doc.rows[0].content_sha256!==input.content_sha256)throw new Conflict('STALE_SNAPSHOT',409);
  const cut=String(doc.rows[0].effective_as_of??'');if(!/^\d{4}-\d{2}-\d{2}$/.test(cut))throw new Conflict('REFERENCE_DATE_REQUIRED',422);
  const sourceSystem=String(doc.rows[0].source_system),owner=String(doc.rows[0].owner_id),ownerName=String(doc.rows[0].display_name);
  const state=await c.query(`SELECT s.latest_version,s.facts_revision,v.run_id,v.effective_as_of::text AS effective_as_of FROM app.household_state s
    JOIN app.portfolio_versions v ON v.household_id=s.household_id AND v.id=s.latest_version WHERE s.household_id=$1 FOR UPDATE OF s`,[household]);
  if(state.rowCount!==1||!state.rows[0].run_id)throw new Conflict('PUBLISHED_BASELINE_REQUIRED',409);
  const latestSource=await c.query(`SELECT id FROM app.source_documents WHERE household_id=$1 AND owner_id=$2 AND source_system=$3 AND report_kind='position'
    ORDER BY effective_as_of DESC NULLS LAST,registered_at DESC,id DESC LIMIT 1`,[household,owner,sourceSystem]);
  const priorPublished=await c.query(`SELECT max(d.effective_as_of)::text AS effective_as_of FROM app.external_position_snapshot_publications p
    JOIN app.source_documents d ON d.household_id=p.household_id AND d.id=p.document_id WHERE p.household_id=$1 AND d.owner_id=$2 AND d.source_system=$3`,[household,owner,sourceSystem]);
  if(String(latestSource.rows[0]?.id??'')!==documentId||cut<String(priorPublished.rows[0]?.effective_as_of??''))throw new Conflict('HISTORICAL_SNAPSHOT_REQUIRES_CORRECTION_FLOW',409);
  const publicationAsOf=cut>String(state.rows[0].effective_as_of)?cut:String(state.rows[0].effective_as_of);
  const source=await c.query(`SELECT a.id,a.owner_id AS assertion_owner_id,a.source_sheet,a.source_row,a.custody_account_id,a.instrument_code,a.quantity::text,a.asserted_on::text,a.raw_row,
      ca.owner_id,ca.institution_id,ca.external_reference,ca.identity_basis,ci.kind AS institution_kind
    FROM app.source_assertions a LEFT JOIN app.custody_accounts ca ON ca.household_id=a.household_id AND ca.id=a.custody_account_id
    LEFT JOIN app.custody_institutions ci ON ci.id=ca.institution_id
    WHERE a.household_id=$1 AND a.document_id=$2 AND a.assertion_kind='position' ORDER BY a.source_sheet,a.source_row`,[household,documentId]);
  if(!source.rowCount)throw new Conflict('EMPTY_POSITION_SNAPSHOT',422);
  const seen=new Set<string>(),rows=[] as Array<{id:string;assertion:string;account:string;custody:string;code:string;currency:string;quantity:string;unitPrice:string;marketMinor:string;assetClass:string;payload:Raw}>;
  for(const row of source.rows){
   const raw=row.raw_row as Raw;if(String(row.asserted_on??'')!==cut)throw new Conflict('POSITION_REFERENCE_DATE_MISMATCH',422);
   let custody=String(row.custody_account_id??''),institution=String(row.institution_id??''),custodyOwner=String(row.owner_id??''),identityBasis=String(row.identity_basis??'');
   if(sourceSystem==='Avenue'&&(institution!=='avenue-securities'||String(row.external_reference??'')!==clean(raw.account)))throw new Conflict('CUSTODY_INSTITUTION_OR_ACCOUNT_MISMATCH',422);
   if(sourceSystem!=='Avenue'&&!custody){
    const provider=clean(raw.institution),cnpj=String(raw.fund_cnpj??'').replace(/\D/g,'');if(provider!==sourceSystem||!/^\d{14}$/.test(cnpj)||String(row.instrument_code)!==`PREV-${cnpj}`)throw new Conflict('PENSION_PROVIDER_OR_FUND_UNRESOLVED',422);
    institution='pension-provider-'+sha(provider.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase()).slice(0,24);
    await c.query("INSERT INTO app.custody_institutions(id,canonical_name,kind) VALUES($1,$2,'pension_provider') ON CONFLICT(id) DO NOTHING",[institution,provider]);
    const providerCheck=await c.query('SELECT canonical_name,kind FROM app.custody_institutions WHERE id=$1',[institution]);if(providerCheck.rows[0]?.canonical_name!==provider||providerCheck.rows[0]?.kind!=='pension_provider')throw new Conflict('PENSION_PROVIDER_ID_CONFLICT');
    custody='custody-'+sha([household,owner,institution,cnpj].join('|')).slice(0,32);
    await c.query(`INSERT INTO app.custody_accounts(household_id,id,owner_id,institution_id,external_reference,identity_basis) VALUES($1,$2,$3,$4,$5,'observed_reference') ON CONFLICT(household_id,id) DO NOTHING`,[household,custody,owner,institution,cnpj]);
    custodyOwner=owner;identityBasis='observed_reference';
   }
   if(!custody||custodyOwner!==owner||row.assertion_owner_id!==owner||identityBasis==='pending')throw new Conflict('CUSTODY_ACCOUNT_UNRESOLVED',422);
   if(sourceSystem!=='Avenue'&&String(row.institution_kind??'pension_provider')!=='pension_provider')throw new Conflict('PENSION_PROVIDER_UNRESOLVED',422);
   const code=String(row.instrument_code??'').trim(),quantity=exact(String(row.quantity??'0'));if(!code||!quantity.gt(0))throw new Conflict('POSITION_IDENTITY_OR_QUANTITY_INVALID',422);
   const currency=String(raw.currency??(sourceSystem==='Avenue'?'USD':'BRL'));if(!['BRL','USD'].includes(currency))throw new Conflict('UNSUPPORTED_CURRENCY',422);
   if(sourceSystem==='Avenue'&&raw.asset_class==='cash')continue;
   const market=sourceSystem==='Avenue'?exact(String(raw.market_value_minor??'0')):exact(String(raw.market_value??'0')).mul(100);
   const unitPrice=exact(String(raw.unit_price??'0'));if(!market.gt(0)||!unitPrice.gt(0))throw new Conflict('POSITION_MARKET_VALUE_MISSING',422);
   const account=accountId(JSON.stringify([ownerName,'custody:'+custody])),key=`${account}\0${code}\0${currency}`;if(seen.has(key))throw new Conflict('DUPLICATE_ACCOUNT_INSTRUMENT',422);seen.add(key);
   const assetClass=sourceSystem==='Avenue'?String(raw.asset_class??'international_equity'):'private_pension';
   if(sourceSystem==='Avenue'&&!['international_equity','international_fixed_income','money_market'].includes(assetClass))throw new Conflict('UNSUPPORTED_AVENUE_ASSET_CLASS',422);
   const payload={kind:'position',owner:ownerName,asset_class:assetClass,product_name:clean(raw.product_name)||code,institution:sourceSystem==='Avenue'?'Avenue':clean(raw.institution)||sourceSystem,account:clean(raw.account)||String(row.external_reference??''),instrument_code:code,quantity:quantity.toFixed(),unit_price:unitPrice.toFixed(),market_value_minor:minor(market),currency,reference_date:cut,source:sourceSystem==='Avenue'?'avenue_statement':'pension_statement',issuer:clean(raw.fund)||null};
   rows.push({id:`${documentId}:${row.source_sheet}:${row.source_row}`,assertion:String(row.id),account,custody,code,currency,quantity:quantity.toFixed(),unitPrice:unitPrice.toFixed(),marketMinor:minor(market),assetClass,payload});
  }
  if(!rows.length)throw new Conflict('EMPTY_INVESTED_POSITION_SNAPSHOT',422);
  const accounts=[...new Set(rows.map(row=>row.account))],custodies=[...new Set(rows.map(row=>row.custody))];
  const later=await c.query(`SELECT count(*)::int AS total FROM app.events WHERE household_id=$1 AND account_id=ANY($2::text[]) AND application_status='applied' AND effective_date>$3::date`,[household,accounts,cut]);if(later.rows[0].total)throw new Conflict('POST_SNAPSHOT_APPLIED_EVENT_PRESENT',409);
  const run=String(state.rows[0].run_id),baseOrdinal=Number((await c.query('SELECT COALESCE(max(source_ordinal),0)+1 AS n FROM app.received_sources WHERE run_id=$1',[run])).rows[0].n),importId=`externalpub-${documentId}`;
  const now=new Date().toISOString(),createdAt=now.replace('T',' ').replace('Z','');const importRow={id:importId,user_id:household,owner:ownerName,status:'processed',file_type:sourceSystem==='Avenue'?'avenue_statement':'pension_statement',file_name:String(doc.rows[0].original_name),sha256:String(doc.rows[0].content_sha256),reference_date:cut,created_at:createdAt,source:sourceSystem};
  const saveSource=async(id:string,table:string,value:Raw,ordinal:number)=>c.query('INSERT INTO app.received_sources(run_id,id,household_id,source_table,original,sha256,source_ordinal) VALUES($1,$2,$3,$4,$5,$6,$7)',[run,`${table}:${id}`,household,table,JSON.stringify(value),sha(JSON.stringify(value)),ordinal]);
  await saveSource(importId,'imports',importRow,baseOrdinal);
  for(let index=0;index<rows.length;index++){
   const row=rows[index],record={id:row.id,import_id:importId,user_id:household,record_kind:'position',payload:JSON.stringify(row.payload)};
   await saveSource(row.id,'import_records',record,baseOrdinal+index+1);
   const scope=JSON.stringify([ownerName,'custody:'+row.custody]);
   await c.query(`INSERT INTO app.accounts(household_id,id,owner_id,source_scope,identity_status) VALUES($1,$2,$3,$4,'known') ON CONFLICT(household_id,id) DO NOTHING`,[household,row.account,owner,scope]);
   const canonical=await c.query('SELECT owner_id,source_scope,identity_status FROM app.accounts WHERE household_id=$1 AND id=$2',[household,row.account]);if(canonical.rows[0]?.owner_id!==owner||canonical.rows[0]?.source_scope!==scope||canonical.rows[0]?.identity_status!=='known')throw new Conflict('CANONICAL_ACCOUNT_CONFLICT');
   const snapshotId=importId+':'+row.id;
   await c.query(`INSERT INTO app.snapshots(run_id,household_id,id,owner_id,account_id,effective_date,known_at,source_type,scope_status) VALUES($1,$2,$3,$4,$5,$6,$7,'positions','resolved')`,[run,household,snapshotId,ownerId(ownerName),row.account,cut,now]);
   await c.query(`INSERT INTO app.position_account_resolutions(run_id,household_id,source_record_id,resolution_version,snapshot_id,assertion_id,custody_account_id,decision,actor_id) VALUES($1,$2,$3,1,$4,$5,$6,'custody_account_reference_observed',$7)`,[run,household,row.id,snapshotId,row.assertion,row.custody,actor]);
  }
  const prior=await c.query('SELECT account_id,instrument_code,currency FROM app.holdings WHERE household_id=$1 AND account_id=ANY($2::text[])',[household,accounts]);
  for(const holding of prior.rows){const key=`${holding.account_id}\0${holding.instrument_code}\0${holding.currency}`;if(!seen.has(key))await c.query(`INSERT INTO app.holdings(household_id,account_id,instrument_code,currency,quantity,coverage_status,opening_as_of,opening_document_id,opening_assertion_id,opening_event_id) VALUES($1,$2,$3,$4,'0','verified',$5,$6,NULL,NULL) ON CONFLICT(household_id,account_id,instrument_code,currency) DO UPDATE SET quantity='0',coverage_status='verified',opening_as_of=EXCLUDED.opening_as_of,opening_document_id=EXCLUDED.opening_document_id,opening_assertion_id=NULL,opening_event_id=NULL`,[household,holding.account_id,holding.instrument_code,holding.currency,cut,documentId]);}
  for(const row of rows)await c.query(`INSERT INTO app.holdings(household_id,account_id,instrument_code,currency,quantity,coverage_status,opening_as_of,opening_document_id,opening_assertion_id,opening_event_id) VALUES($1,$2,$3,$4,$5,'verified',$6,NULL,$7,NULL) ON CONFLICT(household_id,account_id,instrument_code,currency) DO UPDATE SET quantity=EXCLUDED.quantity,coverage_status='verified',opening_as_of=EXCLUDED.opening_as_of,opening_document_id=NULL,opening_assertion_id=EXCLUDED.opening_assertion_id,opening_event_id=NULL`,[household,row.account,row.code,row.currency,row.quantity,cut,row.assertion]);
  await c.query('UPDATE app.household_state SET facts_revision=facts_revision+1 WHERE household_id=$1',[household]);
  const result=await publishInTransaction(c,run,household,publicationAsOf,now);
  await c.query(`INSERT INTO app.external_position_snapshot_publications(household_id,document_id,actor_id,request_key,request_hash,run_id,portfolio_version,position_count) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[household,documentId,actor,input.request_key,requestHash,run,result.portfolio_version,rows.length]);
  await c.query(`INSERT INTO app.audit_log(household_id,actor_id,action,resource_id,details) VALUES($1,$2,'external_position_snapshot_published',$3,$4)`,[household,actor,documentId,{source_system:sourceSystem,content_sha256:input.content_sha256,reference_date:cut,portfolio_effective_as_of:publicationAsOf,position_count:rows.length,portfolio_version:result.portfolio_version,movements_applied:false,cash_tracked:false,represented_custody_accounts:custodies}]);
  await c.query('COMMIT');return{document_id:documentId,source_system:sourceSystem,source_as_of:cut,effective_as_of:publicationAsOf,portfolio_version:result.portfolio_version,positions:rows.length,replayed:false,portfolio_published:true,mode:'shadow',authoritative:false};
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
