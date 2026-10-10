import {createHash,randomUUID} from 'node:crypto';
import type pg from 'pg';
import {Conflict} from './commands.ts';
import {listManualB3Candidates} from './manual-b3-candidates.ts';

type Input={request_key:string;intake_id:string;assertion_id:string;decision:'related'|'not_related'};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY=/^[A-Za-z0-9._:-]{8,128}$/;

export async function recordManualB3Decision(db:pg.Pool,household:string,actor:string,body:unknown){
 if(!body||typeof body!=='object'||Array.isArray(body))throw new Conflict('VALIDATION',422);
 const input=body as Record<string,unknown>;
 if(Object.keys(input).some(k=>!['request_key','intake_id','assertion_id','decision'].includes(k))||typeof input.request_key!=='string'||!KEY.test(input.request_key)||typeof input.intake_id!=='string'||!UUID.test(input.intake_id)||typeof input.assertion_id!=='string'||!KEY.test(input.assertion_id)||!['related','not_related'].includes(String(input.decision)))throw new Conflict('VALIDATION',422);
 const value=input as Input;
 const digest=createHash('sha256').update(JSON.stringify([value.intake_id,value.assertion_id,value.decision])).digest('hex');
 const c=await db.connect();
 try{
  await c.query('BEGIN');
  const member=await c.query("SELECT 1 FROM app.memberships WHERE household_id=$1 AND actor_id=$2 AND role IN ('reviewer','owner','approver')",[household,actor]);
  if(!member.rowCount)throw new Conflict('FORBIDDEN',403);
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`${household}:${actor}:${value.request_key}`]);
  const prior=await c.query('SELECT id,request_hash,decision,revision FROM app.manual_b3_link_decisions WHERE household_id=$1 AND actor_id=$2 AND request_key=$3',[household,actor,value.request_key]);
  if(prior.rowCount){if(prior.rows[0].request_hash!==digest)throw new Conflict('IDEMPOTENCY_MISMATCH',409);await c.query('COMMIT');return{decision_id:prior.rows[0].id,decision:prior.rows[0].decision,revision:prior.rows[0].revision,replayed:true,mode:'shadow',portfolio_changed:false};}
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`${household}:${value.intake_id}:${value.assertion_id}`]);
  const current=await c.query('SELECT id,revision,decision FROM app.manual_b3_link_decisions WHERE household_id=$1 AND intake_id=$2 AND assertion_id=$3 ORDER BY revision DESC LIMIT 1',[household,value.intake_id,value.assertion_id]);
  const candidates=await listManualB3Candidates(db,household);
  const candidate=candidates.candidates.find(entry=>entry.intake_id===value.intake_id&&Array.isArray(entry.candidates)&&entry.candidates.some((item:{assertion_id?:string})=>item.assertion_id===value.assertion_id));
  if(!candidate)throw new Conflict('STALE_CANDIDATE',409);
  if(current.rows[0]?.decision===value.decision){await c.query('COMMIT');return{decision_id:current.rows[0].id,decision:value.decision,revision:current.rows[0].revision,replayed:true,mode:'shadow',portfolio_changed:false};}
  const revision=Number(current.rows[0]?.revision??0)+1,id=randomUUID();
  await c.query(`INSERT INTO app.manual_b3_link_decisions(household_id,id,intake_id,assertion_id,revision,decision,actor_id,request_key,request_hash,supersedes_id)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[household,id,value.intake_id,value.assertion_id,revision,value.decision,actor,value.request_key,digest,current.rows[0]?.id??null]);
  await c.query("INSERT INTO app.audit_log(household_id,actor_id,action,resource_id,details) VALUES($1,$2,'manual_b3_link_decision',$3,$4)",[household,actor,id,{intake_id:value.intake_id,assertion_id:value.assertion_id,decision:value.decision,revision,portfolio_changed:false}]);
  await c.query('COMMIT');
  return{decision_id:id,decision:value.decision,revision,replayed:false,mode:'shadow',portfolio_changed:false};
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
