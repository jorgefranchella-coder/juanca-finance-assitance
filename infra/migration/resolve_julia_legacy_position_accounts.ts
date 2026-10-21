/** Link Julia's legacy B3 snapshot rows to her user-confirmed unique custody account per institution. Defaults to dry-run. */
import {readFile} from 'node:fs/promises';
import {migrate,pool} from '../../services/application/src/db.ts';
import {loadEnvelopeTables,ownerId,publish} from '../../services/application/src/migration.ts';
import {selectInputs,type Row} from '../../services/application/src/portfolio.ts';

const apply=process.argv.includes('--apply');
const norm=(v:unknown)=>String(v??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/[^A-Z0-9]+/g,' ').trim().replace(/\s+/g,' ');
const application=JSON.parse(await readFile(process.env.JUANCA_SHADOW_CONFIG??'/home/jorge/.local/share/juanca-shadow/application.json','utf8')) as {household_id:string};
const web=JSON.parse(await readFile(process.env.JUANCA_WEB_CREDENTIALS??'/home/jorge/.hermes/profiles/juanca/workspace/patrimonio-familiar-source/integration/credentials.json','utf8')) as {user_id:string};
if(!application.household_id||!web.user_id)throw new Error('MIGRATION_CONFIG_INVALID');
const db=pool();
try{
 await migrate(db);
 const state=await db.query(`SELECT s.household_id,s.latest_version,s.facts_revision,v.run_id,v.effective_as_of::text AS effective_as_of,v.known_at::text AS known_at
  FROM app.household_state s JOIN app.portfolio_versions v ON v.household_id=s.household_id AND v.id=s.latest_version WHERE s.household_id=$1`,[application.household_id]);
 if(state.rowCount!==1||!state.rows[0].run_id)throw new Error('EXPECTED_CURRENT_SHADOW');
 const current=state.rows[0],household=String(current.household_id),run=String(current.run_id);
 const membership=await db.query("SELECT 1 FROM app.memberships WHERE household_id=$1 AND actor_id=$2 AND role IN ('reviewer','owner','approver')",[household,web.user_id]);
 if(!membership.rowCount)throw new Error('REVIEWER_MEMBERSHIP_REQUIRED');
 const tables=await loadEnvelopeTables(db,run,household),inputs=selectInputs(tables,household,String(current.effective_as_of),String(current.known_at));
 const records=new Map(tables.import_records.map(row=>[String(row.id),row]));
 const aliases=await db.query('SELECT normalized_alias,institution_id FROM app.custody_institution_aliases');
 const institutionByAlias=new Map<string,string>(aliases.rows.map(row=>[String(row.normalized_alias),String(row.institution_id)]));
 const accounts=await db.query(`SELECT ca.id,ca.institution_id,ca.identity_basis,ci.canonical_name
  FROM app.custody_accounts ca JOIN app.custody_institutions ci ON ci.id=ca.institution_id WHERE ca.household_id=$1 AND ca.owner_id=$2 ORDER BY ci.canonical_name`,[household,ownerId('Julia')]);
 const accountsByInstitution=new Map<string,typeof accounts.rows>();
 for(const account of accounts.rows){const list=accountsByInstitution.get(String(account.institution_id))??[];list.push(account);accountsByInstitution.set(String(account.institution_id),list);}
 const candidates:Array<{record_id:string;snapshot_id:string;custody_account_id:string;institution:string;reference_date:string;already_resolved:boolean}> = [];
 let unmappedInstitution=0;
 for(const row of inputs.snapshots){
  if(row.file_type!=='positions')continue;
  const record=records.get(row.id);if(!record)throw new Error('SOURCE_RECORD_MISSING');
  const item=JSON.parse(String(record.payload)) as Row,owner=String(item.owner??row.owner);
  if(owner!=='Julia'||item.account)continue;
  const institutionId=institutionByAlias.get(norm(item.institution));if(!institutionId){unmappedInstitution++;continue;}
  const custodyAccounts=accountsByInstitution.get(institutionId)??[];
  if(custodyAccounts.length!==1||custodyAccounts[0].identity_basis!=='user_confirmed_unique')throw new Error('JULIA_ACCOUNT_NOT_UNIQUELY_CONFIRMED');
  const snapshotId=`${row.import_id}:${row.id}`;
  const snapshot=await db.query('SELECT owner_id FROM app.snapshots WHERE run_id=$1 AND household_id=$2 AND id=$3',[run,household,snapshotId]);
  if(snapshot.rowCount!==1||snapshot.rows[0].owner_id!==ownerId(owner))throw new Error('LEGACY_SNAPSHOT_SCOPE_MISMATCH');
  const exists=await db.query('SELECT snapshot_id,custody_account_id FROM app.position_account_resolutions WHERE run_id=$1 AND household_id=$2 AND source_record_id=$3 ORDER BY resolution_version DESC LIMIT 1',[run,household,row.id]);
  if(exists.rowCount&&(exists.rows[0].snapshot_id!==snapshotId||exists.rows[0].custody_account_id!==custodyAccounts[0].id))throw new Error('EXISTING_RESOLUTION_CONFLICT');
  candidates.push({record_id:row.id,snapshot_id:snapshotId,custody_account_id:String(custodyAccounts[0].id),institution:String(custodyAccounts[0].canonical_name),reference_date:String(item.reference_date??row.reference_date),already_resolved:Boolean(exists.rowCount)});
 }
 const uniqueInstitutions=new Set(candidates.map(row=>row.institution));
 if(candidates.length!==21||uniqueInstitutions.size!==3)throw new Error(`UNEXPECTED_JULIA_CANDIDATE_SET:${candidates.length}:${uniqueInstitutions.size}`);
 const summary={mode:apply?'apply':'dry_run',owner:'Julia',reference_dates:[...new Set(candidates.map(row=>row.reference_date))],positions:candidates.length,institutions:[...uniqueInstitutions].sort(),already_resolved:candidates.filter(row=>row.already_resolved).length,unmapped_institution:unmappedInstitution,account_identity_basis:'user_confirmed_unique',source_assertion:'not_available_for_legacy_snapshot',financial_quantities_changed:false,portfolio_published:false};
 if(!apply){console.log(JSON.stringify(summary));}
 else{
  const c=await db.connect();let inserted=0;
  try{
   await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(736433)');
   const check=await c.query(`SELECT s.latest_version,s.facts_revision,v.run_id FROM app.household_state s JOIN app.portfolio_versions v ON v.household_id=s.household_id AND v.id=s.latest_version WHERE s.household_id=$1 FOR UPDATE`,[household]);
   if(check.rows[0]?.latest_version!==current.latest_version||check.rows[0]?.run_id!==run||String(check.rows[0]?.facts_revision)!==String(current.facts_revision))throw new Error('STALE_SOURCE_VERSION');
   for(const row of candidates){
    const prior=await c.query('SELECT resolution_version,snapshot_id,custody_account_id FROM app.position_account_resolutions WHERE run_id=$1 AND household_id=$2 AND source_record_id=$3 ORDER BY resolution_version DESC LIMIT 1 FOR UPDATE',[run,household,row.record_id]);
    if(prior.rowCount){if(prior.rows[0].snapshot_id!==row.snapshot_id||prior.rows[0].custody_account_id!==row.custody_account_id)throw new Error('EXISTING_RESOLUTION_CONFLICT');continue;}
    await c.query(`INSERT INTO app.position_account_resolutions(run_id,household_id,source_record_id,resolution_version,snapshot_id,assertion_id,custody_account_id,decision,actor_id)
     VALUES($1,$2,$3,1,$4,NULL,$5,'user_confirmed_institution_uniqueness',$6)`,[run,household,row.record_id,row.snapshot_id,row.custody_account_id,web.user_id]);
    inserted++;
   }
   if(inserted)await c.query('UPDATE app.household_state SET facts_revision=facts_revision+$2 WHERE household_id=$1',[household,inserted]);
   if(inserted)await c.query("INSERT INTO app.audit_log(household_id,actor_id,action,resource_id,details) VALUES($1,$2,'julia_legacy_position_accounts_resolved',$3,$4)",[household,web.user_id,run,{inserted,positions:candidates.length,institutions:[...uniqueInstitutions].sort(),custody_account_ids:[...new Set(candidates.map(row=>row.custody_account_id))],decision_basis:'user_confirmed_one_account_per_institution',source_assertion_available:false,financial_quantities_changed:false,portfolio_published:false}]);
   await c.query('COMMIT');
  }catch(error){try{await c.query('ROLLBACK');}catch{}throw error;}finally{c.release();}
  const knownAt=new Date().toISOString();
  let portfolioVersion=String(current.latest_version),juliaKnown=0,juliaUnresolved=0;
  if(inserted){const published=await publish(db,run,household,String(current.effective_as_of),knownAt);portfolioVersion=published.portfolio_version;juliaKnown=published.view.positions.filter(position=>position.owner==='Julia'&&position.identity_status==='known').length;juliaUnresolved=published.view.positions.filter(position=>position.owner==='Julia'&&position.identity_status!=='known').length;}
  else{const latest=await db.query('SELECT id,view FROM app.portfolio_versions WHERE household_id=$1 AND id=(SELECT latest_version FROM app.household_state WHERE household_id=$1)',[household]);portfolioVersion=String(latest.rows[0].id);juliaKnown=(latest.rows[0].view.positions as Array<{owner:string;identity_status:string}>).filter(position=>position.owner==='Julia'&&position.identity_status==='known').length;juliaUnresolved=(latest.rows[0].view.positions as Array<{owner:string;identity_status:string}>).filter(position=>position.owner==='Julia'&&position.identity_status!=='known').length;}
  console.log(JSON.stringify({...summary,mode:'applied',inserted,portfolio_version:portfolioVersion,julia_positions_known:juliaKnown,julia_positions_unresolved:juliaUnresolved,financial_quantities_changed:false,portfolio_published:false}));
 }
}finally{await db.end();}
