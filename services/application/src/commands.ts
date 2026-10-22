import type pg from 'pg';
import {randomUUID} from 'node:crypto';
import {exact,integer,minor,D} from './money.ts';
import {hash,publishInTransaction,summaryHash} from './migration.ts';
export class Conflict extends Error{code:string;status:number;constructor(code:string,status=409){super(code);this.code=code;this.status=status;}}
export type Approval={version:number;summary_hash:string;expected_facts_revision:string};
export type ProposalInput={owner_id:string;account_id:string;instrument_code:string;currency:string;side:string;quantity:string|number;unit_price:string|number;fees_minor?:string|number;effective_date:string;source_message_id?:string};
function commandKey(key:string){if(!/^[A-Za-z0-9_-]{8,100}$/.test(key))throw new Conflict('VALIDATION',422);}
function validateApproval(body:Approval){if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['version','summary_hash','expected_facts_revision'].includes(k))||!Number.isInteger(body.version)||!/^[0-9a-f]{64}$/.test(body.summary_hash)||!/^\d+$/.test(body.expected_facts_revision))throw new Conflict('VALIDATION',422);}
function normalizeProposal(input:ProposalInput){
 try{
  const instrument=String(input.instrument_code??'').trim().toUpperCase(),currency=String(input.currency??''),side=String(input.side??''),date=String(input.effective_date??'');
  const quantity=exact(input.quantity),unitPrice=exact(input.unit_price),fees=integer(input.fees_minor??'0');
  const parsedDate=new Date(date+'T00:00:00.000Z');
  if(!/^[A-Z0-9._-]{1,32}$/.test(instrument)||!['BRL','USD'].includes(currency)||!['buy','sell'].includes(side)||quantity.lte(0)||unitPrice.lte(0)||new D(fees).lt(0)||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)||Number.isNaN(parsedDate.valueOf())||parsedDate.toISOString().slice(0,10)!==date||!input.owner_id||!input.account_id)throw new Conflict('VALIDATION',422);
  return {owner_id:input.owner_id,account_id:input.account_id,instrument_code:instrument,currency,side,quantity:quantity.toFixed(),unit_price:unitPrice.toFixed(),fees_minor:fees,effective_date:date,source_message_id:input.source_message_id??null};
 }catch(error){if(error instanceof Conflict)throw error;throw new Conflict('VALIDATION',422);}
}
export async function listProposals(db:pg.Pool,h:string,status?:string){
 if(status&&!['pending','applied','rejected'].includes(status))throw new Conflict('VALIDATION',422);
 const result=await db.query(`SELECT p.id,p.owner_id,o.display_name AS owner,p.account_id,a.source_scope AS account_scope,p.instrument_code,p.currency,p.side,p.quantity::text,p.unit_price::text,p.fees_minor::text,p.effective_date::text,p.version,p.summary_hash,p.status,p.source_message_id,p.applied_event_id FROM app.proposals p JOIN app.owners o ON o.household_id=p.household_id AND o.id=p.owner_id JOIN app.accounts a ON a.household_id=p.household_id AND a.id=p.account_id WHERE p.household_id=$1 AND ($2::text IS NULL OR p.status=$2) ORDER BY p.effective_date DESC,p.id`,[h,status??null]);
 return {proposals:result.rows};
}
export async function createProposal(db:pg.Pool,h:string,actor:string,key:string,input:ProposalInput){
 commandKey(key);const normalized=normalizeProposal(input);const digest=hash(JSON.stringify(normalized)),c=await db.connect();
 try{
  // Reviewers may prepare a draft. Only owners/approvers can reject or apply it.
  await c.query('BEGIN');const member=await c.query("SELECT 1 FROM app.memberships WHERE household_id=$1 AND actor_id=$2 AND role IN ('reviewer','owner','approver')",[h,actor]);if(!member.rowCount)throw new Conflict('FORBIDDEN',403);
  const state=await c.query('SELECT facts_revision FROM app.household_state WHERE household_id=$1 FOR UPDATE',[h]);if(!state.rowCount)throw new Conflict('NOT_FOUND',404);
  const old=await c.query('SELECT request_hash,result FROM app.command_results WHERE household_id=$1 AND actor_id=$2 AND idempotency_key=$3',[h,actor,key]);if(old.rowCount){if(old.rows[0].request_hash!==digest)throw new Conflict('IDEMPOTENCY_MISMATCH');await c.query('COMMIT');return {...old.rows[0].result,replayed:true};}
  const account=await c.query('SELECT owner_id,identity_status FROM app.accounts WHERE household_id=$1 AND id=$2',[h,normalized.account_id]);if(!account.rowCount||account.rows[0].owner_id!==normalized.owner_id)throw new Conflict('ACCOUNT_OWNER_MISMATCH',422);if(account.rows[0].identity_status!=='known')throw new Conflict('UNRESOLVED_ACCOUNT');
  const id=randomUUID(),summary_hash=summaryHash(normalized);await c.query(`INSERT INTO app.proposals(household_id,id,owner_id,account_id,instrument_code,currency,side,quantity,unit_price,fees_minor,effective_date,summary_hash,status,source_message_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending',$13)`,[h,id,normalized.owner_id,normalized.account_id,normalized.instrument_code,normalized.currency,normalized.side,normalized.quantity,normalized.unit_price,normalized.fees_minor,normalized.effective_date,summary_hash,normalized.source_message_id]);
  const result={proposal_id:id,version:1,summary_hash,status:'pending',replayed:false};await c.query('INSERT INTO app.command_results VALUES($1,$2,$3,$4,$5)',[h,actor,key,digest,result]);await c.query("INSERT INTO app.audit_log(household_id,actor_id,action,resource_id,details) VALUES($1,$2,'proposal_created',$3,$4)",[h,actor,id,{summary_hash,account_id:normalized.account_id}]);await c.query('COMMIT');return result;
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
export async function rejectProposal(db:pg.Pool,h:string,actor:string,id:string,key:string,body:Approval){
 commandKey(key);validateApproval(body);
 const digest=hash(JSON.stringify([id,'reject',body.version,body.summary_hash,body.expected_facts_revision])),c=await db.connect();
 try{
  await c.query('BEGIN');const member=await c.query("SELECT 1 FROM app.memberships WHERE household_id=$1 AND actor_id=$2 AND role IN ('owner','approver')",[h,actor]);if(!member.rowCount)throw new Conflict('FORBIDDEN',403);
  const state=await c.query('SELECT facts_revision FROM app.household_state WHERE household_id=$1 FOR UPDATE',[h]);if(!state.rowCount)throw new Conflict('NOT_FOUND',404);
  const old=await c.query('SELECT request_hash,result FROM app.command_results WHERE household_id=$1 AND actor_id=$2 AND idempotency_key=$3',[h,actor,key]);if(old.rowCount){if(old.rows[0].request_hash!==digest)throw new Conflict('IDEMPOTENCY_MISMATCH');await c.query('COMMIT');return {...old.rows[0].result,replayed:true};}
  const proposal=await c.query('SELECT version,summary_hash,status FROM app.proposals WHERE household_id=$1 AND id=$2 FOR UPDATE',[h,id]);if(!proposal.rowCount)throw new Conflict('NOT_FOUND',404);const p=proposal.rows[0];if(p.version!==body.version||p.summary_hash!==body.summary_hash)throw new Conflict('PROPOSAL_CHANGED');if(p.status!=='pending')throw new Conflict('PROPOSAL_NOT_PENDING');if(String(state.rows[0].facts_revision)!==body.expected_facts_revision)throw new Conflict('STALE_PORTFOLIO');
  await c.query("UPDATE app.proposals SET status='rejected' WHERE household_id=$1 AND id=$2",[h,id]);const result={proposal_id:id,status:'rejected',facts_revision:String(state.rows[0].facts_revision),replayed:false};await c.query('INSERT INTO app.command_results VALUES($1,$2,$3,$4,$5)',[h,actor,key,digest,result]);await c.query("INSERT INTO app.audit_log(household_id,actor_id,action,resource_id,details) VALUES($1,$2,'proposal_rejected',$3,$4)",[h,actor,id,{summary_hash:body.summary_hash,version:body.version}]);await c.query('COMMIT');return result;
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
export async function approve(db:pg.Pool,h:string,actor:string,id:string,key:string,body:Approval){
 commandKey(key);validateApproval(body);
 const digest=hash(JSON.stringify([id,body.version,body.summary_hash,body.expected_facts_revision]));const c=await db.connect();
 try{
  await c.query('BEGIN');
  const member=await c.query("SELECT 1 FROM app.memberships WHERE household_id=$1 AND actor_id=$2 AND role IN ('owner','approver')",[h,actor]);if(!member.rowCount)throw new Conflict('FORBIDDEN',403);
  const state=await c.query('SELECT facts_revision,latest_version FROM app.household_state WHERE household_id=$1 FOR UPDATE',[h]);if(!state.rowCount)throw new Conflict('NOT_FOUND',404);
  const old=await c.query('SELECT request_hash,result FROM app.command_results WHERE household_id=$1 AND actor_id=$2 AND idempotency_key=$3',[h,actor,key]);
  if(old.rowCount){if(old.rows[0].request_hash!==digest)throw new Conflict('IDEMPOTENCY_MISMATCH');await c.query('COMMIT');return {...old.rows[0].result,replayed:true};}
  let currentProjection:{run_id:string;effective_as_of:string}|null=null;
  if(state.rows[0].latest_version){const latest=await c.query('SELECT run_id,effective_as_of::text FROM app.portfolio_versions WHERE household_id=$1 AND id=$2',[h,state.rows[0].latest_version]);if(!latest.rowCount||!latest.rows[0].run_id)throw new Conflict('PORTFOLIO_REBUILD_REQUIRED');currentProjection={run_id:String(latest.rows[0].run_id),effective_as_of:String(latest.rows[0].effective_as_of)};}
  const proposal=await c.query('SELECT * FROM app.proposals WHERE household_id=$1 AND id=$2 FOR UPDATE',[h,id]);if(!proposal.rowCount)throw new Conflict('NOT_FOUND',404);const p=proposal.rows[0];
  if(p.version!==body.version||p.summary_hash!==body.summary_hash)throw new Conflict('PROPOSAL_CHANGED');
  if(p.status==='applied'){const result={proposal_id:id,event_id:p.applied_event_id,status:'applied',replayed:true};await c.query('INSERT INTO app.command_results VALUES($1,$2,$3,$4,$5)',[h,actor,key,digest,result]);await c.query('COMMIT');return result;}
  if(p.status!=='pending')throw new Conflict('PROPOSAL_NOT_PENDING');
  if(state.rows[0].facts_revision!==body.expected_facts_revision)throw new Conflict('STALE_PORTFOLIO');
  const account=await c.query('SELECT identity_status FROM app.accounts WHERE household_id=$1 AND id=$2',[h,p.account_id]);if(account.rows[0]?.identity_status!=='known')throw new Conflict('UNRESOLVED_ACCOUNT');
  const holdings=await c.query('SELECT * FROM app.holdings WHERE household_id=$1 AND account_id=$2 AND currency=$3 FOR UPDATE',[h,p.account_id,p.currency]);
  const holding=holdings.rows.find(r=>r.instrument_code===p.instrument_code);
  if(!holding||holding.coverage_status!=='verified')throw new Conflict('UNKNOWN_POSITION');
  const quantity=exact(p.quantity);const current=exact(holding.quantity);const next=current.add(p.side==='sell'?quantity.neg():quantity);
  if(next.lt(0))throw new Conflict('INSUFFICIENT_POSITION');
  const principal=minor(quantity.mul(exact(p.unit_price)).mul(100));const fees=integer(p.fees_minor);
  const event='proposal:'+id,commandKnownAt=new Date().toISOString();
  await c.query(`INSERT INTO app.events(household_id,id,owner_id,account_id,instrument_code,currency,side,quantity,unit_price,fees_minor,effective_date,settlement_date,known_at,evidence_id,application_status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NULL,$12,$13,'applied')`,[h,event,p.owner_id,p.account_id,p.instrument_code,p.currency,p.side,quantity.toFixed(),p.unit_price,p.fees_minor,p.effective_date,commandKnownAt,p.source_message_id??'proposal:'+id]);
  await c.query('INSERT INTO app.event_legs VALUES($1,$2,1,$3,$4,$5,NULL),($1,$2,2,$6,$4,NULL,$7),($1,$2,3,$8,$4,NULL,$9)',[h,event,'position',p.currency,p.side==='sell'?quantity.neg().toFixed():quantity.toFixed(),'principal',p.side==='sell'?principal:'-'+principal,'fees',new D(fees).neg().toFixed(0)]);
  await c.query('UPDATE app.holdings SET quantity=$5 WHERE household_id=$1 AND account_id=$2 AND instrument_code=$3 AND currency=$4',[h,p.account_id,p.instrument_code,p.currency,exact(next.toFixed()).toFixed()]);
  await c.query("UPDATE app.proposals SET status='applied',applied_event_id=$3 WHERE household_id=$1 AND id=$2",[h,id,event]);
  const revision=await c.query('UPDATE app.household_state SET facts_revision=facts_revision+1 WHERE household_id=$1 RETURNING facts_revision',[h]);
  let portfolioVersion:string|undefined;
  if(currentProjection){const effective=[currentProjection.effective_as_of,String(p.effective_date)].sort().at(-1)!;const published=await publishInTransaction(c,currentProjection.run_id,h,effective,commandKnownAt);portfolioVersion=published.portfolio_version;}
  const result={proposal_id:id,event_id:event,status:'applied',facts_revision:revision.rows[0].facts_revision,portfolio_version:portfolioVersion??null,replayed:false};
  await c.query('INSERT INTO app.command_results VALUES($1,$2,$3,$4,$5)',[h,actor,key,digest,result]);
  await c.query("INSERT INTO app.audit_log(household_id,actor_id,action,resource_id,details) VALUES($1,$2,'proposal_applied',$3,$4)",[h,actor,id,{event_id:event,summary_hash:body.summary_hash,facts_revision:result.facts_revision}]);
  await c.query('COMMIT');return result;
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
