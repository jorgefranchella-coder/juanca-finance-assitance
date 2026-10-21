import {createHash,randomUUID} from 'node:crypto';
import type pg from 'pg';
import {Conflict} from './commands.ts';
import {exact,localized} from './money.ts';

const KEY=/^[A-Za-z0-9._:-]{8,128}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE=/^\d{4}-\d{2}-\d{2}$/;
const DECIMAL=/^\d{1,18}(?:\.\d{1,10})?$/;
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const validDate=(value:string)=>{if(!DATE.test(value))return false;const date=new Date(value+'T00:00:00Z');return !Number.isNaN(date.valueOf())&&date.toISOString().slice(0,10)===value;};
const norm=(value:unknown)=>String(value??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().trim();

export function effectiveAcquisitionLots(history:Array<Record<string,any>>){
 const latest=new Map<string,Record<string,any>>();for(const lot of history)if(!latest.has(String(lot.acquisition_id))||Number(lot.revision)>Number(latest.get(String(lot.acquisition_id))!.revision))latest.set(String(lot.acquisition_id),lot);
 return [...latest.values()].sort((a,b)=>String(a.effective_date).localeCompare(String(b.effective_date))||String(a.acquisition_id).localeCompare(String(b.acquisition_id)));
}

export function summarizeAcquisitionQuantity(snapshotAsOf:string|null,snapshotValue:string|null,currentLots:Array<Record<string,any>>){
 const active=currentLots.filter(lot=>!lot.voided),acquired=active.reduce((sum:ReturnType<typeof exact>,lot)=>sum.add(exact(String(lot.quantity))),exact('0'));
 const snapshot=snapshotValue===null?null:exact(snapshotValue),latestLotDate=currentLots.reduce((date,lot)=>String(lot.effective_date)>date?String(lot.effective_date):date,'');
 let status:'no_snapshot_quantity'|'lots_after_snapshot'|'matches_snapshot'|'acquisitions_exceed_snapshot'|'snapshot_exceeds_acquisitions'='no_snapshot_quantity';
 if(snapshot!==null&&snapshotAsOf){if(latestLotDate>snapshotAsOf)status='lots_after_snapshot';else if(acquired.eq(snapshot))status='matches_snapshot';else if(acquired.gt(snapshot))status='acquisitions_exceed_snapshot';else status='snapshot_exceeds_acquisitions';}
 return {snapshot_as_of:snapshotAsOf,snapshot_quantity:snapshotValue,current_gross_acquisition_quantity:acquired.toFixed(),snapshot_minus_gross_acquisitions:snapshot===null||status==='lots_after_snapshot'?null:snapshot.sub(acquired).toFixed(),status,interpretation:'gross_acquisitions_only; sales, redemptions and transfers are not netted'};
}

export async function listPositionIdentities(db:pg.Pool,household:string){
 const result=await db.query(`SELECT p.id AS position_id,p.owner_id,o.display_name AS owner,p.institution_id,ci.canonical_name AS institution,
   COALESCE(r.custody_account_id,p.custody_account_id) AS custody_account_id,
   CASE WHEN r.id IS NOT NULL OR p.identity_status='resolved' THEN 'resolved' ELSE 'provisional' END AS identity_status,
   p.instrument_code,p.currency,r.revision AS identity_revision,p.source_assertion_id,
   sa.document_id AS source_document_id,sa.source_sheet,sa.source_row,sd.effective_as_of AS source_as_of,sa.quantity::text AS source_quantity,
   sa.interpretation_status AS source_assertion_status,
   si.parser_version AS latest_parser_version,si.status AS parser_status,si.review_reasons AS parser_review_reasons,
   ir.decision AS identity_resolution_decision,ca.identity_basis AS custody_identity_basis,
   (r.id IS NOT NULL OR p.identity_status='resolved') AS custody_identity_resolved
   FROM app.position_identities p JOIN app.owners o ON o.household_id=p.household_id AND o.id=p.owner_id
   JOIN app.custody_institutions ci ON ci.id=p.institution_id
   LEFT JOIN app.source_assertions sa ON sa.household_id=p.household_id AND sa.id=p.source_assertion_id
   LEFT JOIN app.source_documents sd ON sd.household_id=sa.household_id AND sd.id=sa.document_id
   LEFT JOIN LATERAL (SELECT id,custody_account_id,revision FROM app.position_identity_resolutions x
     WHERE x.household_id=p.household_id AND x.position_id=p.id ORDER BY revision DESC LIMIT 1) r ON true
   LEFT JOIN app.custody_accounts ca ON ca.household_id=p.household_id AND ca.id=COALESCE(r.custody_account_id,p.custody_account_id)
   LEFT JOIN LATERAL (SELECT decision FROM app.position_identity_resolutions x
     WHERE x.household_id=p.household_id AND x.position_id=p.id ORDER BY revision DESC LIMIT 1) ir ON true
   LEFT JOIN LATERAL (SELECT parser_version,status,review_reasons FROM app.source_interpretations x
     WHERE x.household_id=sa.household_id AND x.assertion_id=sa.id ORDER BY interpreted_at DESC,parser_version DESC LIMIT 1) si ON true
   WHERE p.household_id=$1 ORDER BY o.display_name,ci.canonical_name,p.instrument_code,p.currency,p.id`,[household]);
 return {positions:result.rows,mode:'shadow',authoritative:false as const,portfolio_changed:false as const};
}

export async function listAcquisitionLots(db:pg.Pool,household:string,positionId:string){
 if(!UUID.test(positionId))throw new Conflict('VALIDATION',422);
 const [result,position]=await Promise.all([db.query(`SELECT id AS acquisition_id,revision,effective_date,quantity,unit_price,fees_minor,currency,
   evidence_kind,evidence_id,voided,recorded_at,supersedes_id,supersedes_revision
   FROM app.acquisition_lots WHERE household_id=$1 AND position_id=$2
   ORDER BY effective_date,recorded_at,id,revision`,[household,positionId]),db.query(`SELECT p.instrument_code,p.currency,sd.effective_as_of::text AS snapshot_as_of,sa.quantity::text AS snapshot_quantity
   FROM app.position_identities p LEFT JOIN app.source_assertions sa ON sa.household_id=p.household_id AND sa.id=p.source_assertion_id
   LEFT JOIN app.source_documents sd ON sd.household_id=sa.household_id AND sd.id=sa.document_id
   WHERE p.household_id=$1 AND p.id=$2`,[household,positionId])]);
 if(!position.rowCount)throw new Conflict('NOT_FOUND',404);
 const snapshot=position.rows[0],currentLots=effectiveAcquisitionLots(result.rows);
 return {position_id:positionId,lots:result.rows,current_lots:currentLots,quantity_comparison:summarizeAcquisitionQuantity(snapshot.snapshot_as_of,snapshot.snapshot_quantity===null?null:String(snapshot.snapshot_quantity),currentLots),mode:'shadow',authoritative:false as const,portfolio_changed:false as const};
}

export async function listAcquisitionReconciliation(db:pg.Pool,household:string){
 const result=await db.query(`WITH latest_lots AS (
   SELECT DISTINCT ON (l.household_id,l.id) l.household_id,l.id,l.position_id,l.effective_date,l.quantity,l.voided
   FROM app.acquisition_lots l WHERE l.household_id=$1 ORDER BY l.household_id,l.id,l.revision DESC
 ), rollup AS (
   SELECT position_id,count(*)::int AS current_lot_count,count(*) FILTER (WHERE NOT voided)::int AS active_lot_count,
     COALESCE(sum(quantity) FILTER (WHERE NOT voided),0)::text AS current_gross_acquisition_quantity,max(effective_date)::text AS latest_lot_date
   FROM latest_lots GROUP BY position_id
 ), identities AS (
   SELECT p.id AS position_id,o.display_name AS owner,ci.canonical_name AS institution,
     COALESCE(ir.custody_account_id,p.custody_account_id) AS custody_account_id,p.instrument_code,p.currency,
     sd.effective_as_of::text AS snapshot_as_of,sa.quantity::text AS snapshot_quantity,
     COALESCE(r.current_lot_count,0)::int AS current_lot_count,COALESCE(r.active_lot_count,0)::int AS active_lot_count,
     COALESCE(r.current_gross_acquisition_quantity,'0') AS current_gross_acquisition_quantity,r.latest_lot_date
   FROM app.position_identities p JOIN app.owners o ON o.household_id=p.household_id AND o.id=p.owner_id
   JOIN app.custody_institutions ci ON ci.id=p.institution_id
   LEFT JOIN LATERAL (SELECT custody_account_id FROM app.position_identity_resolutions x WHERE x.household_id=p.household_id AND x.position_id=p.id ORDER BY revision DESC LIMIT 1) ir ON true
   LEFT JOIN app.source_assertions sa ON sa.household_id=p.household_id AND sa.id=p.source_assertion_id
   LEFT JOIN app.source_documents sd ON sd.household_id=sa.household_id AND sd.id=sa.document_id
   LEFT JOIN rollup r ON r.position_id=p.id WHERE p.household_id=$1
 )
 SELECT *,CASE WHEN snapshot_as_of IS NULL OR snapshot_quantity IS NULL THEN 'no_snapshot_quantity'
   WHEN current_lot_count=0 THEN 'no_acquisition_lots'
   WHEN latest_lot_date>snapshot_as_of THEN 'lots_after_snapshot'
   WHEN current_gross_acquisition_quantity::numeric=snapshot_quantity::numeric THEN 'matches_snapshot'
   WHEN current_gross_acquisition_quantity::numeric>snapshot_quantity::numeric THEN 'acquisitions_exceed_snapshot'
   ELSE 'snapshot_exceeds_acquisitions' END AS status,
   CASE WHEN snapshot_as_of IS NULL OR snapshot_quantity IS NULL OR current_lot_count=0 OR latest_lot_date>snapshot_as_of THEN NULL
     ELSE (snapshot_quantity::numeric-current_gross_acquisition_quantity::numeric)::text END AS snapshot_minus_gross_acquisitions
 FROM identities ORDER BY owner,institution,instrument_code,currency,position_id`,[household]);
 const statusCounts:Record<string,number>={};for(const row of result.rows)statusCounts[row.status]=(statusCounts[row.status]??0)+1;
 return {positions:result.rows,position_count:result.rowCount??0,status_counts:statusCounts,mode:'shadow',authoritative:false as const,portfolio_changed:false as const};
}

export async function listPositionAccountCandidates(db:pg.Pool,household:string,positionId:string){
 if(!UUID.test(positionId))throw new Conflict('VALIDATION',422);
 const result=await db.query(`SELECT p.id AS position_id,o.display_name AS owner,ci.canonical_name AS institution,
   ca.id AS custody_account_id,ca.external_reference,ca.identity_basis,
   CASE WHEN ca.id IS NULL THEN 'no_registered_account' ELSE 'select_or_confirm' END AS candidate_status
   FROM app.position_identities p JOIN app.owners o ON o.household_id=p.household_id AND o.id=p.owner_id
   JOIN app.custody_institutions ci ON ci.id=p.institution_id
   LEFT JOIN app.custody_accounts ca ON ca.household_id=p.household_id AND ca.owner_id=p.owner_id AND ca.institution_id=p.institution_id
   WHERE p.household_id=$1 AND p.id=$2 ORDER BY ca.id`,[household,positionId]);
 if(!result.rowCount)throw new Conflict('NOT_FOUND',404);
 return {position_id:positionId,owner:result.rows[0].owner,institution:result.rows[0].institution,
   candidates:result.rows.filter(row=>row.custody_account_id),resolution_required:result.rows[0].custody_account_id===null,
   mode:'shadow',portfolio_changed:false as const};
}

export async function recordPositionIdentityResolution(db:pg.Pool,household:string,actor:string,positionId:string,body:unknown){
 if(!UUID.test(positionId)||!body||typeof body!=='object'||Array.isArray(body))throw new Conflict('VALIDATION',422);
 const input=body as Record<string,unknown>;
 if(Object.keys(input).some(key=>!['request_key','custody_account_id','assertion_id','decision'].includes(key))||
   typeof input.request_key!=='string'||!KEY.test(input.request_key)||typeof input.custody_account_id!=='string'||input.custody_account_id.length<1||input.custody_account_id.length>200||
   (input.assertion_id!==undefined&&(typeof input.assertion_id!=='string'||input.assertion_id.length<1||input.assertion_id.length>200))||
   !['user_confirmed','institution_uniqueness_confirmed'].includes(String(input.decision)))throw new Conflict('VALIDATION',422);
 const value={request_key:input.request_key,custody_account_id:input.custody_account_id,assertion_id:input.assertion_id??null,decision:input.decision};
 const requestHash=hash(JSON.stringify([positionId,value]));const c=await db.connect();
 try{
  await c.query('BEGIN');
  const member=await c.query("SELECT 1 FROM app.memberships WHERE household_id=$1 AND actor_id=$2 AND role IN ('reviewer','owner','approver')",[household,actor]);
  if(!member.rowCount)throw new Conflict('FORBIDDEN',403);
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${household}:${actor}:${value.request_key}`]);
  const replay=await c.query('SELECT id,position_id,custody_account_id,assertion_id,decision,revision,request_hash FROM app.position_identity_resolutions WHERE household_id=$1 AND actor_id=$2 AND request_key=$3',[household,actor,value.request_key]);
  if(replay.rowCount){const row=replay.rows[0];if(row.request_hash!==requestHash)throw new Conflict('IDEMPOTENCY_MISMATCH',409);await c.query('COMMIT');return{resolution_id:row.id,position_id:row.position_id,custody_account_id:row.custody_account_id,revision:row.revision,replayed:true,mode:'shadow',portfolio_changed:false};}
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${household}:position:${positionId}`]);
  const position=await c.query('SELECT owner_id,institution_id,instrument_code,currency,source_assertion_id FROM app.position_identities WHERE household_id=$1 AND id=$2 FOR UPDATE',[household,positionId]);
  if(!position.rowCount)throw new Conflict('NOT_FOUND',404);
  const p=position.rows[0];
  const account=await c.query('SELECT owner_id,institution_id FROM app.custody_accounts WHERE household_id=$1 AND id=$2',[household,value.custody_account_id]);
  if(!account.rowCount||account.rows[0].owner_id!==p.owner_id||account.rows[0].institution_id!==p.institution_id)throw new Conflict('ACCOUNT_IDENTITY_MISMATCH',422);
  if(value.assertion_id&&value.assertion_id!==p.source_assertion_id)throw new Conflict('ASSERTION_MISMATCH',422);
  const accountCount=await c.query('SELECT count(*) FROM app.custody_accounts WHERE household_id=$1 AND owner_id=$2 AND institution_id=$3',[household,p.owner_id,p.institution_id]);
  if(value.decision==='institution_uniqueness_confirmed'&&Number(accountCount.rows[0].count)!==1)throw new Conflict('ACCOUNT_NOT_UNIQUE',409);
  const collision=await c.query(`SELECT 1 FROM app.position_identities x
   LEFT JOIN LATERAL (SELECT custody_account_id FROM app.position_identity_resolutions r WHERE r.household_id=x.household_id AND r.position_id=x.id ORDER BY revision DESC LIMIT 1) lr ON true
   WHERE x.household_id=$1 AND x.id<>$2 AND x.owner_id=$3 AND x.instrument_code=$4 AND x.currency=$5
     AND COALESCE(lr.custody_account_id,x.custody_account_id)=$6 LIMIT 1`,[household,positionId,p.owner_id,p.instrument_code,p.currency,value.custody_account_id]);
  if(collision.rowCount)throw new Conflict('ACCOUNT_POSITION_COLLISION',409);
  const latest=await c.query('SELECT id,revision,custody_account_id,assertion_id,decision FROM app.position_identity_resolutions WHERE household_id=$1 AND position_id=$2 ORDER BY revision DESC LIMIT 1',[household,positionId]);
  if(latest.rowCount&&latest.rows[0].custody_account_id===value.custody_account_id&&latest.rows[0].assertion_id===value.assertion_id&&latest.rows[0].decision===value.decision){await c.query('COMMIT');return{resolution_id:latest.rows[0].id,position_id:positionId,custody_account_id:value.custody_account_id,revision:latest.rows[0].revision,replayed:true,mode:'shadow',portfolio_changed:false};}
  const revision=Number(latest.rows[0]?.revision??0)+1,id=randomUUID();
  await c.query(`INSERT INTO app.position_identity_resolutions(household_id,id,position_id,revision,custody_account_id,assertion_id,decision,actor_id,request_key,request_hash,supersedes_id)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[household,id,positionId,revision,value.custody_account_id,value.assertion_id,value.decision,actor,value.request_key,requestHash,latest.rows[0]?.id??null]);
  await c.query("INSERT INTO app.audit_log(household_id,actor_id,action,resource_id,details) VALUES($1,$2,'position_identity_resolved',$3,$4)",[household,actor,id,{position_id:positionId,custody_account_id:value.custody_account_id,assertion_id:value.assertion_id,decision:value.decision,revision,portfolio_changed:false}]);
  await c.query('COMMIT');return{resolution_id:id,position_id:positionId,custody_account_id:value.custody_account_id,revision,replayed:false,mode:'shadow',portfolio_changed:false};
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}

export async function recordAcquisitionLot(db:pg.Pool,household:string,actor:string,positionId:string,body:unknown){
 if(!UUID.test(positionId)||!body||typeof body!=='object'||Array.isArray(body))throw new Conflict('VALIDATION',422);
 const input=body as Record<string,unknown>;
 const allowed=['request_key','acquisition_id','supersedes_revision','effective_date','quantity','unit_price','fees_minor','currency','evidence_kind','evidence_id','voided'];
 if(Object.keys(input).some(key=>!allowed.includes(key))||typeof input.request_key!=='string'||!KEY.test(input.request_key)||
   (input.acquisition_id!==undefined&&(typeof input.acquisition_id!=='string'||!UUID.test(input.acquisition_id)))||
   (input.supersedes_revision!==undefined&&(!Number.isInteger(input.supersedes_revision)||Number(input.supersedes_revision)<1))||
   typeof input.effective_date!=='string'||!validDate(input.effective_date)||
   typeof input.quantity!=='string'||!DECIMAL.test(input.quantity)||Number(input.quantity)<=0||
   typeof input.unit_price!=='string'||!DECIMAL.test(input.unit_price)||Number(input.unit_price)<=0||
   (input.fees_minor!==undefined&&input.fees_minor!==null&&(!Number.isSafeInteger(input.fees_minor)||Number(input.fees_minor)<0))||
   !['BRL','USD'].includes(String(input.currency))||
   !['source_assertion','event','manual','legacy_review'].includes(String(input.evidence_kind))||
   typeof input.evidence_id!=='string'||input.evidence_id.length<1||input.evidence_id.length>500||
   (input.voided!==undefined&&typeof input.voided!=='boolean'))throw new Conflict('VALIDATION',422);
 const value={request_key:input.request_key,acquisition_id:String(input.acquisition_id??randomUUID()),supersedes_revision:input.supersedes_revision as number|undefined,
  effective_date:input.effective_date,quantity:input.quantity,unit_price:input.unit_price,fees_minor:input.fees_minor===undefined||input.fees_minor===null?null:Number(input.fees_minor),currency:input.currency,
  evidence_kind:input.evidence_kind,evidence_id:input.evidence_id,voided:Boolean(input.voided??false)};
 const requestHash=hash(JSON.stringify([positionId,{...value,acquisition_id:input.acquisition_id??null}]));const c=await db.connect();
 try{
  await c.query('BEGIN');
  const member=await c.query("SELECT 1 FROM app.memberships WHERE household_id=$1 AND actor_id=$2 AND role IN ('reviewer','owner','approver')",[household,actor]);
  if(!member.rowCount)throw new Conflict('FORBIDDEN',403);
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${household}:${actor}:${value.request_key}`]);
  const replay=await c.query('SELECT id,revision,request_hash FROM app.acquisition_lots WHERE household_id=$1 AND actor_id=$2 AND request_key=$3',[household,actor,value.request_key]);
  if(replay.rowCount){
   const row=replay.rows[0];if(row.request_hash!==requestHash)throw new Conflict('IDEMPOTENCY_MISMATCH',409);
   await c.query('COMMIT');return {acquisition_id:row.id,revision:row.revision,replayed:true,mode:'shadow',portfolio_changed:false};
  }
  const position=await c.query(`SELECT p.owner_id,p.institution_id,p.instrument_code,p.currency,
    COALESCE(r.custody_account_id,p.custody_account_id) AS custody_account_id
    FROM app.position_identities p LEFT JOIN LATERAL(SELECT custody_account_id FROM app.position_identity_resolutions x
      WHERE x.household_id=p.household_id AND x.position_id=p.id ORDER BY revision DESC LIMIT 1) r ON true
    WHERE p.household_id=$1 AND p.id=$2`,[household,positionId]);
  if(!position.rowCount)throw new Conflict('NOT_FOUND',404);
  if(position.rows[0].currency!==value.currency)throw new Conflict('CURRENCY_MISMATCH',422);
  if(value.evidence_kind==='source_assertion'){
   const source=await c.query(`SELECT a.assertion_kind,a.owner_id,a.institution_id,a.custody_account_id,a.asserted_on::text AS effective_date,
     a.direction,a.quantity::text AS quantity,a.raw_row->>'Preço unitário' AS unit_price,a.interpretation_status,
     COALESCE(i.instrument_code,a.instrument_code) AS instrument_code,COALESCE(i.tentative_event_type,a.tentative_event_type) AS event_type,i.status AS parser_status
     FROM app.source_assertions a LEFT JOIN LATERAL(SELECT instrument_code,tentative_event_type,status FROM app.source_interpretations x
       WHERE x.household_id=a.household_id AND x.assertion_id=a.id ORDER BY interpreted_at DESC,parser_version DESC LIMIT 1)i ON true
     WHERE a.household_id=$1 AND a.id=$2`,[household,value.evidence_id]);
   if(!source.rowCount)throw new Conflict('EVIDENCE_NOT_FOUND',422);
   const s=source.rows[0],p=position.rows[0];let price=null;
   try{price=localized(s.unit_price);}catch{throw new Conflict('EVIDENCE_MISMATCH',422);}
   if(s.assertion_kind!=='movement'||s.event_type!=='acquisition_observation'||s.parser_status!=='parsed'||norm(s.direction)!=='CREDITO'||
      s.owner_id!==p.owner_id||s.institution_id!==p.institution_id||s.instrument_code!==p.instrument_code||
      (p.custody_account_id&&s.custody_account_id!==p.custody_account_id)||
      s.effective_date!==value.effective_date||s.quantity===null||!exact(String(s.quantity)).eq(exact(String(value.quantity)))||
      !price||!price.eq(exact(String(value.unit_price))))throw new Conflict('EVIDENCE_MISMATCH',422);
  }
  let revision=1,supersedesId:null|string=null,supersedesRevision:null|number=null;
  if(value.supersedes_revision!==undefined){
   if(!input.acquisition_id)throw new Conflict('VALIDATION',422);
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${household}:lot:${value.acquisition_id}`]);
   const previous=await c.query('SELECT revision,position_id FROM app.acquisition_lots WHERE household_id=$1 AND id=$2 ORDER BY revision DESC LIMIT 1 FOR UPDATE',[household,value.acquisition_id]);
   if(!previous.rowCount)throw new Conflict('NOT_FOUND',404);
   if(previous.rows[0].position_id!==positionId||Number(previous.rows[0].revision)!==value.supersedes_revision)throw new Conflict('STALE_REVISION',409);
   revision=value.supersedes_revision+1;supersedesId=value.acquisition_id;supersedesRevision=value.supersedes_revision;
  }else if(input.acquisition_id)throw new Conflict('VALIDATION',422);
  await c.query(`INSERT INTO app.acquisition_lots(household_id,id,position_id,revision,effective_date,quantity,unit_price,fees_minor,currency,evidence_kind,evidence_id,request_key,request_hash,actor_id,supersedes_id,supersedes_revision,voided)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,[household,value.acquisition_id,positionId,revision,value.effective_date,value.quantity,value.unit_price,value.fees_minor,value.currency,value.evidence_kind,value.evidence_id,value.request_key,requestHash,actor,supersedesId,supersedesRevision,value.voided]);
  await c.query("INSERT INTO app.audit_log(household_id,actor_id,action,resource_id,details) VALUES($1,$2,'acquisition_lot_recorded',$3,$4)",[household,actor,value.acquisition_id,{position_id:positionId,revision,evidence_kind:value.evidence_kind,evidence_id:value.evidence_id,portfolio_changed:false}]);
  await c.query('COMMIT');return {acquisition_id:value.acquisition_id,revision,replayed:false,mode:'shadow',portfolio_changed:false};
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
