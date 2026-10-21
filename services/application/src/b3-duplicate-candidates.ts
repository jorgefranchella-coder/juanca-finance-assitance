import type pg from 'pg';
import {createHash,randomUUID} from 'node:crypto';
import {Conflict} from './commands.ts';

/** Lists exact movement rows repeated across B3 documents without merging facts. */
export async function listB3DuplicateMovementCandidates(db:pg.Pool,household:string,limit=100){
 if(!Number.isInteger(limit)||limit<1||limit>500)throw new Conflict('VALIDATION',422);
 const result=await db.query(`WITH evidence AS (
   SELECT a.id AS assertion_id,a.document_id,d.original_name,a.source_sheet,a.source_row,
     a.owner_id,o.display_name AS owner,a.institution_id,ci.canonical_name AS institution,
     a.custody_account_id,ca.external_reference AS account,a.asserted_on::text AS asserted_on,
     a.source_event_type,COALESCE(i.instrument_code,a.instrument_code) AS instrument_code,
     COALESCE(i.tentative_event_type,a.tentative_event_type) AS tentative_event_type,
     a.direction,a.quantity::text AS quantity,a.raw_row
   FROM app.source_assertions a
   JOIN app.source_documents d ON d.household_id=a.household_id AND d.id=a.document_id
   JOIN app.owners o ON o.household_id=a.household_id AND o.id=a.owner_id
   LEFT JOIN app.custody_institutions ci ON ci.id=a.institution_id
   LEFT JOIN app.custody_accounts ca ON ca.household_id=a.household_id AND ca.id=a.custody_account_id
   LEFT JOIN LATERAL (
     SELECT instrument_code,tentative_event_type FROM app.source_interpretations x
     WHERE x.household_id=a.household_id AND x.assertion_id=a.id
     ORDER BY interpreted_at DESC,parser_version DESC LIMIT 1
   ) i ON true
   WHERE a.household_id=$1 AND d.source_system='B3' AND d.report_kind='movement'
 ), repeated AS (
   SELECT owner_id,institution_id,custody_account_id,asserted_on,direction,quantity,raw_row,
     count(*)::int AS occurrence_count,count(DISTINCT document_id)::int AS document_count,
     jsonb_agg(jsonb_build_object(
       'assertion_id',assertion_id,'document_id',document_id,'file_name',original_name,
       'source_sheet',source_sheet,'source_row',source_row,'source_event_type',source_event_type,
       'tentative_event_type',tentative_event_type,'instrument_code',instrument_code,
       'institution',institution,'account',account,'direction',direction,'quantity',quantity
     ) ORDER BY original_name,source_sheet,source_row) AS evidence,
     min(owner) AS owner,min(institution) AS institution
   FROM evidence
   GROUP BY owner_id,institution_id,custody_account_id,asserted_on,direction,quantity,raw_row
   HAVING count(DISTINCT document_id)>1
 )
 SELECT md5(jsonb_build_array(owner_id,institution_id,custody_account_id,asserted_on,direction,quantity,raw_row)::text) AS candidate_key,
   owner,institution,asserted_on,direction,quantity,occurrence_count,document_count,evidence
 FROM repeated ORDER BY asserted_on DESC,candidate_key LIMIT $2`,[household,limit]);
 const assertionIds=[...new Set(result.rows.flatMap((r:any)=>Array.isArray(r.evidence)?r.evidence.map((e:any)=>e.assertion_id):[]))];
 const decisions=assertionIds.length?await db.query(`SELECT DISTINCT ON (left_assertion_id,right_assertion_id)
   left_assertion_id,right_assertion_id,id,decision,revision,actor_id,decided_at::text AS decided_at
   FROM app.source_assertion_link_decisions WHERE household_id=$1
   AND left_assertion_id=ANY($2::text[]) AND right_assertion_id=ANY($2::text[])
   ORDER BY left_assertion_id,right_assertion_id,revision DESC`,[household,assertionIds]):{rows:[]};
 const latest=new Map(decisions.rows.map((d:any)=>[`${d.left_assertion_id}:${d.right_assertion_id}`,d]));
 for(const candidate of result.rows){
  const evidence=Array.isArray(candidate.evidence)?candidate.evidence:[];const links=[];
  for(let i=0;i<evidence.length;i++)for(let j=i+1;j<evidence.length;j++){
   const [left,right]=[evidence[i].assertion_id,evidence[j].assertion_id].sort();const decision=latest.get(`${left}:${right}`);
   links.push({left_assertion_id:left,right_assertion_id:right,review:decision?{decision:decision.decision,revision:decision.revision,actor_id:decision.actor_id,decided_at:decision.decided_at}:null});
  }
  candidate.review_status=links.length&&links.every((link:any)=>link.review)?'reviewed':'needs_review';candidate.link_decisions=links;
 }
 return {status:'candidate_only',candidates:result.rows,count:result.rowCount??0,limit,
   mode:'shadow',authoritative:false as const,portfolio_published:false as const};
}

