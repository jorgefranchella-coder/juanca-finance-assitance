import {createHash,randomUUID} from 'node:crypto';
import type pg from 'pg';
import {Conflict} from './commands.ts';

const KEY=/^[A-Za-z0-9._:-]{8,128}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE=/^\d{4}-\d{2}-\d{2}$/;
const DECIMAL=/^\d{1,18}(?:\.\d{1,10})?$/;
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const validDate=(value:string)=>{if(!DATE.test(value))return false;const date=new Date(value+'T00:00:00Z');return !Number.isNaN(date.valueOf())&&date.toISOString().slice(0,10)===value;};

export async function listPositionIdentities(db:pg.Pool,household:string){
 const result=await db.query(`SELECT p.id AS position_id,p.owner_id,o.display_name AS owner,p.institution_id,ci.canonical_name AS institution,
   COALESCE(r.custody_account_id,p.custody_account_id) AS custody_account_id,
   CASE WHEN r.id IS NOT NULL OR p.identity_status='resolved' THEN 'resolved' ELSE 'provisional' END AS identity_status,
   p.instrument_code,p.currency,r.revision AS identity_revision
   FROM app.position_identities p JOIN app.owners o ON o.household_id=p.household_id AND o.id=p.owner_id
   JOIN app.custody_institutions ci ON ci.id=p.institution_id
   LEFT JOIN LATERAL (SELECT id,custody_account_id,revision FROM app.position_identity_resolutions x
     WHERE x.household_id=p.household_id AND x.position_id=p.id ORDER BY revision DESC LIMIT 1) r ON true
   WHERE p.household_id=$1 ORDER BY o.display_name,ci.canonical_name,p.instrument_code,p.currency,p.id`,[household]);
 return {positions:result.rows,mode:'shadow',authoritative:false as const,portfolio_changed:false as const};
}

export async function listAcquisitionLots(db:pg.Pool,household:string,positionId:string){
 if(!UUID.test(positionId))throw new Conflict('VALIDATION',422);
 const result=await db.query(`SELECT id AS acquisition_id,revision,effective_date,quantity,unit_price,fees_minor,currency,
   evidence_kind,evidence_id,voided,recorded_at,supersedes_id,supersedes_revision
   FROM app.acquisition_lots WHERE household_id=$1 AND position_id=$2
   ORDER BY effective_date,recorded_at,id,revision`,[household,positionId]);
 return {position_id:positionId,lots:result.rows,mode:'shadow',authoritative:false as const,portfolio_changed:false as const};
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
   (input.fees_minor!==undefined&&(!Number.isSafeInteger(input.fees_minor)||Number(input.fees_minor)<0))||
   !['BRL','USD'].includes(String(input.currency))||
   !['source_assertion','event','manual','legacy_review'].includes(String(input.evidence_kind))||
   typeof input.evidence_id!=='string'||input.evidence_id.length<1||input.evidence_id.length>500||
   (input.voided!==undefined&&typeof input.voided!=='boolean'))throw new Conflict('VALIDATION',422);
 const value={request_key:input.request_key,acquisition_id:String(input.acquisition_id??randomUUID()),supersedes_revision:input.supersedes_revision as number|undefined,
  effective_date:input.effective_date,quantity:input.quantity,unit_price:input.unit_price,fees_minor:Number(input.fees_minor??0),currency:input.currency,
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
  const position=await c.query('SELECT currency FROM app.position_identities WHERE household_id=$1 AND id=$2',[household,positionId]);
  if(!position.rowCount)throw new Conflict('NOT_FOUND',404);
  if(position.rows[0].currency!==value.currency)throw new Conflict('CURRENCY_MISMATCH',422);
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
