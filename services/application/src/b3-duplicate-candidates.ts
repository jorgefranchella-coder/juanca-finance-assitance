import type pg from 'pg';
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
 return {status:'candidate_only',candidates:result.rows,count:result.rowCount??0,limit,
   mode:'shadow',authoritative:false as const,portfolio_published:false as const};
}
