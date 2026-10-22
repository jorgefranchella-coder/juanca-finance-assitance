/** Carry the user's confirmed one-account-per-institution rule to the current B3 snapshot. */
import {readFile} from 'node:fs/promises';
import {pool} from '../../services/application/src/db.ts';
import {loadEnvelopeTables,ownerId,publish} from '../../services/application/src/migration.ts';
import {codeOf,selectInputs,type Row} from '../../services/application/src/portfolio.ts';
import {exact} from '../../services/application/src/money.ts';

const apply=process.argv.includes('--apply');
const norm=(v:unknown)=>String(v??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/[^A-Z0-9]+/g,' ').trim().replace(/\s+/g,' ');
const app=JSON.parse(await readFile(process.env.JUANCA_SHADOW_CONFIG??'/home/jorge/.local/share/juanca-shadow/application.json','utf8')) as {household_id:string};
const web=JSON.parse(await readFile(process.env.JUANCA_WEB_CREDENTIALS??'/home/jorge/.hermes/profiles/juanca/workspace/patrimonio-familiar-source/integration/credentials.json','utf8')) as {user_id:string};
const db=pool();
try{
 const state=await db.query(`SELECT s.household_id,s.latest_version,s.facts_revision,v.run_id,v.effective_as_of::text effective_as_of,v.known_at::text known_at
   FROM app.household_state s JOIN app.portfolio_versions v ON v.household_id=s.household_id AND v.id=s.latest_version WHERE s.household_id=$1`,[app.household_id]);
 if(state.rowCount!==1||state.rows[0].run_id==null)throw new Error('CURRENT_SHADOW_REQUIRED');
 const current=state.rows[0],household=String(current.household_id),run=String(current.run_id);
 const tables=await loadEnvelopeTables(db,run,household),inputs=selectInputs(tables,household,String(current.effective_as_of),String(current.known_at));
 const records=new Map(tables.import_records.map(row=>[String(row.id),row]));
 const owners=await db.query("SELECT id FROM app.owners WHERE household_id=$1 AND display_name='Julia'",[household]);
 if(owners.rowCount!==1)throw new Error('JULIA_OWNER_NOT_UNIQUE');const julia=String(owners.rows[0].id);
 const membership=await db.query("SELECT 1 FROM app.memberships WHERE household_id=$1 AND actor_id=$2 AND role IN ('reviewer','owner','approver')",[household,web.user_id]);
 if(!membership.rowCount)throw new Error('REVIEWER_MEMBERSHIP_REQUIRED');
 const aliases=await db.query('SELECT normalized_alias,institution_id FROM app.custody_institution_aliases');
 const institutions=new Map<string,string>(aliases.rows.map(row=>[String(row.normalized_alias),String(row.institution_id)]));
 const accountRows=await db.query(`SELECT id,institution_id,identity_basis FROM app.custody_accounts
   WHERE household_id=$1 AND owner_id=$2 ORDER BY institution_id,id`,[household,julia]);
 const accountByInstitution=new Map<string,typeof accountRows.rows>();
 for(const account of accountRows.rows){const key=String(account.institution_id),rows=accountByInstitution.get(key)??[];rows.push(account);accountByInstitution.set(key,rows);}
 const snapshotDates=[...new Set(inputs.snapshots.filter(row=>row.file_type==='positions').map(row=>String(row.reference_date??'')))];
 const assertions=await db.query(`SELECT a.id,a.institution_id,a.custody_account_id,a.instrument_code,a.asserted_on::text asserted_on,a.quantity::text quantity,
    a.interpretation_status,si.status parser_status,si.review_reasons
   FROM app.source_assertions a JOIN app.source_documents d ON d.household_id=a.household_id AND d.id=a.document_id
   LEFT JOIN LATERAL(SELECT status,review_reasons FROM app.source_interpretations WHERE household_id=a.household_id
      AND assertion_id=a.id ORDER BY interpreted_at DESC LIMIT 1) si ON true
   WHERE a.household_id=$1 AND a.owner_id=$2 AND a.assertion_kind='position' AND d.source_system='B3'
      AND d.effective_as_of=ANY($3::date[])`,[household,julia,snapshotDates]);
 const candidates:Array<{record:string;snapshot:string;assertion:string;account:string;institution:string}> = [];
 let unmapped=0,accountNotUnique=0,notMatched=0,ambiguous=0,otherReview=0;
 const positionRows=inputs.snapshots.filter(row=>row.file_type==='positions'&&ownerId(String(row.owner))===julia);
 for(const row of positionRows){
  const source=records.get(row.id);if(!source)throw new Error('B3_SOURCE_RECORD_MISSING');
  const item=JSON.parse(String(source.payload)) as Row;
  if(item.account)continue;
  const institution=institutions.get(norm(item.institution));if(!institution){unmapped++;continue;}
  const possible=accountByInstitution.get(institution)??[];
  if(possible.length!==1||possible[0].identity_basis!=='user_confirmed_unique'){accountNotUnique++;continue;}
  const instrument=codeOf(item.instrument_code||item.product_name),quantity=exact(String(item.quantity)).toFixed(),date=String(item.reference_date??row.reference_date);
  const matches=assertions.rows.filter(assertion=>String(assertion.institution_id)===institution&&String(assertion.asserted_on)===date
    &&assertion.custody_account_id==null&&assertion.instrument_code&&codeOf(assertion.instrument_code)===instrument
    &&exact(String(assertion.quantity)).toFixed()===quantity);
  if(matches.length!==1){if(matches.length>1)ambiguous++;else notMatched++;continue;}
  const assertion=matches[0];
  const reasons=Array.isArray(assertion.review_reasons)?assertion.review_reasons as string[]:[];
  if(assertion.interpretation_status!=='needs_review'||assertion.parser_status!=='needs_review'
      ||reasons.length!==1||reasons[0]!=='custody_account_pending'){otherReview++;continue;}
  const assertionId=String(assertion.id),accountId=String(possible[0].id),snapshot=`${row.import_id}:${row.id}`;
  candidates.push({record:row.id,snapshot,assertion:assertionId,account:accountId,institution});
 }
 const seen=new Set(candidates.map(item=>item.assertion));if(seen.size!==candidates.length)ambiguous++;
 const existing=await db.query(`SELECT DISTINCT ON(source_record_id) source_record_id,snapshot_id,assertion_id,custody_account_id
   FROM app.position_account_resolutions WHERE run_id=$1 AND household_id=$2 ORDER BY source_record_id,resolution_version DESC`,[run,household]);
 let replayed=0;const inserts=[] as typeof candidates;
 for(const item of candidates){const old=existing.rows.find(row=>row.source_record_id===item.record);if(old){if(old.snapshot_id!==item.snapshot||old.assertion_id!==item.assertion||old.custody_account_id!==item.account)throw new Error('EXISTING_RESOLUTION_CONFLICT');replayed++;}else inserts.push(item);}
 const summary={mode:apply?'apply':'dry_run',run_id:run,positions_considered:positionRows.length,candidates:candidates.length,
   ready_to_resolve:inserts.length,replayed,confirmed_identity_basis:'user_confirmed_unique',institutions:[...new Set(candidates.map(x=>x.institution))].length,
   unmapped_institution:unmapped,account_not_unique:accountNotUnique,no_exact_assertion:notMatched,ambiguous,other_review_reasons:otherReview,
   source_parser_status_preserved:true,financial_quantities_changed:false};
 if(!apply){console.log(JSON.stringify(summary));}
 else{
  if(candidates.length!==21||inserts.length+replayed!==21||new Set(candidates.map(x=>x.institution)).size!==3
      ||unmapped||accountNotUnique||notMatched||ambiguous||otherReview)throw new Error('JULIA_CURRENT_B3_IDENTITY_GATE_FAILED');
  const c=await db.connect();let inserted=0;
  try{
   await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(736433)');
   const check=await c.query(`SELECT s.latest_version,s.facts_revision,v.run_id FROM app.household_state s JOIN app.portfolio_versions v
    ON v.household_id=s.household_id AND v.id=s.latest_version WHERE s.household_id=$1 FOR UPDATE`,[household]);
   if(check.rows[0]?.latest_version!==current.latest_version||check.rows[0]?.run_id!==run||String(check.rows[0]?.facts_revision)!==String(current.facts_revision))throw new Error('STALE_SOURCE_VERSION');
   for(const item of inserts){
    await c.query(`INSERT INTO app.position_account_resolutions(run_id,household_id,source_record_id,resolution_version,snapshot_id,assertion_id,custody_account_id,decision,actor_id)
      VALUES($1,$2,$3,1,$4,$5,$6,'same_custody_account_confirmed_by_institution_uniqueness',$7)`,[run,household,item.record,item.snapshot,item.assertion,item.account,web.user_id]);inserted++;
   }
   if(inserted)await c.query('UPDATE app.household_state SET facts_revision=facts_revision+$2 WHERE household_id=$1',[household,inserted]);
   if(inserted)await c.query("INSERT INTO app.audit_log(household_id,actor_id,action,resource_id,details) VALUES($1,$2,'julia_current_b3_accounts_resolved',$3,$4)",
    [household,web.user_id,run,{inserted,source_rows:candidates.length,decision_basis:'user-confirmed one account per institution',parser_review_reasons_preserved:true,financial_quantities_changed:false}]);
   await c.query('COMMIT');
  }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
  const version=await publish(db,run,household,String(current.effective_as_of),new Date().toISOString());
  console.log(JSON.stringify({...summary,mode:'applied',inserted,shadow_version_advanced:true,portfolio_version:version.portfolio_version,financial_quantities_changed:false}));
 }
}finally{await db.end();}
