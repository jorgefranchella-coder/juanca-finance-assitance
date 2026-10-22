/** Seed exact B3 position balances for the 2026-10-19 opening cut. Cash stays unseeded. */
import {readFile} from 'node:fs/promises';
import {pool} from '../../services/application/src/db.ts';

const apply=process.argv.includes('--apply');
const configPath=process.env.JUANCA_SHADOW_CONFIG??'/home/jorge/.local/share/juanca-shadow/application.json';
const webPath=process.env.JUANCA_WEB_CREDENTIALS??'/home/jorge/.hermes/profiles/juanca/workspace/patrimonio-familiar-source/integration/credentials.json';
const config=JSON.parse(await readFile(configPath,'utf8')) as {household_id:string};
const web=JSON.parse(await readFile(webPath,'utf8')) as {user_id:string};
const household=config.household_id,cut='2026-10-19';
const db=pool();
try{
 const state=await db.query(`SELECT s.latest_version,s.facts_revision,v.run_id,v.effective_as_of::text
   FROM app.household_state s JOIN app.portfolio_versions v ON v.household_id=s.household_id AND v.id=s.latest_version
   WHERE s.household_id=$1`,[household]);
 if(state.rowCount!==1||!state.rows[0].run_id)throw new Error('CURRENT_PUBLISHED_SHADOW_REQUIRED');
 const current=state.rows[0],run=String(current.run_id);
 const member=await db.query("SELECT 1 FROM app.memberships WHERE household_id=$1 AND actor_id=$2 AND role IN ('owner','approver','reviewer')",[household,web.user_id]);
 if(!member.rowCount)throw new Error('OPENING_BALANCE_ACTOR_REQUIRED');
 const source=await db.query(`SELECT a.id AS assertion_id,a.owner_id,o.display_name,a.instrument_code,a.quantity::text,
     d.id AS document_id,d.original_name,d.effective_as_of::text,
     COALESCE(r.custody_account_id,a.custody_account_id) AS custody_account_id,
     c.identity_basis,acc.id AS account_id,acc.identity_status,
     COALESCE(si.status,'needs_review') AS parser_status,COALESCE(si.review_reasons,'{}') AS review_reasons
   FROM app.source_assertions a
   JOIN app.source_documents d ON d.household_id=a.household_id AND d.id=a.document_id
   JOIN app.owners o ON o.household_id=a.household_id AND o.id=a.owner_id
   LEFT JOIN LATERAL(SELECT custody_account_id FROM app.position_account_resolutions
      WHERE run_id=$2 AND household_id=$1 AND assertion_id=a.id ORDER BY resolution_version DESC LIMIT 1) r ON true
   LEFT JOIN app.custody_accounts c ON c.household_id=a.household_id AND c.id=COALESCE(r.custody_account_id,a.custody_account_id)
   LEFT JOIN app.accounts acc ON acc.household_id=a.household_id AND acc.owner_id=a.owner_id
      AND acc.source_scope::jsonb->>1='custody:'||c.id
   LEFT JOIN LATERAL(SELECT status,review_reasons FROM app.source_interpretations
      WHERE household_id=a.household_id AND assertion_id=a.id ORDER BY interpreted_at DESC LIMIT 1) si ON true
   WHERE a.household_id=$1 AND a.assertion_kind='position' AND d.source_system='B3'
     AND d.effective_as_of=$3::date AND d.original_name LIKE 'posicao-2026-10-19%'
   ORDER BY o.display_name,c.id,a.instrument_code,a.id`,[household,run,cut]);
 const rows=source.rows;
 if(rows.length!==170)throw new Error('EXPECTED_170_B3_OPENING_ASSERTIONS');
 for(const row of rows){
  if(!row.account_id||row.identity_status!=='known'||!row.custody_account_id||row.identity_basis==='pending'||row.effective_as_of!==cut||!row.instrument_code||!row.assertion_id)throw new Error('OPENING_IDENTITY_OR_EVIDENCE_INCOMPLETE');
  if(Number(row.quantity)<=0)throw new Error('NONPOSITIVE_OPENING_QUANTITY');
  if(row.parser_status==='needs_review'&&(row.review_reasons.length!==1||row.review_reasons[0]!=='custody_account_pending'))throw new Error('OPENING_PARSER_REVIEW_NOT_IDENTITY_ONLY');
 }
 const groups=new Map<string,number>();
 for(const row of rows){const k=[row.account_id,row.instrument_code,'BRL'].join('\0');groups.set(k,(groups.get(k)??0)+1);}
 if([...groups.values()].some(n=>n!==1))throw new Error('DUPLICATE_OPENING_ACCOUNT_INSTRUMENT');
 const existing=await db.query(`SELECT account_id,instrument_code,currency,quantity::text,coverage_status,opening_as_of::text,opening_assertion_id
   FROM app.holdings WHERE household_id=$1`,[household]);
 if(existing.rowCount&&existing.rowCount!==rows.length)throw new Error('EXISTING_OPENING_LEDGER_CONFLICT');
 let replayed=0;
 if(existing.rowCount){for(const row of rows){const old=existing.rows.find(x=>x.account_id===row.account_id&&x.instrument_code===row.instrument_code&&x.currency==='BRL');
   if(!old||old.quantity!==row.quantity||old.coverage_status!=='verified'||old.opening_as_of!==cut||old.opening_assertion_id!==row.assertion_id)throw new Error('EXISTING_OPENING_LEDGER_CONFLICT');replayed++;}}
 const summary={mode:apply?'apply':'dry_run',cut_date:cut,source_documents:[...new Set(rows.map(r=>r.document_id))].length,
  b3_position_rows:rows.length,owners:[...new Set(rows.map(r=>r.display_name))].length,custody_accounts:[...new Set(rows.map(r=>r.account_id))].length,
  source_assertions_linked:rows.length,opening_rows_to_insert:existing.rowCount?0:rows.length,replayed,
  cash_balances_seeded:0,cash_movements_applied:0,portfolio_published:false,production_authority_changed:false};
 if(!apply){console.log(JSON.stringify(summary));}
 else{
  if(existing.rowCount)throw new Error('OPENING_ALREADY_SEEDED');
  const c=await db.connect();let inserted=0;
  try{
   await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(736434)');
   const check=await c.query(`SELECT s.latest_version,s.facts_revision,v.run_id FROM app.household_state s
     JOIN app.portfolio_versions v ON v.household_id=s.household_id AND v.id=s.latest_version WHERE s.household_id=$1 FOR UPDATE`,[household]);
   if(check.rows[0]?.latest_version!==current.latest_version||check.rows[0]?.run_id!==run||String(check.rows[0]?.facts_revision)!==String(current.facts_revision))throw new Error('STALE_OPENING_SOURCE');
   const empty=await c.query('SELECT 1 FROM app.holdings WHERE household_id=$1 LIMIT 1',[household]);if(empty.rowCount)throw new Error('OPENING_ALREADY_SEEDED');
   for(const row of rows){
    await c.query(`INSERT INTO app.holdings(household_id,account_id,instrument_code,currency,quantity,coverage_status,opening_as_of,opening_assertion_id)
      VALUES($1,$2,$3,'BRL',$4,'verified',$5,$6)`,[household,row.account_id,row.instrument_code,row.quantity,cut,row.assertion_id]);inserted++;
   }
   await c.query('UPDATE app.household_state SET facts_revision=facts_revision+1 WHERE household_id=$1',[household]);
   await c.query(`INSERT INTO app.audit_log(household_id,actor_id,action,resource_id,details)
      VALUES($1,$2,'b3_opening_holdings_seeded',$3,$4)`,[household,web.user_id,run,{cut_date:cut,rows:inserted,source:'B3 position statements',cash_seeded:false,movements_applied:false}]);
   await c.query('COMMIT');
  }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
  console.log(JSON.stringify({...summary,mode:'applied',inserted,shadow_version_unchanged:true}));
 }
}finally{await db.end();}