const KEY=/^[A-Za-z0-9._:-]{8,128}$/;
export async function recordB3DuplicateMovementDecision(db:pg.Pool,household:string,actor:string,body:unknown){
 if(!body||typeof body!=='object'||Array.isArray(body))throw new Conflict('VALIDATION',422);
 const input=body as Record<string,unknown>;
 if(Object.keys(input).some(k=>!['request_key','left_assertion_id','right_assertion_id','candidate_key','decision'].includes(k))||
   typeof input.request_key!=='string'||!KEY.test(input.request_key)||typeof input.left_assertion_id!=='string'||input.left_assertion_id.length<1||input.left_assertion_id.length>200||
   typeof input.right_assertion_id!=='string'||input.right_assertion_id.length<1||input.right_assertion_id.length>200||input.left_assertion_id===input.right_assertion_id||
   typeof input.candidate_key!=='string'||! /^[0-9a-f]{32}$/.test(input.candidate_key)||!['same_event','distinct_events'].includes(String(input.decision)))throw new Conflict('VALIDATION',422);
 const [left,right]=[input.left_assertion_id,input.right_assertion_id].sort();
 const digest=createHash('sha256').update(JSON.stringify([input.candidate_key,left,right,input.decision])).digest('hex');const c=await db.connect();
 try{
  await c.query('BEGIN');
  const member=await c.query("SELECT 1 FROM app.memberships WHERE household_id=$1 AND actor_id=$2 AND role IN ('reviewer','owner','approver')",[household,actor]);if(!member.rowCount)throw new Conflict('FORBIDDEN',403);
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${household}:${actor}:${input.request_key}`]);
  const prior=await c.query('SELECT id,request_hash,decision,revision FROM app.source_assertion_link_decisions WHERE household_id=$1 AND actor_id=$2 AND request_key=$3',[household,actor,input.request_key]);
  if(prior.rowCount){if(prior.rows[0].request_hash!==digest)throw new Conflict('IDEMPOTENCY_MISMATCH');await c.query('COMMIT');return{decision_id:prior.rows[0].id,decision:prior.rows[0].decision,revision:prior.rows[0].revision,replayed:true,mode:'shadow',portfolio_changed:false};}
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${household}:${left}:${right}`]);
  const current=await c.query('SELECT id,revision,decision FROM app.source_assertion_link_decisions WHERE household_id=$1 AND left_assertion_id=$2 AND right_assertion_id=$3 ORDER BY revision DESC LIMIT 1',[household,left,right]);
  const candidates=await listB3DuplicateMovementCandidates(db,household,500);
  const candidate=candidates.candidates.find((entry:any)=>entry.candidate_key===input.candidate_key&&Array.isArray(entry.evidence)&&entry.evidence.some((e:any)=>e.assertion_id===left)&&entry.evidence.some((e:any)=>e.assertion_id===right));
  if(!candidate)throw new Conflict('STALE_CANDIDATE');
  const revision=Number(current.rows[0]?.revision??0)+1,id=randomUUID();
  await c.query(`INSERT INTO app.source_assertion_link_decisions(household_id,id,left_assertion_id,right_assertion_id,candidate_key,revision,decision,actor_id,request_key,request_hash,supersedes_id)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[household,id,left,right,input.candidate_key,revision,input.decision,actor,input.request_key,digest,current.rows[0]?.id??null]);
  await c.query("INSERT INTO app.audit_log(household_id,actor_id,action,resource_id,details) VALUES($1,$2,'b3_duplicate_movement_link_decision',$3,$4)",[household,actor,id,{candidate_key:input.candidate_key,left_assertion_id:left,right_assertion_id:right,decision:input.decision,revision,portfolio_changed:false}]);
  await c.query('COMMIT');return{decision_id:id,decision:input.decision,revision,replayed:false,mode:'shadow',portfolio_changed:false};
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
