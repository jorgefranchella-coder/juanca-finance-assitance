import {createHash,randomUUID} from 'node:crypto';
import type pg from 'pg';
import {accountId,hash,ownerId,publishInTransaction} from './migration.ts';
import {Conflict} from './commands.ts';
import {exact,localized,minor} from './money.ts';

const KEY=/^[A-Za-z0-9._:-]{8,128}$/;
type Raw=Record<string,unknown>;
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const clean=(value:unknown)=>String(value??'').trim().replace(/\s+/g,' ');
const normalized=(value:unknown)=>clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/[^A-Z0-9]+/g,' ').trim().replace(/\s+/g,' ');
const assetClass:Record<string,string>={Acoes:'equity',BDR:'bdr',ETF:'etf','Fundo de Investimento':'fund','Renda Fixa':'fixed_income','Tesouro Direto':'treasury'};

export async function listB3PositionSnapshots(db:pg.Pool,household:string){
  const result=await db.query(`SELECT d.id AS document_id,d.owner_id,o.display_name AS owner,d.original_name,d.content_sha256,d.effective_as_of::text AS effective_as_of,d.status,
   count(a.id)::int AS rows,count(*) FILTER(WHERE a.instrument_code IS NULL OR a.quantity IS NULL OR a.quantity<=0 OR
    COALESCE(NULLIF(a.raw_row->>'Valor Atualizado MTM',''),NULLIF(a.raw_row->>'Valor Atualizado FECHAMENTO',''),NULLIF(a.raw_row->>'Valor Atualizado CURVA',''),NULLIF(a.raw_row->>'Valor Atualizado','')) IS NULL)::int AS invalid_rows,
   count(*) FILTER(WHERE a.custody_account_id IS NULL)::int AS account_pending,
   bool_or(p.document_id IS NOT NULL) AS published,bool_or(d.id=latest.id) AS latest
   FROM app.source_documents d JOIN app.owners o ON o.household_id=d.household_id AND o.id=d.owner_id
   JOIN app.source_assertions a ON a.household_id=d.household_id AND a.document_id=d.id AND a.assertion_kind='position'
   LEFT JOIN app.b3_snapshot_publications p ON p.household_id=d.household_id AND p.document_id=d.id
   LEFT JOIN LATERAL (SELECT d2.id FROM app.source_documents d2 WHERE d2.household_id=d.household_id AND d2.owner_id=d.owner_id AND d2.source_system='B3' AND d2.report_kind='position' AND d2.status<>'superseded'
     AND EXISTS(SELECT 1 FROM app.source_assertions a2 WHERE a2.household_id=d2.household_id AND a2.document_id=d2.id AND a2.assertion_kind='position')
     ORDER BY d2.effective_as_of DESC NULLS LAST,d2.registered_at DESC,d2.id DESC LIMIT 1) latest ON true
   WHERE d.household_id=$1 AND d.source_system='B3' AND d.report_kind='position'
   GROUP BY d.id,d.owner_id,d.original_name,d.content_sha256,d.effective_as_of,d.status,d.registered_at,o.display_name ORDER BY d.effective_as_of DESC,d.registered_at DESC LIMIT 50`,[household]);
 const current=await db.query(`SELECT v.effective_as_of::text AS portfolio_effective_as_of FROM app.household_state s
   JOIN app.portfolio_versions v ON v.household_id=s.household_id AND v.id=s.latest_version WHERE s.household_id=$1`,[household]);
 return {snapshots:result.rows,portfolio_effective_as_of:current.rows[0]?.portfolio_effective_as_of??null,mode:'shadow',authoritative:false};
}

