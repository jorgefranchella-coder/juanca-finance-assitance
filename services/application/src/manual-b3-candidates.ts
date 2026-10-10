import type pg from 'pg';
import {exact} from './money.ts';

type Intake={id:string;owner_id:string;owner:string;original_text:string;received_at:string;fields:{side:string|null;instrument_code:string|null;quantity:string|null;trade_date:string|null}};
 type Movement={assertion_id:string;owner_id:string;custodian:string|null;institution_id:string|null;account_id:string|null;instrument_code:string;asserted_on:string;source_event_type:string|null;event_type:string|null;direction:string|null;quantity:string};
const normalized=(value:unknown)=>String(value??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().trim();
const day=(value:unknown)=>Date.parse(String(value)+'T00:00:00Z');

/** Exact, read-only links between written evidence and B3 movement assertions. */
export async function listManualB3Candidates(db:pg.Pool,household:string){
 const written=await db.query(`SELECT i.id,i.owner_id,o.display_name AS owner,i.original_text,i.received_at,t.fields
  FROM app.manual_intakes i JOIN app.owners o ON o.household_id=i.household_id AND o.id=i.owner_id
  JOIN app.manual_trade_interpretations t ON t.household_id=i.household_id AND t.intake_id=i.id
  WHERE i.household_id=$1 AND i.status='awaiting_review' AND t.interpretation_status='parsed_review'
  ORDER BY i.received_at DESC LIMIT 100`,[household]);
 const movements=await db.query(`SELECT a.id AS assertion_id,a.owner_id,ci.canonical_name AS custodian,a.institution_id,a.custody_account_id AS account_id,
  COALESCE(i.instrument_code,a.instrument_code) AS instrument_code,a.asserted_on::text,a.source_event_type,
  COALESCE(i.tentative_event_type,a.tentative_event_type) AS event_type,a.direction,a.quantity::text
  FROM app.source_assertions a JOIN app.source_documents d ON d.household_id=a.household_id AND d.id=a.document_id LEFT JOIN app.custody_institutions ci ON ci.id=a.institution_id
  LEFT JOIN LATERAL(SELECT instrument_code,tentative_event_type FROM app.source_interpretations i WHERE i.household_id=a.household_id AND i.assertion_id=a.id ORDER BY i.interpreted_at DESC,i.parser_version DESC LIMIT 1)i ON true
  WHERE a.household_id=$1 AND a.assertion_kind='movement' AND d.source_system='B3' AND a.asserted_on IS NOT NULL AND a.quantity IS NOT NULL AND COALESCE(i.instrument_code,a.instrument_code) IS NOT NULL`,[household]);
 const decisions=await db.query(`SELECT DISTINCT ON(intake_id,assertion_id) intake_id,assertion_id,decision,revision,decided_at
  FROM app.manual_b3_link_decisions WHERE household_id=$1 ORDER BY intake_id,assertion_id,revision DESC`,[household]);
 const latestDecision=new Map(decisions.rows.map(row=>[`${row.intake_id}:${row.assertion_id}`,{decision:row.decision,revision:row.revision,decided_at:row.decided_at}]));
 const candidates=[] as Array<Record<string,unknown>>;
 for(const raw of written.rows){
  const intake={...raw,fields:raw.fields as Intake['fields']} as Intake;
  if(!intake.fields.instrument_code||!intake.fields.quantity||!intake.fields.trade_date||!intake.fields.side)continue;
  const eligible=(movements.rows as Movement[]).filter(m=>{
   if(m.owner_id!==intake.owner_id||normalized(m.instrument_code)!==normalized(intake.fields.instrument_code)||!exact(m.quantity).eq(exact(intake.fields.quantity!)))return false;
   const distance=Math.abs(day(m.asserted_on)-day(intake.fields.trade_date!))/86400000;
   if(!Number.isFinite(distance)||distance>7)return false;
   return ['TRADE_OBSERVATION','SETTLEMENT_OBSERVATION','CUSTODY_TRANSFER_OBSERVATION'].includes(normalized(m.event_type));
  });
  if(!eligible.length)continue;
  const rows=eligible.map(m=>({assertion_id:m.assertion_id,date:m.asserted_on,source_event_type:m.source_event_type,event_type:m.event_type,direction:m.direction,quantity:m.quantity,custodian:m.custodian,institution_id:m.institution_id,account_id:m.account_id,date_distance_days:Math.abs(day(m.asserted_on)-day(intake.fields.trade_date!))/86400000,review:latestDecision.get(`${intake.id}:${m.assertion_id}`)??null}));
  candidates.push({intake_id:intake.id,owner:intake.owner,original_text:intake.original_text,trade_date:intake.fields.trade_date,instrument_code:intake.fields.instrument_code,side:intake.fields.side,quantity:intake.fields.quantity,match_status:rows.length===1?'single_candidate':'multiple_candidates',candidate_count:rows.length,candidates:rows,decision:'human_review_required',portfolio_changed:false});
 }
 return{candidates,match_count:candidates.length,mode:'shadow',authoritative:false,apply_enabled:false};
}
