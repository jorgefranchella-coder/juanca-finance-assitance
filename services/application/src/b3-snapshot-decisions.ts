import {createHash,randomUUID} from 'node:crypto';
import type pg from 'pg';
import {Conflict} from './commands.ts';
import {listB3CandidateReports} from './b3-candidate-reports.ts';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY=/^[A-Za-z0-9._:-]{8,128}$/;
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
type Diff={key:string};

export async function listB3SnapshotReviews(db:pg.Pool,household:string,limit=50){
 const result=await listB3CandidateReports(household,limit);
 const decisions=await db.query(`SELECT DISTINCT ON(prior_document_id,current_document_id,candidate_key)
   prior_document_id,current_document_id,candidate_key,candidate_hash,decision,revision,decided_at
   FROM app.b3_snapshot_review_decisions WHERE household_id=$1
   ORDER BY prior_document_id,current_document_id,candidate_key,revision DESC`,[household]);
 const latest=new Map(decisions.rows.map(row=>[`${row.prior_document_id}:${row.current_document_id}:${row.candidate_key}`,row]));
 const reports=result.reports.map(report=>({...report,differences:(report.differences as Diff[]).map(difference=>{
   const decision=latest.get(`${report.prior_document_id}:${report.current_document_id}:${difference.key}`);
   return {...difference,review:decision?{decision:decision.decision,revision:decision.revision,decided_at:decision.decided_at,stale:decision.candidate_hash!==hash(JSON.stringify(difference))}:null};
 })}));
 return {...result,reports,mode:'shadow',authoritative:false,apply_enabled:false as const};
}

export async function recordB3SnapshotReview(db:pg.Pool,household:string,actor:string,body:unknown){
 if(!body||typeof body!=='object'||Array.isArray(body))throw new Conflict('VALIDATION',422);
 const input=body as Record<string,unknown>;
 if(Object.keys(input).some(key=>!['request_key','prior_document_id','current_document_id','candidate_key','decision'].includes(key))||typeof input.request_key!=='string'||!KEY.test(input.request_key)||typeof input.prior_document_id!=='string'||!UUID.test(input.prior_document_id)||typeof input.current_document_id!=='string'||!UUID.test(input.current_document_id)||typeof input.candidate_key!=='string'||input.candidate_key.length>1000||!['confirmed','dismissed'].includes(String(input.decision)))throw new Conflict('VALIDATION',422);
 const value=input as {request_key:string;prior_document_id:string;current_document_id:string;candidate_key:string;decision:'confirmed'|'dismissed'};
 const c=await db.connect();
 try{
  await c.query('BEGIN');
  const member=await c.query("SELECT 1 FROM app.memberships WHERE household_id=$1 AND actor_id=$2 AND role IN ('reviewer','owner','approver')",[household,actor]);
  if(!member.rowCount)throw new Conflict('FORBIDDEN',403);
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${household}:${actor}:${value.request_key}`]);
  const requestHash=hash(JSON.stringify([value.prior_document_id,value.current_document_id,value.candidate_key,value.decision]));
  const priorRequest=await c.query('SELECT id,request_hash,decision,revision FROM app.b3_snapshot_review_decisions WHERE household_id=$1 AND actor_id=$2 AND request_key=$3',[household,actor,value.request_key]);
  if(priorRequest.rowCount){if(priorRequest.rows[0].request_hash!==requestHash)throw new Conflict('IDEMPOTENCY_MISMATCH',409);await c.query('COMMIT');return{decision_id:priorRequest.rows[0].id,decision:priorRequest.rows[0].decision,revision:priorRequest.rows[0].revision,replayed:true,mode:'shadow',portfolio_changed:false};}
  const lock=`${household}:${value.prior_document_id}:${value.current_document_id}:${value.candidate_key}`;
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[lock]);
  const reports=await listB3CandidateReports(household,100);
  const report=reports.reports.find(item=>item.prior_document_id===value.prior_document_id&&item.current_document_id===value.current_document_id);
  const candidate=(report?.differences as Diff[]|undefined)?.find(item=>item.key===value.candidate_key);
  if(!candidate)throw new Conflict('STALE_CANDIDATE',409);
  const candidateHash=hash(JSON.stringify(candidate));
  const current=await c.query('SELECT id,revision,decision,candidate_hash FROM app.b3_snapshot_review_decisions WHERE household_id=$1 AND prior_document_id=$2 AND current_document_id=$3 AND candidate_key=$4 ORDER BY revision DESC LIMIT 1',[household,value.prior_document_id,value.current_document_id,value.candidate_key]);
  if(current.rows[0]?.candidate_hash===candidateHash&&current.rows[0]?.decision===value.decision){await c.query('COMMIT');return{decision_id:current.rows[0].id,decision:value.decision,revision:current.rows[0].revision,replayed:true,mode:'shadow',portfolio_changed:false};}
  const revision=Number(current.rows[0]?.revision??0)+1,id=randomUUID();
  await c.query(`INSERT INTO app.b3_snapshot_review_decisions(household_id,id,prior_document_id,current_document_id,candidate_key,candidate_hash,revision,decision,actor_id,request_key,request_hash,supersedes_id)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[household,id,value.prior_document_id,value.current_document_id,value.candidate_key,candidateHash,revision,value.decision,actor,value.request_key,requestHash,current.rows[0]?.id??null]);
  await c.query("INSERT INTO app.audit_log(household_id,actor_id,action,resource_id,details) VALUES($1,$2,'b3_snapshot_review_decision',$3,$4)",[household,actor,id,{prior_document_id:value.prior_document_id,current_document_id:value.current_document_id,candidate_key:value.candidate_key,candidate_hash:candidateHash,decision:value.decision,revision,portfolio_changed:false}]);
  await c.query('COMMIT');return{decision_id:id,decision:value.decision,revision,replayed:false,mode:'shadow',portfolio_changed:false};
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