/** A call by an owner/approver is the explicit approval to publish this whole B3 position cut. */
export async function publishB3PositionSnapshot(db:pg.Pool,household:string,actor:string,documentId:string,body:unknown){
 if(!body||typeof body!=='object'||Array.isArray(body))throw new Conflict('VALIDATION',422);
 const input=body as Record<string,unknown>;
 if(Object.keys(input).some(k=>!['request_key','content_sha256'].includes(k))||typeof input.request_key!=='string'||!KEY.test(input.request_key)||typeof input.content_sha256!=='string'||!/^[0-9a-f]{64}$/.test(input.content_sha256))throw new Conflict('VALIDATION',422);
 const c=await db.connect();
 try{
  await c.query('BEGIN');
  const member=await c.query("SELECT 1 FROM app.memberships WHERE household_id=$1 AND actor_id=$2 AND role IN ('owner','approver')",[household,actor]);
  if(!member.rowCount)throw new Conflict('FORBIDDEN',403);
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${household}:b3-publication:${documentId}`]);
  const requestHash=hash(JSON.stringify([documentId,input.content_sha256]));
  const oldRequest=await c.query('SELECT document_id,request_hash,portfolio_version,position_count FROM app.b3_snapshot_publications WHERE household_id=$1 AND actor_id=$2 AND request_key=$3',[household,actor,input.request_key]);
  if(oldRequest.rowCount){if(oldRequest.rows[0].document_id!==documentId||oldRequest.rows[0].request_hash!==requestHash)throw new Conflict('IDEMPOTENCY_MISMATCH',409);await c.query('COMMIT');return{document_id:documentId,portfolio_version:oldRequest.rows[0].portfolio_version,positions:oldRequest.rows[0].position_count,replayed:true,portfolio_published:true};}
  const published=await c.query('SELECT portfolio_version,position_count FROM app.b3_snapshot_publications WHERE household_id=$1 AND document_id=$2',[household,documentId]);
  if(published.rowCount)throw new Conflict('SNAPSHOT_ALREADY_PUBLISHED',409);
  const doc=await c.query(`SELECT d.owner_id,d.content_sha256,d.effective_as_of::text,o.display_name,d.original_name
    FROM app.source_documents d JOIN app.owners o ON o.household_id=d.household_id AND o.id=d.owner_id
    WHERE d.household_id=$1 AND d.id=$2 AND d.source_system='B3' AND d.report_kind='position' FOR UPDATE OF d`,[household,documentId]);
  if(doc.rowCount!==1)throw new Conflict('NOT_FOUND',404);
  if(doc.rows[0].content_sha256!==input.content_sha256)throw new Conflict('STALE_SNAPSHOT',409);
  const cut=String(doc.rows[0].effective_as_of??'');if(!/^\d{4}-\d{2}-\d{2}$/.test(cut))throw new Conflict('REFERENCE_DATE_REQUIRED',422);
  const state=await c.query(`SELECT s.latest_version,s.facts_revision,v.run_id,v.effective_as_of::text AS effective_as_of
    FROM app.household_state s JOIN app.portfolio_versions v ON v.household_id=s.household_id AND v.id=s.latest_version
    WHERE s.household_id=$1 FOR UPDATE OF s`,[household]);
  if(state.rowCount!==1||!state.rows[0].run_id)throw new Conflict('PUBLISHED_BASELINE_REQUIRED',409);
  const run=String(state.rows[0].run_id),owner=String(doc.rows[0].owner_id),ownerName=String(doc.rows[0].display_name);
  const latestSource=await c.query(`SELECT id FROM app.source_documents WHERE household_id=$1 AND owner_id=$2 AND source_system='B3' AND report_kind='position' AND status<>'superseded'
    AND EXISTS(SELECT 1 FROM app.source_assertions a2 WHERE a2.household_id=source_documents.household_id AND a2.document_id=source_documents.id AND a2.assertion_kind='position')
    ORDER BY effective_as_of DESC NULLS LAST,registered_at DESC,id DESC LIMIT 1`,[household,owner]);
  const priorPublished=await c.query(`SELECT max(d.effective_as_of)::text AS effective_as_of FROM app.b3_snapshot_publications p
    JOIN app.source_documents d ON d.household_id=p.household_id AND d.id=p.document_id WHERE p.household_id=$1 AND d.owner_id=$2`,[household,owner]);
  if(String(latestSource.rows[0]?.id??'')!==documentId||cut<String(priorPublished.rows[0]?.effective_as_of??''))throw new Conflict('HISTORICAL_SNAPSHOT_REQUIRES_CORRECTION_FLOW',409);
  const publicationAsOf=cut>String(state.rows[0].effective_as_of)?cut:String(state.rows[0].effective_as_of);
  const source=await c.query(`SELECT a.id,a.source_sheet,a.source_row,a.institution_id,a.custody_account_id,a.instrument_code,a.quantity::text,a.asserted_on::text AS asserted_on,a.raw_row,
      ci.canonical_name
    FROM app.source_assertions a LEFT JOIN app.custody_institutions ci ON ci.id=a.institution_id
    WHERE a.household_id=$1 AND a.document_id=$2 AND a.assertion_kind='position' ORDER BY a.source_sheet,a.source_row`,[household,documentId]);
  if(!source.rowCount)throw new Conflict('EMPTY_POSITION_SNAPSHOT',422);
  const aliases=await c.query('SELECT normalized_alias,institution_id FROM app.custody_institution_aliases');
  const aliasMap=new Map(aliases.rows.map(r=>[String(r.normalized_alias),String(r.institution_id)]));
  const accounts=await c.query(`SELECT id,institution_id,external_reference,identity_basis FROM app.custody_accounts
    WHERE household_id=$1 AND owner_id=$2 AND identity_basis<>'pending' ORDER BY id`,[household,owner]);
  const resolved=[] as Array<{row:typeof source.rows[number];custody:string;institution:string;account:string;scope:string;decision:'same_custody_account_confirmed_by_institution_uniqueness'|'custody_account_reference_observed'}>;
  const unique=new Set<string>();
  for(const row of source.rows){
   if(String(row.asserted_on??'')!==cut)throw new Conflict('POSITION_REFERENCE_DATE_MISMATCH',422);
   const raw=row.raw_row as Raw,inst=String(row.institution_id??aliasMap.get(normalized(raw.Instituição))??''),institutionAccounts=accounts.rows.filter(a=>String(a.institution_id)===inst);
   let custody=String(row.custody_account_id??'');
   if(!custody){const ref=clean(raw.Conta);const candidates=institutionAccounts.filter(a=>String(a.identity_basis)==='user_confirmed_unique'&&(!ref||!a.external_reference||String(a.external_reference)===ref));if(candidates.length===1)custody=String(candidates[0].id);}
   const accountRow=accounts.rows.find(a=>String(a.id)===custody),ref=clean(raw.Conta);
   if(!inst||!accountRow||String(accountRow.institution_id)!==inst||String(accountRow.identity_basis)==='pending')throw new Conflict('CUSTODY_ACCOUNT_UNRESOLVED',422);
   if(ref&&accountRow.external_reference&&String(accountRow.external_reference)!==ref)throw new Conflict('CUSTODY_ACCOUNT_REFERENCE_MISMATCH',422);
   const referenceObserved=!!ref&&String(accountRow.identity_basis)==='observed_reference'&&String(accountRow.external_reference??'')===ref;
   if(!referenceObserved&&String(accountRow.identity_basis)!=='user_confirmed_unique')throw new Conflict('CUSTODY_ACCOUNT_UNRESOLVED',422);
   const code=String(row.instrument_code??'').trim(),quantity=String(row.quantity??'');
   let positive=false;try{positive=/^-?(?:\d+)(?:\.\d+)?$/.test(quantity)&&exact(quantity).gt(0);}catch{}
   if(!code||!positive)throw new Conflict('POSITION_IDENTITY_OR_QUANTITY_INVALID',422);
   if(!assetClass[String(row.source_sheet)])throw new Conflict('UNSUPPORTED_B3_POSITION_SHEET',422);
   const market=localized(raw['Valor Atualizado MTM'])??localized(raw['Valor Atualizado FECHAMENTO'])??localized(raw['Valor Atualizado CURVA'])??localized(raw['Valor Atualizado']);
   if(!market)throw new Conflict('POSITION_MARKET_VALUE_MISSING',422);
   const price=localized(raw['Preço Atualizado MTM'])??localized(raw['Preço Atualizado FECHAMENTO'])??localized(raw['Preço Atualizado CURVA'])??localized(raw['Preço de Fechamento']);
   const key=`${custody}\0${code}\0BRL`;if(unique.has(key))throw new Conflict('DUPLICATE_ACCOUNT_INSTRUMENT',422);unique.add(key);
   const account=accountId(JSON.stringify([ownerName,'custody:'+custody]));
   const scope=JSON.stringify([ownerName,'custody:'+custody]);
   await c.query('INSERT INTO app.accounts(household_id,id,owner_id,source_scope,identity_status) VALUES($1,$2,$3,$4,\'known\') ON CONFLICT(household_id,id) DO NOTHING',[household,account,owner,scope]);
   const canonical=await c.query('SELECT owner_id,source_scope,identity_status FROM app.accounts WHERE household_id=$1 AND id=$2',[household,account]);
   if(canonical.rows[0]?.owner_id!==owner||canonical.rows[0]?.source_scope!==scope||canonical.rows[0]?.identity_status!=='known')throw new Conflict('CANONICAL_ACCOUNT_CONFLICT');
   resolved.push({row,custody,institution:inst,account,scope,decision:referenceObserved?'custody_account_reference_observed':'same_custody_account_confirmed_by_institution_uniqueness'});
  }
  const importId=`b3pub-${documentId}`,createdAt=new Date().toISOString().replace('T',' ').replace('Z','');
  const nextOrdinal=Number((await c.query('SELECT COALESCE(max(source_ordinal),0)+1 AS n FROM app.received_sources WHERE run_id=$1',[run])).rows[0].n);
  const insertReceived=async(table:string,id:string,value:Raw,ordinal:number)=>c.query('INSERT INTO app.received_sources(run_id,id,household_id,source_table,original,sha256,source_ordinal) VALUES($1,$2,$3,$4,$5,$6,$7)',[run,`${table}:${id}`,household,table,JSON.stringify(value),sha(JSON.stringify(value)),ordinal]);
  const importRow={id:importId,user_id:household,owner:ownerName,status:'processed',file_type:'positions',reference_date:cut,created_at:createdAt,source:'B3',file_name:String(doc.rows[0].original_name)};
  await insertReceived('imports',importId,importRow,nextOrdinal);
  const holdingsToSet=new Map<string,{account:string;code:string;quantity:string;assertion:string}>();
  let recordOrdinal=0;const baseId=Date.now()*1000;
  for(const item of resolved){
   recordOrdinal++;const row=item.row,raw=row.raw_row as Raw,recordId=baseId+recordOrdinal;
   const market=localized(raw['Valor Atualizado MTM'])??localized(raw['Valor Atualizado FECHAMENTO'])??localized(raw['Valor Atualizado CURVA'])??localized(raw['Valor Atualizado']);
   const price=localized(raw['Preço Atualizado MTM'])??localized(raw['Preço Atualizado FECHAMENTO'])??localized(raw['Preço Atualizado CURVA'])??localized(raw['Preço de Fechamento']);
   if(!market)throw new Conflict('POSITION_MARKET_VALUE_MISSING',422);
   const parsed={kind:'position',owner:ownerName,asset_class:assetClass[String(row.source_sheet)],product_name:clean(raw.Produto)||String(row.instrument_code),institution:String(row.canonical_name??raw.Instituição??''),account:clean(raw.Conta)||null,instrument_code:String(row.instrument_code),isin:clean(raw['Código ISIN / Distribuição'])||null,issuer:clean(raw.Emissor)||null,quantity:String(row.quantity),unit_price:price?.toFixed()??'0',market_value_cents:minor(market.mul(100)),maturity_date:raw.Vencimento??null,reference_date:cut,source_sheet:String(row.source_sheet),source_row:Number(row.source_row),raw};
   const record={id:recordId,import_id:importId,user_id:household,record_kind:'position',payload:JSON.stringify(parsed)};
   await insertReceived('import_records',String(recordId),record,nextOrdinal+recordOrdinal);
   const snapshotId=`${importId}:${recordId}`;
   await c.query(`INSERT INTO app.snapshots(run_id,household_id,id,owner_id,account_id,effective_date,known_at,source_type,scope_status)
    VALUES($1,$2,$3,$4,$5,$6,$7,'positions','resolved')`,[run,household,snapshotId,ownerId(ownerName),item.account,cut,new Date().toISOString()]);
   await c.query(`INSERT INTO app.position_account_resolutions(run_id,household_id,source_record_id,resolution_version,snapshot_id,assertion_id,custody_account_id,decision,actor_id)
    VALUES($1,$2,$3,1,$4,$5,$6,$7,$8)`,[run,household,String(recordId),snapshotId,String(row.id),item.custody,item.decision,actor]);
   holdingsToSet.set(`${item.account}\0${row.instrument_code}\0BRL`,{account:item.account,code:String(row.instrument_code),quantity:String(row.quantity),assertion:String(row.id)});
  }
  // A complete B3 snapshot resets holdings only for custodians represented in the file.
  const institutions=[...new Set(resolved.map(r=>r.institution))];
  const affectedAccounts=accounts.rows.filter(a=>institutions.includes(String(a.institution_id))&&String(a.identity_basis)!=='pending').map(a=>accountId(JSON.stringify([ownerName,'custody:'+String(a.id)])));
  const laterEvents=await c.query(`SELECT count(*)::int AS total FROM app.events WHERE household_id=$1 AND account_id=ANY($2::text[])
    AND application_status='applied' AND effective_date>$3::date`,[household,affectedAccounts,cut]);
  if(laterEvents.rows[0].total>0)throw new Conflict('POST_SNAPSHOT_APPLIED_EVENT_PRESENT',409);
  const priorHoldings=await c.query(`SELECT account_id,instrument_code,currency FROM app.holdings WHERE household_id=$1 AND account_id=ANY($2::text[])`,[household,affectedAccounts]);
  for(const prior of priorHoldings.rows){const key=`${prior.account_id}\0${prior.instrument_code}\0${prior.currency}`;if(!holdingsToSet.has(key))holdingsToSet.set(key,{account:String(prior.account_id),code:String(prior.instrument_code),quantity:'0',assertion:''});}
  for(const holding of holdingsToSet.values()){
   const evidence=holding.assertion?{assertion:holding.assertion,document:null}:{assertion:null,document:documentId};
   await c.query(`INSERT INTO app.holdings(household_id,account_id,instrument_code,currency,quantity,coverage_status,opening_as_of,opening_assertion_id,opening_document_id,opening_event_id)
     VALUES($1,$2,$3,'BRL',$4,'verified',$5,$6,$7,NULL)
     ON CONFLICT(household_id,account_id,instrument_code,currency) DO UPDATE SET quantity=EXCLUDED.quantity,coverage_status='verified',opening_as_of=EXCLUDED.opening_as_of,opening_assertion_id=EXCLUDED.opening_assertion_id,opening_document_id=EXCLUDED.opening_document_id,opening_event_id=NULL`,[household,holding.account,holding.code,holding.quantity,cut,evidence.assertion,evidence.document]);
  }
  await c.query('UPDATE app.household_state SET facts_revision=facts_revision+1 WHERE household_id=$1',[household]);
  const knownAt=new Date().toISOString();const result=await publishInTransaction(c,run,household,publicationAsOf,knownAt);
  await c.query(`INSERT INTO app.b3_snapshot_publications(household_id,document_id,actor_id,request_key,request_hash,run_id,portfolio_version,position_count)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[household,documentId,actor,input.request_key,requestHash,run,result.portfolio_version,resolved.length]);
  await c.query(`INSERT INTO app.audit_log(household_id,actor_id,action,resource_id,details) VALUES($1,$2,'b3_position_snapshot_published',$3,$4)`,[household,actor,documentId,{content_sha256:input.content_sha256,reference_date:cut,portfolio_effective_as_of:publicationAsOf,position_count:resolved.length,portfolio_version:result.portfolio_version,movements_applied:false,cash_tracked:false}]);
  await c.query('COMMIT');
  return{document_id:documentId,source_as_of:cut,effective_as_of:publicationAsOf,portfolio_version:result.portfolio_version,positions:resolved.length,replayed:false,portfolio_published:true,mode:'shadow',authoritative:false};
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
