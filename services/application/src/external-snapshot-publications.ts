import {createHash} from 'node:crypto';
import type pg from 'pg';
import {accountId,hash,ownerId,publishInTransaction} from './migration.ts';
import {Conflict} from './commands.ts';
import {exact,minor} from './money.ts';
import {pensionIdentity,pensionCustodyId} from './pension-identity.ts';

const KEY=/^[A-Za-z0-9._:-]{8,128}$/;
type Raw=Record<string,unknown>;
const clean=(value:unknown)=>String(value??'').trim().replace(/\s+/g,' ');
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');

export async function listExternalPositionSnapshots(db:pg.Pool,household:string){
 const result=await db.query(`SELECT d.id AS document_id,d.owner_id,o.display_name AS owner,d.source_system,d.original_name,d.content_sha256,d.registered_at,
   d.effective_as_of::text AS effective_as_of,d.status,count(a.id)::int AS rows,
   jsonb_agg(jsonb_build_object('assertion_id',a.id,'identity_decision_id',pd.id,'identity_decision_revision',pd.revision,'identity_decision_locator',pd.source_locator,'instrument_code',COALESCE('PREV-'||pd.fund_cnpj,a.instrument_code),'product_name',a.raw_row->>'product_name','fund',COALESCE(pd.fund_name,a.raw_row->>'fund'),
     'fund_cnpj',COALESCE(pd.fund_cnpj,a.raw_row->>'fund_cnpj'),'plan_number',COALESCE(pd.plan_number,a.raw_row->>'plan_number'),'identity_status',a.raw_row->>'identity_status','identity_review_reasons',a.raw_row->'identity_review_reasons','identity_evidence',a.raw_row->'identity_evidence','quantity',a.quantity::text,'market_value',a.raw_row->>'market_value','gross_balance',a.raw_row->>'gross_balance','net_balance',a.raw_row->>'net_balance',
     'valuation_basis',a.raw_row->>'valuation_basis','plans',COALESCE(a.raw_row->'plans','[]'::jsonb)) ORDER BY a.source_sheet,a.source_row) AS position_details,
   count(*) FILTER(WHERE a.owner_id<>d.owner_id OR (a.instrument_code IS NULL AND pd.id IS NULL) OR a.quantity IS NULL OR a.quantity<=0 OR (ca.identity_basis='pending' AND pd.id IS NULL) OR
    (d.source_system='Avenue' AND (ca.id IS NULL OR ca.external_reference IS DISTINCT FROM NULLIF(btrim(a.raw_row->>'account'),''))) OR
    (d.source_system<>'Avenue' AND ((CASE WHEN jsonb_typeof(a.raw_row->'plans')='array' THEN jsonb_array_length(a.raw_row->'plans') ELSE 1 END)>1 OR pd.id IS NULL AND (a.interpretation_status<>'observed' OR COALESCE(a.raw_row->>'identity_status','')<>'observed' OR NULLIF(btrim(a.raw_row->>'plan_number'),'') IS NULL OR NULLIF(btrim(a.raw_row->>'fund'),'') IS NULL OR jsonb_typeof(a.raw_row->'identity_evidence') IS DISTINCT FROM 'object' OR NOT (regexp_replace(COALESCE(a.raw_row->>'fund_cnpj',''),'[^0-9]','','g') ~ '^[0-9]{14}$') OR a.instrument_code IS DISTINCT FROM 'PREV-'||regexp_replace(COALESCE(a.raw_row->>'fund_cnpj',''),'[^0-9]','','g') OR (ca.id IS NOT NULL AND ca.external_reference IS DISTINCT FROM btrim(a.raw_row->>'plan_number'))))))::int AS invalid_rows,
   bool_or(p.document_id IS NOT NULL) AS published,bool_or(d.id=latest.id) AS latest
   FROM app.source_documents d JOIN app.owners o ON o.household_id=d.household_id AND o.id=d.owner_id
   JOIN app.source_assertions a ON a.household_id=d.household_id AND a.document_id=d.id AND a.assertion_kind='position'
   LEFT JOIN app.custody_accounts ca ON ca.household_id=a.household_id AND ca.id=a.custody_account_id
   LEFT JOIN LATERAL (SELECT * FROM app.pension_identity_decisions z WHERE z.household_id=a.household_id AND z.assertion_id=a.id ORDER BY z.revision DESC LIMIT 1) pd ON d.source_system<>'Avenue'
   LEFT JOIN app.external_position_snapshot_publications p ON p.household_id=d.household_id AND p.document_id=d.id
   LEFT JOIN LATERAL (SELECT d2.id FROM app.source_documents d2 WHERE d2.household_id=d.household_id AND d2.owner_id=d.owner_id AND d2.source_system=d.source_system AND d2.report_kind='position' AND d2.status<>'superseded'
     AND EXISTS(SELECT 1 FROM app.source_assertions a2 WHERE a2.household_id=d2.household_id AND a2.document_id=d2.id AND a2.assertion_kind='position')
     ORDER BY d2.effective_as_of DESC NULLS LAST,d2.registered_at DESC,d2.id DESC LIMIT 1) latest ON true
   WHERE d.household_id=$1 AND d.source_system<>'B3' AND d.report_kind='position'
   GROUP BY d.id,d.owner_id,o.display_name,d.source_system,d.original_name,d.content_sha256,d.effective_as_of,d.status,d.registered_at
   ORDER BY d.effective_as_of DESC,d.registered_at DESC LIMIT 50`,[household]);
 const current=await db.query(`SELECT v.effective_as_of::text AS portfolio_effective_as_of,v.view,s.facts_revision::text,s.latest_version FROM app.household_state s
   JOIN app.portfolio_versions v ON v.household_id=s.household_id AND v.id=s.latest_version WHERE s.household_id=$1`,[household]);
 // Read-only preview of the exact historical balances that would otherwise
 // collide with a plan-level publication. It never alters these balances.
 for(const snapshot of result.rows){
  snapshot.legacy_positions=[];
  snapshot.legacy_basis=current.rowCount?{facts_revision:String(current.rows[0].facts_revision),portfolio_version:String(current.rows[0].latest_version)}:null;
  if(snapshot.source_system==='Avenue'||snapshot.published)continue;
  const providerId='pension-provider-'+sha(String(snapshot.source_system).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase()).slice(0,24);
  const codes=[...new Set((snapshot.position_details as Raw[]).map(row=>String(row.instrument_code??'')).filter(code=>/^PREV-\d{14}$/.test(code)))];
  for(const code of codes){
   const legacyId='custody-'+sha([household,snapshot.owner_id,providerId,code.slice(5)].join('|')).slice(0,32);
   const accounts=await db.query('SELECT id FROM app.custody_accounts WHERE household_id=$1 AND owner_id=$2 AND institution_id=$3 AND external_reference=$4 AND id=$5',[household,snapshot.owner_id,providerId,code.slice(5),legacyId]);
   if(!accounts.rowCount)continue;
   const ids=accounts.rows.map(item=>accountId(JSON.stringify([snapshot.owner,'custody:'+String(item.id)])));
   const balances=await db.query(`SELECT account_id,instrument_code,currency,quantity::text,opening_as_of::text FROM app.holdings WHERE household_id=$1 AND account_id=ANY($2::text[]) AND instrument_code=$3 AND quantity<>0 ORDER BY account_id,currency`,[household,ids,code]);
   const visible=Array.isArray(current.rows[0]?.view?.positions)?current.rows[0].view.positions:[];
   snapshot.legacy_positions.push(...balances.rows.map(item=>{const position=visible.find((p:Raw)=>p.account_id===item.account_id&&p.instrument_code===item.instrument_code&&p.currency===item.currency);return {...item,market_value_minor:position?.market_value_minor??null};}));
  }
  snapshot.legacy_positions.sort((a:Raw,b:Raw)=>JSON.stringify([a.account_id,a.instrument_code,a.currency]).localeCompare(JSON.stringify([b.account_id,b.instrument_code,b.currency])));
 }
 return{snapshots:result.rows,portfolio_effective_as_of:current.rows[0]?.portfolio_effective_as_of??null,mode:'shadow',authoritative:false};
}

