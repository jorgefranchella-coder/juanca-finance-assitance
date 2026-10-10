import type pg from 'pg';
import {exact,integer,minor,D} from './money.ts';
import {hash} from './migration.ts';
export class Conflict extends Error{code:string;status:number;constructor(code:string,status=409){super(code);this.code=code;this.status=status;}}
export type Approval={version:number;summary_hash:string;expected_facts_revision:string};
export async function approve(db:pg.Pool,h:string,actor:string,id:string,key:string,body:Approval){
 if(!/^[A-Za-z0-9_-]{8,100}$/.test(key)||!Number.isInteger(body.version)||!/^\d+$/.test(body.expected_facts_revision)||!body.summary_hash)throw new Conflict('VALIDATION',422);
 const digest=hash(JSON.stringify([id,body.version,body.summary_hash,body.expected_facts_revision]));const c=await db.connect();
 try{
  await c.query('BEGIN');
  const member=await c.query("SELECT 1 FROM app.memberships WHERE household_id=$1 AND actor_id=$2 AND role IN ('owner','approver')",[h,actor]);if(!member.rowCount)throw new Conflict('FORBIDDEN',403);
  const state=await c.query('SELECT facts_revision FROM app.household_state WHERE household_id=$1 FOR UPDATE',[h]);if(!state.rowCount)throw new Conflict('NOT_FOUND',404);
  const old=await c.query('SELECT request_hash,result FROM app.command_results WHERE household_id=$1 AND actor_id=$2 AND idempotency_key=$3',[h,actor,key]);
  if(old.rowCount){if(old.rows[0].request_hash!==digest)throw new Conflict('IDEMPOTENCY_MISMATCH');await c.query('COMMIT');return {...old.rows[0].result,replayed:true};}
  const proposal=await c.query('SELECT * FROM app.proposals WHERE household_id=$1 AND id=$2 FOR UPDATE',[h,id]);if(!proposal.rowCount)throw new Conflict('NOT_FOUND',404);const p=proposal.rows[0];
  if(p.version!==body.version||p.summary_hash!==body.summary_hash)throw new Conflict('PROPOSAL_CHANGED');
  if(p.status==='applied'){const result={proposal_id:id,event_id:p.applied_event_id,status:'applied',replayed:true};await c.query('INSERT INTO app.command_results VALUES($1,$2,$3,$4,$5)',[h,actor,key,digest,result]);await c.query('COMMIT');return result;}
  if(p.status!=='pending')throw new Conflict('PROPOSAL_NOT_PENDING');
  if(state.rows[0].facts_revision!==body.expected_facts_revision)throw new Conflict('STALE_PORTFOLIO');
  const account=await c.query('SELECT identity_status FROM app.accounts WHERE household_id=$1 AND id=$2',[h,p.account_id]);if(account.rows[0]?.identity_status!=='known')throw new Conflict('UNRESOLVED_ACCOUNT');
  const holdings=await c.query('SELECT * FROM app.holdings WHERE household_id=$1 AND account_id=$2 AND currency=$3 FOR UPDATE',[h,p.account_id,p.currency]);
  const holding=holdings.rows.find(r=>r.instrument_code===p.instrument_code);const cash=holdings.rows.find(r=>r.instrument_code===p.currency+'_CASH');
  if(!holding||holding.coverage_status!=='verified')throw new Conflict('UNKNOWN_POSITION');
  if(!cash||cash.coverage_status!=='verified')throw new Conflict('UNKNOWN_CASH');
  const quantity=exact(p.quantity);const current=exact(holding.quantity);const next=current.add(p.side==='sell'?quantity.neg():quantity);
  if(next.lt(0))throw new Conflict('INSUFFICIENT_POSITION');
  const principal=minor(quantity.mul(exact(p.unit_price)).mul(100));const fees=integer(p.fees_minor);
  const cashDelta=new D(p.side==='sell'?principal:'-'+principal).sub(fees);const nextCash=exact(cash.quantity).add(cashDelta.div(100));
  if(nextCash.lt(0))throw new Conflict('INSUFFICIENT_CASH');
  const event='proposal:'+id;
  await c.query(`INSERT INTO app.events(household_id,id,owner_id,account_id,instrument_code,currency,side,quantity,unit_price,fees_minor,effective_date,settlement_date,known_at,evidence_id,application_status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NULL,now(),$12,'applied')`,[h,event,p.owner_id,p.account_id,p.instrument_code,p.currency,p.side,quantity.toFixed(),p.unit_price,p.fees_minor,p.effective_date,p.source_message_id??'proposal:'+id]);
  await c.query('INSERT INTO app.event_legs VALUES($1,$2,1,$3,$4,$5,NULL),($1,$2,2,$6,$4,NULL,$7),($1,$2,3,$8,$4,NULL,$9)',[h,event,'position',p.currency,p.side==='sell'?quantity.neg().toFixed():quantity.toFixed(),'principal',p.side==='sell'?principal:'-'+principal,'fees',new D(fees).neg().toFixed(0)]);
  await c.query('UPDATE app.holdings SET quantity=$5 WHERE household_id=$1 AND account_id=$2 AND instrument_code=$3 AND currency=$4',[h,p.account_id,p.instrument_code,p.currency,exact(next.toFixed()).toFixed()]);
  await c.query('UPDATE app.holdings SET quantity=$5 WHERE household_id=$1 AND account_id=$2 AND instrument_code=$3 AND currency=$4',[h,p.account_id,p.currency+'_CASH',p.currency,exact(nextCash.toFixed()).toFixed()]);
  await c.query("UPDATE app.proposals SET status='applied',applied_event_id=$3 WHERE household_id=$1 AND id=$2",[h,id,event]);
  const revision=await c.query('UPDATE app.household_state SET facts_revision=facts_revision+1 WHERE household_id=$1 RETURNING facts_revision',[h]);
  const result={proposal_id:id,event_id:event,status:'applied',facts_revision:revision.rows[0].facts_revision,replayed:false};
  await c.query('INSERT INTO app.command_results VALUES($1,$2,$3,$4,$5)',[h,actor,key,digest,result]);
  await c.query("INSERT INTO app.audit_log(household_id,actor_id,action,resource_id,details) VALUES($1,$2,'proposal_applied',$3,$4)",[h,actor,id,{event_id:event,summary_hash:body.summary_hash,facts_revision:result.facts_revision}]);
  await c.query('COMMIT');return result;
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
