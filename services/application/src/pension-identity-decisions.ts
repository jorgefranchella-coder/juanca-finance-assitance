import {createHash,randomUUID} from 'node:crypto';
import type pg from 'pg';
import {Conflict} from './commands.ts';
const KEY=/^[A-Za-z0-9._:-]{8,128}$/;
const ID=/^[A-Za-z0-9._:-]{1,240}$/;
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
/** A user decision records interpretation only; publication remains a separate action. */
export async function recordPensionIdentityDecision(db:pg.Pool,household:string,actor:string,body:unknown){
 if(!body||typeof body!=='object'||Array.isArray(body))throw new Conflict('VALIDATION',422);const x=body as Record<string,unknown>;
 if(Object.keys(x).some(k=>!['request_key','assertion_id','plan_number','fund_name','fund_cnpj','source_locator'].includes(k))||typeof x.request_key!=='string'||!KEY.test(x.request_key)||typeof x.assertion_id!=='string'||!ID.test(x.assertion_id))throw new Conflict('VALIDATION',422);
 const plan=typeof x.plan_number==='string'?x.plan_number.trim():'',fund=typeof x.fund_name==='string'?x.fund_name.trim():'',cnpj=typeof x.fund_cnpj==='string'?x.fund_cnpj.replace(/\D/g,''):'',locator=typeof x.source_locator==='string'?x.source_locator.trim():'';
 if(!plan||plan.length>100||!fund||fund.length>180||!/^\d{14}$/.test(cnpj)||!locator||locator.length>240)throw new Conflict('VALIDATION',422);
 const hash=digest(JSON.stringify([x.assertion_id,plan,fund,cnpj,locator])),c=await db.connect();try{await c.query('BEGIN');const member=await c.query("SELECT 1 FROM app.memberships WHERE household_id=$1 AND actor_id=$2 AND role IN ('owner','approver')",[household,actor]);if(!member.rowCount)throw new Conflict('FORBIDDEN',403);
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${household}:pension-identity-request:${actor}:${x.request_key}`]);
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${household}:pension-identity:${x.assertion_id}`]);
  const old=await c.query('SELECT id,revision,request_hash FROM app.pension_identity_decisions WHERE household_id=$1 AND actor_id=$2 AND request_key=$3',[household,actor,x.request_key]);if(old.rowCount){if(old.rows[0].request_hash!==hash)throw new Conflict('IDEMPOTENCY_MISMATCH',409);await c.query('COMMIT');return {decision_id:old.rows[0].id,revision:old.rows[0].revision,replayed:true,portfolio_changed:false};}
  const assertion=await c.query(`SELECT a.id,a.raw_row FROM app.source_assertions a JOIN app.source_documents d ON d.household_id=a.household_id AND d.id=a.document_id WHERE a.household_id=$1 AND a.id=$2 AND a.assertion_kind='position' AND d.report_kind='position' AND d.source_system NOT IN ('B3','Avenue')`,[household,x.assertion_id]);if(!assertion.rowCount)throw new Conflict('PENSION_ASSERTION_NOT_FOUND',404);if(assertion.rows[0].raw_row?.carry_from)throw new Conflict('PENSION_CARRIED_IDENTITY_READ_ONLY',409);if(Array.isArray(assertion.rows[0].raw_row?.plans)&&assertion.rows[0].raw_row.plans.length>1)throw new Conflict('PENSION_AGGREGATED_PLANS_REQUIRES_SPLIT',422);
  const previous=await c.query('SELECT id,revision FROM app.pension_identity_decisions WHERE household_id=$1 AND assertion_id=$2 ORDER BY revision DESC LIMIT 1 FOR UPDATE',[household,x.assertion_id]),id=randomUUID(),revision=Number(previous.rows[0]?.revision??0)+1;
  await c.query(`INSERT INTO app.pension_identity_decisions(household_id,id,assertion_id,revision,plan_number,fund_name,fund_cnpj,source_locator,actor_id,request_key,request_hash,supersedes_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[household,id,x.assertion_id,revision,plan,fund,cnpj,locator,actor,x.request_key,hash,previous.rows[0]?.id??null]);
  await c.query("INSERT INTO app.audit_log(household_id,actor_id,action,resource_id,details) VALUES($1,$2,'pension_identity_decided',$3,$4)",[household,actor,id,{assertion_id:x.assertion_id,revision,source_locator:locator,portfolio_changed:false}]);await c.query('COMMIT');return {decision_id:id,revision,replayed:false,portfolio_changed:false};
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