/** Publish a complete reviewed Avenue or pension position cut, never movements or cash. */
export async function publishExternalPositionSnapshot(db:pg.Pool,household:string,actor:string,documentId:string,body:unknown){
 if(!body||typeof body!=='object'||Array.isArray(body))throw new Conflict('VALIDATION',422);
 const input=body as Record<string,unknown>;
 if(Object.keys(input).some(k=>!['request_key','content_sha256','legacy_confirmation'].includes(k))||typeof input.request_key!=='string'||!KEY.test(input.request_key)||typeof input.content_sha256!=='string'||!/^[0-9a-f]{64}$/.test(input.content_sha256))throw new Conflict('VALIDATION',422);
 const confirmation=input.legacy_confirmation as {facts_revision?:unknown;portfolio_version?:unknown;positions?:unknown;identities?:unknown}|undefined;
 if(confirmation!==undefined&&(!confirmation||typeof confirmation!=='object'||Array.isArray(confirmation)||Object.keys(confirmation).some(k=>!['facts_revision','portfolio_version','positions','identities'].includes(k))||typeof confirmation.facts_revision!=='string'||!/^\d+$/.test(confirmation.facts_revision)||typeof confirmation.portfolio_version!=='string'||!/^[0-9a-f]{64}$/.test(confirmation.portfolio_version)||!Array.isArray(confirmation.positions)||!confirmation.positions.length||confirmation.positions.length>100||!Array.isArray(confirmation.identities)||!confirmation.identities.length||confirmation.identities.length>1000))throw new Conflict('VALIDATION',422);
 const c=await db.connect();
 try{
  await c.query('BEGIN');
  const member=await c.query("SELECT 1 FROM app.memberships WHERE household_id=$1 AND actor_id=$2 AND role IN ('owner','approver')",[household,actor]);if(!member.rowCount)throw new Conflict('FORBIDDEN',403);
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${household}:external-position-publication:${documentId}`]);
  const requestHash=hash(JSON.stringify(confirmation?[documentId,input.content_sha256,confirmation]:[documentId,input.content_sha256]));
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
  const latestSource=await c.query(`SELECT id FROM app.source_documents WHERE household_id=$1 AND owner_id=$2 AND source_system=$3 AND report_kind='position' AND status<>'superseded'
    AND EXISTS(SELECT 1 FROM app.source_assertions a2 WHERE a2.household_id=source_documents.household_id AND a2.document_id=source_documents.id AND a2.assertion_kind='position')
    ORDER BY effective_as_of DESC NULLS LAST,registered_at DESC,id DESC LIMIT 1`,[household,owner,sourceSystem]);
  const priorPublished=await c.query(`SELECT max(d.effective_as_of)::text AS effective_as_of FROM app.external_position_snapshot_publications p
    JOIN app.source_documents d ON d.household_id=p.household_id AND d.id=p.document_id WHERE p.household_id=$1 AND d.owner_id=$2 AND d.source_system=$3`,[household,owner,sourceSystem]);
  if(String(latestSource.rows[0]?.id??'')!==documentId||cut<String(priorPublished.rows[0]?.effective_as_of??''))throw new Conflict('HISTORICAL_SNAPSHOT_REQUIRES_CORRECTION_FLOW',409);
  const publicationAsOf=cut>String(state.rows[0].effective_as_of)?cut:String(state.rows[0].effective_as_of);
  if(sourceSystem!=='Avenue'){const ids=await c.query("SELECT id FROM app.source_assertions WHERE household_id=$1 AND document_id=$2 AND assertion_kind='position' ORDER BY id",[household,documentId]);for(const item of ids.rows)await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${household}:pension-identity:${item.id}`]);}
  const source=await c.query(`SELECT a.id,a.interpretation_status,a.owner_id AS assertion_owner_id,a.source_sheet,a.source_row,a.custody_account_id,a.instrument_code,a.quantity::text,a.asserted_on::text,a.raw_row,pd.id AS pension_decision_id,pd.plan_number AS decided_plan,pd.fund_name AS decided_fund,pd.fund_cnpj AS decided_cnpj,pd.source_locator AS decided_locator,
      ca.owner_id,ca.institution_id,ca.external_reference,ca.identity_basis,ci.kind AS institution_kind
    FROM app.source_assertions a LEFT JOIN LATERAL (SELECT * FROM app.pension_identity_decisions z WHERE z.household_id=a.household_id AND z.assertion_id=a.id ORDER BY z.revision DESC LIMIT 1) pd ON true LEFT JOIN app.custody_accounts ca ON ca.household_id=a.household_id AND ca.id=a.custody_account_id
    LEFT JOIN app.custody_institutions ci ON ci.id=ca.institution_id
    WHERE a.household_id=$1 AND a.document_id=$2 AND a.assertion_kind='position' ORDER BY a.source_sheet,a.source_row`,[household,documentId]);
  if(!source.rowCount)throw new Conflict('EMPTY_POSITION_SNAPSHOT',422);
  const seen=new Set<string>(),legacyPositions=new Map<string,{account_id:string;instrument_code:string;currency:string;quantity:string;opening_as_of:string|null}>(),rows=[] as Array<{id:string;assertion:string;account:string;custody:string;code:string;currency:string;quantity:string;unitPrice:string;marketMinor:string;assetClass:string;payload:Raw}>;
  for(const row of source.rows){
   let raw=row.raw_row as Raw;if(row.pension_decision_id){if(Array.isArray(raw.plans)&&raw.plans.length>1)throw new Conflict('PENSION_AGGREGATED_PLANS_REQUIRES_SPLIT',422);const locator=String(row.decided_locator),plan=String(row.decided_plan),fund=String(row.decided_fund),cnpj=String(row.decided_cnpj);raw={...raw,institution:sourceSystem,plan_number:plan,fund,fund_cnpj:cnpj,instrument_code:`PREV-${cnpj}`,identity_status:'observed',identity_evidence:{plan:[{value:plan,locator}],fund:[{value:fund,locator}],fund_cnpj:[{value:cnpj,locator}]}};}if(String(row.asserted_on??'')!==cut)throw new Conflict('POSITION_REFERENCE_DATE_MISMATCH',422);
   let custody=row.pension_decision_id?'':String(row.custody_account_id??''),institution=row.pension_decision_id?'':String(row.institution_id??''),custodyOwner=row.pension_decision_id?'':String(row.owner_id??''),identityBasis=row.pension_decision_id?'':String(row.identity_basis??'');
   if(sourceSystem==='Avenue'&&(institution!=='avenue-securities'||String(row.external_reference??'')!==clean(raw.account)))throw new Conflict('CUSTODY_INSTITUTION_OR_ACCOUNT_MISMATCH',422);
   if(sourceSystem!=='Avenue'){
    const identity=pensionIdentity(raw,sourceSystem);if(!identity||(!row.pension_decision_id&&row.interpretation_status!=='observed')||String(raw.instrument_code??'')!==`PREV-${identity.cnpj}`)throw new Conflict('PENSION_IDENTITY_REVIEW_REQUIRED',422);
    const provider=sourceSystem,providerId=identity.institutionId;
    const legacyId='custody-'+sha([household,owner,providerId,identity.cnpj].join('|')).slice(0,32);
    const legacy=await c.query('SELECT id FROM app.custody_accounts WHERE household_id=$1 AND owner_id=$2 AND institution_id=$3 AND external_reference=$4 AND id=$5',[household,owner,providerId,identity.cnpj,legacyId]);
    if(legacy.rowCount){const ids=legacy.rows.map(item=>accountId(JSON.stringify([ownerName,'custody:'+String(item.id)])));const existing=await c.query("SELECT account_id,instrument_code,currency,quantity::text,opening_as_of::text,coverage_status FROM app.holdings WHERE household_id=$1 AND account_id=ANY($2::text[]) AND instrument_code=$3 AND quantity<>0 FOR UPDATE",[household,ids,`PREV-${identity.cnpj}`]);for(const item of existing.rows){if(item.coverage_status!=='verified'||!exact(item.quantity).gt(0))throw new Conflict('PENSION_LEGACY_POSITION_UNRESOLVED',409);const p={account_id:String(item.account_id),instrument_code:String(item.instrument_code),currency:String(item.currency),quantity:String(item.quantity),opening_as_of:item.opening_as_of===null?null:String(item.opening_as_of)};legacyPositions.set(JSON.stringify([p.account_id,p.instrument_code,p.currency]),p);}}
    await c.query("INSERT INTO app.custody_institutions(id,canonical_name,kind) VALUES($1,$2,'pension_provider') ON CONFLICT(id) DO NOTHING",[providerId,provider]);
    const providerCheck=await c.query('SELECT canonical_name,kind FROM app.custody_institutions WHERE id=$1',[providerId]);if(providerCheck.rows[0]?.canonical_name!==provider||providerCheck.rows[0]?.kind!=='pension_provider')throw new Conflict('PENSION_PROVIDER_ID_CONFLICT');
    if(!custody){custody=pensionCustodyId(household,owner,providerId,identity.plan);await c.query(`INSERT INTO app.custody_accounts(household_id,id,owner_id,institution_id,external_reference,identity_basis) VALUES($1,$2,$3,$4,$5,'observed_reference') ON CONFLICT(household_id,id) DO NOTHING`,[household,custody,owner,providerId,identity.plan]);const account=await c.query('SELECT owner_id,institution_id,external_reference,identity_basis FROM app.custody_accounts WHERE household_id=$1 AND id=$2',[household,custody]);if(account.rows[0]?.owner_id!==owner||account.rows[0]?.institution_id!==providerId||account.rows[0]?.external_reference!==identity.plan||account.rows[0]?.identity_basis!=='observed_reference')throw new Conflict('PENSION_CUSTODY_ACCOUNT_CONFLICT');custodyOwner=owner;identityBasis='observed_reference';institution=providerId;}
    else if(institution!==providerId||String(row.external_reference??'')!==identity.plan)throw new Conflict('PENSION_CUSTODY_ACCOUNT_CONFLICT',422);
   }
   if(!custody||custodyOwner!==owner||row.assertion_owner_id!==owner||identityBasis==='pending')throw new Conflict('CUSTODY_ACCOUNT_UNRESOLVED',422);
   if(sourceSystem!=='Avenue'&&String(row.institution_kind??'pension_provider')!=='pension_provider')throw new Conflict('PENSION_PROVIDER_UNRESOLVED',422);
   const code=String(sourceSystem==='Avenue'?row.instrument_code:raw.instrument_code??'').trim(),quantity=exact(String(row.quantity??'0'));if(!code||!quantity.gt(0))throw new Conflict('POSITION_IDENTITY_OR_QUANTITY_INVALID',422);
   const currency=String(raw.currency??(sourceSystem==='Avenue'?'USD':'BRL'));if(!['BRL','USD'].includes(currency))throw new Conflict('UNSUPPORTED_CURRENCY',422);
   if(sourceSystem==='Avenue'&&raw.asset_class==='cash')continue;
   const market=sourceSystem==='Avenue'?exact(String(raw.market_value_minor??'0')):exact(String(raw.market_value??'0')).mul(100);
   const unitPrice=exact(String(raw.unit_price??'0'));if(!market.gt(0)||!unitPrice.gt(0))throw new Conflict('POSITION_MARKET_VALUE_MISSING',422);
   const account=accountId(JSON.stringify([ownerName,'custody:'+custody])),key=`${account}\0${code}\0${currency}`;if(seen.has(key))throw new Conflict('DUPLICATE_ACCOUNT_INSTRUMENT',422);seen.add(key);
   const assetClass=sourceSystem==='Avenue'?String(raw.asset_class??'international_equity'):'private_pension';
   if(sourceSystem==='Avenue'&&!['international_equity','international_fixed_income','money_market'].includes(assetClass))throw new Conflict('UNSUPPORTED_AVENUE_ASSET_CLASS',422);
   const payload={kind:'position',owner:ownerName,asset_class:assetClass,product_name:clean(raw.product_name)||code,institution:sourceSystem==='Avenue'?'Avenue':clean(raw.institution)||sourceSystem,account:sourceSystem==='Avenue'?clean(raw.account):clean(raw.plan_number),instrument_code:code,quantity:quantity.toFixed(),unit_price:unitPrice.toFixed(),market_value_minor:minor(market),currency,reference_date:cut,source:sourceSystem==='Avenue'?'avenue_statement':'pension_statement',issuer:clean(raw.fund)||null};
   rows.push({id:`${documentId}:${row.source_sheet}:${row.source_row}`,assertion:String(row.id),account,custody,code,currency,quantity:quantity.toFixed(),unitPrice:unitPrice.toFixed(),marketMinor:minor(market),assetClass,payload});
  }
  if(!rows.length)throw new Conflict('EMPTY_INVESTED_POSITION_SNAPSHOT',422);
  const legacy=[...legacyPositions.values()].sort((a,b)=>JSON.stringify([a.account_id,a.instrument_code,a.currency]).localeCompare(JSON.stringify([b.account_id,b.instrument_code,b.currency])));
  if(legacy.length&&!confirmation)throw new Conflict('PENSION_LEGACY_POSITION_REVIEW_REQUIRED',409);
  if(confirmation){
   if(!legacy.length||confirmation.facts_revision!==String(state.rows[0].facts_revision)||confirmation.portfolio_version!==String(state.rows[0].latest_version))throw new Conflict('STALE_PORTFOLIO',409);
   const identities=(confirmation.identities as unknown[]).map(value=>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Conflict('VALIDATION',422);const x=value as Raw;if(Object.keys(x).sort().join(',')!=='assertion_id,decision_id'||typeof x.assertion_id!=='string'||!(typeof x.decision_id==='string'||x.decision_id===null))throw new Conflict('VALIDATION',422);return {assertion_id:x.assertion_id,decision_id:x.decision_id};}).sort((a,b)=>a.assertion_id.localeCompare(b.assertion_id));
   const actualIdentities=source.rows.map(row=>({assertion_id:String(row.id),decision_id:row.pension_decision_id===null?null:String(row.pension_decision_id)})).sort((a,b)=>a.assertion_id.localeCompare(b.assertion_id));if(JSON.stringify(identities)!==JSON.stringify(actualIdentities))throw new Conflict('PENSION_IDENTITY_PREVIEW_CHANGED',409);
   const expected=(confirmation.positions as unknown[]).map(value=>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Conflict('VALIDATION',422);const x=value as Raw;if(Object.keys(x).sort().join(',')!=='account_id,currency,instrument_code,opening_as_of,quantity'||typeof x.account_id!=='string'||typeof x.instrument_code!=='string'||typeof x.currency!=='string'||typeof x.quantity!=='string'||!(typeof x.opening_as_of==='string'||x.opening_as_of===null))throw new Conflict('VALIDATION',422);return {account_id:x.account_id,instrument_code:x.instrument_code,currency:x.currency,quantity:x.quantity,opening_as_of:x.opening_as_of};}).sort((a,b)=>JSON.stringify([a.account_id,a.instrument_code,a.currency]).localeCompare(JSON.stringify([b.account_id,b.instrument_code,b.currency])));
   if(JSON.stringify(expected)!==JSON.stringify(legacy))throw new Conflict('PENSION_LEGACY_PREVIEW_CHANGED',409);
   for(const item of legacy){
    if(!item.opening_as_of||item.opening_as_of>cut)throw new Conflict('PENSION_LEGACY_HISTORICAL_REVIEW_REQUIRED',409);
    const laterLegacy=await c.query("SELECT 1 FROM app.events WHERE household_id=$1 AND account_id=$2 AND instrument_code=$3 AND currency=$4 AND application_status='applied' AND effective_date>$5::date LIMIT 1",[household,item.account_id,item.instrument_code,item.currency,cut]);if(laterLegacy.rowCount)throw new Conflict('POST_SNAPSHOT_APPLIED_EVENT_PRESENT',409);
   }
  }
  if(sourceSystem!=='Avenue'){
   const providerId='pension-provider-'+sha(sourceSystem.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase()).slice(0,24);
   const providerAccounts=await c.query('SELECT id FROM app.custody_accounts WHERE household_id=$1 AND owner_id=$2 AND institution_id=$3',[household,owner,providerId]);
   const ids=providerAccounts.rows.map(item=>accountId(JSON.stringify([ownerName,'custody:'+String(item.id)])));
   if(ids.length){const current=await c.query("SELECT account_id,instrument_code,currency FROM app.holdings WHERE household_id=$1 AND account_id=ANY($2::text[]) AND instrument_code LIKE 'PREV-%' AND quantity<>0 FOR UPDATE",[household,ids]);for(const item of current.rows){const key=`${item.account_id}\0${item.instrument_code}\0${item.currency}`;if(!seen.has(key)&&!legacyPositions.has(JSON.stringify([item.account_id,item.instrument_code,item.currency])))throw new Conflict('PENSION_PROVIDER_SNAPSHOT_INCOMPLETE',409);}}
  }
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
  for(const item of legacy){await c.query(`INSERT INTO app.pension_legacy_retirements(household_id,account_id,instrument_code,currency,previous_quantity,replacement_document_id,effective_as_of,actor_id,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[household,item.account_id,item.instrument_code,item.currency,item.quantity,documentId,cut,actor,now]);await c.query(`UPDATE app.holdings SET quantity=0,opening_as_of=$5,opening_document_id=$6,opening_assertion_id=NULL,opening_event_id=NULL WHERE household_id=$1 AND account_id=$2 AND instrument_code=$3 AND currency=$4`,[household,item.account_id,item.instrument_code,item.currency,cut,documentId]);}
  await c.query('UPDATE app.household_state SET facts_revision=facts_revision+1 WHERE household_id=$1',[household]);
  const result=await publishInTransaction(c,run,household,publicationAsOf,now);
  for(const item of legacy){if(result.view.positions.some(p=>p.account_id===item.account_id&&p.instrument_code===item.instrument_code&&p.currency===item.currency))throw new Conflict('PENSION_LEGACY_REBUILD_CONFLICT',409);}
  if(sourceSystem!=='Avenue'&&result.view.positions.some(p=>p.owner===ownerName&&p.asset_class==='private_pension'&&(p.institution===sourceSystem||!p.institution&&rows.some(row=>row.code===p.instrument_code))&&!seen.has(`${p.account_id}\0${p.instrument_code}\0${p.currency}`)))throw new Conflict('PENSION_LEGACY_REBUILD_CONFLICT',409);
  await c.query(`INSERT INTO app.external_position_snapshot_publications(household_id,document_id,actor_id,request_key,request_hash,run_id,portfolio_version,position_count) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[household,documentId,actor,input.request_key,requestHash,run,result.portfolio_version,rows.length]);
  await c.query(`INSERT INTO app.audit_log(household_id,actor_id,action,resource_id,details) VALUES($1,$2,'external_position_snapshot_published',$3,$4)`,[household,actor,documentId,{source_system:sourceSystem,content_sha256:input.content_sha256,reference_date:cut,portfolio_effective_as_of:publicationAsOf,position_count:rows.length,portfolio_version:result.portfolio_version,movements_applied:false,cash_tracked:false,represented_custody_accounts:custodies,retired_legacy_positions:legacy}]);
  await c.query('COMMIT');return{document_id:documentId,source_system:sourceSystem,source_as_of:cut,effective_as_of:publicationAsOf,portfolio_version:result.portfolio_version,positions:rows.length,replayed:false,portfolio_published:true,mode:'shadow',authoritative:false};
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
