import {createHash,randomUUID} from 'node:crypto';
import type pg from 'pg';
import {Conflict} from './commands.ts';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY=/^[A-Za-z0-9._:-]{8,128}$/;
const ALLOWED=['reference_date','institution','plan_number','fund_name','fund_cnpj','source_locator'];
function metadata(value:unknown){
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Conflict('VALIDATION',422);
 const input=value as Record<string,unknown>,result:Record<string,string>={};
 if(!Object.keys(input).length||Object.keys(input).some(k=>!ALLOWED.includes(k)))throw new Conflict('VALIDATION',422);
 for(const key of ALLOWED){if(!(key in input))continue;const v=input[key];if(typeof v!=='string'||!v.trim()||v.trim().length>(key==='source_locator'?240:180))throw new Conflict('VALIDATION',422);result[key]=v.trim();}
 if(result.reference_date){const d=new Date(result.reference_date+'T00:00:00Z');if(!/^\d{4}-\d{2}-\d{2}$/.test(result.reference_date)||!Number.isFinite(d.valueOf())||d.toISOString().slice(0,10)!==result.reference_date)throw new Conflict('VALIDATION',422);}
 if(result.fund_cnpj){result.fund_cnpj=result.fund_cnpj.replace(/[^0-9]/g,'');if(!/^\d{14}$/.test(result.fund_cnpj))throw new Conflict('VALIDATION',422);}
 if((result.fund_name||result.fund_cnpj)&&!result.plan_number)throw new Conflict('PLAN_REQUIRED',422);
 return result;
}
export async function listPhotoClarifications(db:pg.Pool,household:string,id:string){
 if(!UUID.test(id))throw new Conflict('NOT_FOUND',404);const photo=await db.query('SELECT upload_id,owner_id,status FROM app.manual_photo_evidence WHERE household_id=$1 AND upload_id=$2',[household,id]);if(!photo.rowCount)throw new Conflict('NOT_FOUND',404);
 const result=await db.query('SELECT id,scope,revision,metadata,provenance,actor_id,supersedes_id,created_at FROM app.photo_evidence_clarifications WHERE household_id=$1 AND upload_id=$2 ORDER BY scope,revision',[household,id]);return {upload_id:id,owner_id:photo.rows[0].owner_id,evidence_status:photo.rows[0].status,clarifications:result.rows,portfolio_changed:false};
}
export async function recordPhotoClarification(db:pg.Pool,household:string,actor:string,id:string,body:unknown){
 if(!UUID.test(id)||!body||typeof body!=='object'||Array.isArray(body))throw new Conflict('VALIDATION',422);const b=body as Record<string,unknown>;
 if(Object.keys(b).some(k=>!['request_key','metadata','provenance'].includes(k))||typeof b.request_key!=='string'||!KEY.test(b.request_key)||typeof b.provenance!=='string'||!b.provenance.trim()||b.provenance.trim().length>1000)throw new Conflict('VALIDATION',422);
 const values=metadata(b.metadata),scope=values.plan_number?'plan:'+values.plan_number:'evidence',provenance=b.provenance.trim(),hash=createHash('sha256').update(JSON.stringify([id,scope,values,provenance])).digest('hex'),c=await db.connect();
 try{await c.query('BEGIN');const member=await c.query("SELECT 1 FROM app.memberships WHERE household_id=$1 AND actor_id=$2 AND role IN ('owner','approver','reviewer')",[household,actor]);if(!member.rowCount)throw new Conflict('FORBIDDEN',403);
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${household}:photo-clarification-request:${actor}:${b.request_key}`]);await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${household}:photo-clarification:${id}:${scope}`]);
  const photo=await c.query('SELECT owner_id FROM app.manual_photo_evidence WHERE household_id=$1 AND upload_id=$2',[household,id]);if(!photo.rowCount)throw new Conflict('NOT_FOUND',404);
  const prior=await c.query('SELECT id,revision,request_hash FROM app.photo_evidence_clarifications WHERE household_id=$1 AND actor_id=$2 AND request_key=$3',[household,actor,b.request_key]);if(prior.rowCount){if(prior.rows[0].request_hash!==hash)throw new Conflict('IDEMPOTENCY_MISMATCH',409);await c.query('COMMIT');return {clarification_id:prior.rows[0].id,revision:prior.rows[0].revision,replayed:true,portfolio_changed:false};}
  const latest=await c.query('SELECT id,revision,metadata,provenance FROM app.photo_evidence_clarifications WHERE household_id=$1 AND upload_id=$2 AND scope=$3 ORDER BY revision DESC LIMIT 1',[household,id,scope]);
  const merged={...(latest.rows[0]?.metadata??{}),...values},revision=Number(latest.rows[0]?.revision??0)+1,clarificationId=randomUUID();
  await c.query('INSERT INTO app.photo_evidence_clarifications(household_id,id,upload_id,scope,revision,metadata,provenance,actor_id,request_key,request_hash,supersedes_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[household,clarificationId,id,scope,revision,JSON.stringify(merged),provenance,actor,b.request_key,hash,latest.rows[0]?.id??null]);
  await c.query("INSERT INTO app.audit_log(household_id,actor_id,action,resource_id,details) VALUES($1,$2,'photo_clarification_recorded',$3,$4)",[household,actor,clarificationId,{upload_id:id,scope,revision,portfolio_changed:false}]);await c.query('COMMIT');return {clarification_id:clarificationId,revision,replayed:false,portfolio_changed:false};
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
