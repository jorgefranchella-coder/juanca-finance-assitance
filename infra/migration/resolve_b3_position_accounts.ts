/** Link exact legacy B3 snapshot rows to already-confirmed custody accounts. Defaults to dry-run. */
import {createHash} from 'node:crypto';
import {pool} from '../../services/application/src/db.ts';
import {exact} from '../../services/application/src/money.ts';
import {accountId,loadEnvelopeTables,ownerId} from '../../services/application/src/migration.ts';
import {codeOf,selectInputs,type Row} from '../../services/application/src/portfolio.ts';

const apply=process.argv.includes('--apply');
const digest=(v:string)=>createHash('sha256').update(v).digest('hex');
const norm=(v:unknown)=>String(v??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/[^A-Z0-9]+/g,' ').trim().replace(/\s+/g,' ');
type Match={source_record_id:string;snapshot_id:string;assertion_id:string;custody_account_id:string;owner_id:string;institution_id:string};
const db=pool();
try{
 const state=await db.query(`SELECT s.household_id,s.latest_version,s.facts_revision,v.run_id,v.effective_as_of::text AS effective_as_of,v.known_at::text AS known_at,v.market_revision,v.calculation_version,v.view
  FROM app.household_state s JOIN app.portfolio_versions v ON v.household_id=s.household_id AND v.id=s.latest_version
  ORDER BY s.household_id LIMIT 2`);
 if(state.rowCount!==1||!state.rows[0].run_id)throw new Error('EXPECTED_ONE_CURRENT_SHADOW');
 const {household_id:household,latest_version:currentVersion,run_id:run,effective_as_of:effective,known_at:knownAt}=state.rows[0];
 const tables=await loadEnvelopeTables(db,String(run),String(household));
 const inputs=selectInputs(tables,String(household),String(effective),String(knownAt));
 const sourceRows=new Map(tables.import_records.map(r=>[String(r.id),r]));
 const aliases=await db.query('SELECT normalized_alias,institution_id FROM app.custody_institution_aliases');
 const aliasMap=new Map<string,string>(aliases.rows.map(r=>[String(r.normalized_alias),String(r.institution_id)]));
 const accounts=await db.query(`SELECT ca.owner_id,ca.institution_id,ca.id,ca.identity_basis,ca.external_reference FROM app.custody_accounts ca WHERE ca.household_id=$1 ORDER BY ca.owner_id,ca.institution_id`,[household]);
 const accountsByKey=new Map<string,typeof accounts.rows>();for(const a of accounts.rows){const k=String(a.owner_id)+'\0'+String(a.institution_id),list=accountsByKey.get(k)??[];list.push(a);accountsByKey.set(k,list);}
 const snapshotDates=[...new Set(inputs.snapshots.filter(r=>r.file_type==='positions').map(r=>String(r.reference_date??'')).filter(Boolean))];
 const assertionQuery=await db.query(`WITH selected AS (
   SELECT DISTINCT ON(owner_id,effective_as_of) household_id,id,owner_id,effective_as_of
   FROM app.source_documents WHERE household_id=$1 AND source_system='B3' AND report_kind='position' AND effective_as_of=ANY($2::date[])
   ORDER BY owner_id,effective_as_of,registered_at DESC,id DESC
  ) SELECT a.id,a.owner_id,a.institution_id,a.custody_account_id,a.instrument_code,a.quantity::text AS quantity,a.asserted_on::text AS asserted_on
  FROM selected d JOIN app.source_assertions a ON a.household_id=d.household_id AND a.document_id=d.id AND a.assertion_kind='position'`,[household,snapshotDates]);
 const assertions=assertionQuery.rows;
 const candidates:Match[]=[];let skippedKnown=0,unmappedInstitution=0,noAssertion=0,ambiguous=0,accountNotUnique=0;
 for(const row of inputs.snapshots){if(row.file_type!=='positions')continue;
  const rawRecord=sourceRows.get(row.id);if(!rawRecord)throw new Error('MISSING_SOURCE_RECORD');
  const item=JSON.parse(String(rawRecord.payload)) as Row;if(item.account)skippedKnown++;
  const owner=ownerId(String(item.owner??row.owner)),institution=aliasMap.get(norm(item.institution));
  if(!institution){unmappedInstitution++;continue;}
  const identityAccounts=accountsByKey.get(owner+'\0'+institution)??[];
  if(identityAccounts.length!==1||identityAccounts[0].identity_basis==='pending'){accountNotUnique++;continue;}
  if(item.account&&identityAccounts[0].external_reference&&norm(item.account)!==norm(identityAccounts[0].external_reference)){accountNotUnique++;continue;}
  const code=codeOf(item.instrument_code||item.product_name),quantity=exact(String(item.quantity)).toFixed();
  const matches=assertions.filter(a=>String(a.owner_id)===owner&&String(a.institution_id)===institution&&String(a.asserted_on)===String(item.reference_date??row.reference_date)&&String(a.custody_account_id)===String(identityAccounts[0].id)&&String(a.quantity)===quantity&&a.instrument_code&&codeOf(a.instrument_code)===code);
  if(matches.length!==1){if(matches.length>1)ambiguous++;else noAssertion++;continue;}
  candidates.push({source_record_id:row.id,snapshot_id:`${row.import_id}:${row.id}`,assertion_id:String(matches[0].id),custody_account_id:String(identityAccounts[0].id),owner_id:owner,institution_id:institution});
 }
 const assertionCounts=new Map<string,number>();for(const c of candidates)assertionCounts.set(c.assertion_id,(assertionCounts.get(c.assertion_id)??0)+1);
 const unique=candidates.filter(c=>assertionCounts.get(c.assertion_id)===1);ambiguous+=candidates.length-unique.length;
 const existing=await db.query(`SELECT DISTINCT ON(source_record_id) source_record_id,assertion_id,custody_account_id FROM app.position_account_resolutions WHERE run_id=$1 AND household_id=$2 ORDER BY source_record_id,resolution_version DESC`,[run,household]);
 let replayed=0;const inserts:Match[]=[];
 for(const c of unique){const old=existing.rows.find(r=>r.source_record_id===c.source_record_id);if(old){if(old.assertion_id!==c.assertion_id||old.custody_account_id!==c.custody_account_id)throw new Error('EXISTING_RESOLUTION_CONFLICT');replayed++;}else inserts.push(c);}
 const priorView=state.rows[0].view as Record<string,unknown>&{positions:Array<Record<string,unknown>>;identity_complete:boolean};
 const accountByInstitution=new Map<string,string>();for(const m of unique){const k=m.owner_id+'\0'+m.institution_id,old=accountByInstitution.get(k);if(old&&old!==m.custody_account_id)throw new Error('MULTIPLE_ACCOUNTS_IN_CUSTODY');accountByInstitution.set(k,m.custody_account_id);}
 const expectedCounts=new Map<string,number>();for(const m of unique){const k=m.owner_id+'\0'+m.institution_id;expectedCounts.set(k,(expectedCounts.get(k)??0)+1);}
 const currentCounts=new Map<string,number>();for(const p of priorView.positions){const k=String(p.owner_id)+'\0'+(aliasMap.get(norm(p.institution))??'');if(accountByInstitution.has(k))currentCounts.set(k,(currentCounts.get(k)??0)+1);}
 let countAligned=true;for(const [k,n] of expectedCounts)if(currentCounts.get(k)!==n)countAligned=false;
 const nextView=JSON.parse(JSON.stringify(priorView)) as typeof priorView;let relabeled=0;
 for(const p of nextView.positions){const key=String(p.owner_id)+'\0'+(aliasMap.get(norm(p.institution))??''),custodyAccount=accountByInstitution.get(key);if(!custodyAccount)continue;p.account_id=accountId(JSON.stringify([String(p.owner),'custody:'+custodyAccount]));p.identity_status='known';relabeled++;}
 if(!countAligned||relabeled!==unique.length)throw new Error('POSITION_CROSSWALK_COUNT_MISMATCH');
 nextView.identity_complete=nextView.positions.every(p=>p.identity_status==='known');
 const summary={mode:apply?'apply':'dry_run',source_version:currentVersion,snapshot_dates:snapshotDates,assertion_rows:assertions.length,eligible_positions:unique.length,replayed,ready_to_resolve:inserts.length,positions_relabeled:relabeled,skipped_known:skippedKnown,unmapped_institution:unmappedInstitution,account_not_unique:accountNotUnique,no_unique_assertion:noAssertion,ambiguous,projection_bucket_counts_aligned:countAligned,portfolio_published:false,financial_quantities_changed:false};
 if(!apply){console.log(JSON.stringify(summary));process.exitCode=0;}
 else if(!inserts.length){console.log(JSON.stringify({...summary,mode:'replayed',portfolio_version:currentVersion,facts_revision:state.rows[0].facts_revision,identity_complete:priorView.identity_complete}));}
 else{
  const c=await db.connect();try{await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(736428)');
   const check=await c.query(`SELECT s.latest_version,s.facts_revision,v.run_id FROM app.household_state s JOIN app.portfolio_versions v ON v.household_id=s.household_id AND v.id=s.latest_version WHERE s.household_id=$1 FOR UPDATE`,[household]);
   if(check.rows[0]?.latest_version!==currentVersion||check.rows[0]?.run_id!==run||String(check.rows[0]?.facts_revision)!==String(state.rows[0].facts_revision))throw new Error('STALE_SOURCE_VERSION');
   const actor=`legacy-shared:${household}`;
   for(const item of inserts){const prior=await c.query(`SELECT resolution_version,assertion_id,custody_account_id FROM app.position_account_resolutions WHERE run_id=$1 AND household_id=$2 AND source_record_id=$3 ORDER BY resolution_version DESC LIMIT 1 FOR UPDATE`,[run,household,item.source_record_id]);
    if(prior.rowCount&& (prior.rows[0].assertion_id!==item.assertion_id||prior.rows[0].custody_account_id!==item.custody_account_id))throw new Error('EXISTING_RESOLUTION_CONFLICT');
    if(prior.rowCount)continue;
    await c.query(`INSERT INTO app.position_account_resolutions(run_id,household_id,source_record_id,resolution_version,snapshot_id,assertion_id,custody_account_id,decision,actor_id)
     VALUES($1,$2,$3,1,$4,$5,$6,'same_custody_account_confirmed_by_institution_uniqueness',$7)`,[run,household,item.source_record_id,item.snapshot_id,item.assertion_id,item.custody_account_id,actor]);
   }
   const factsRevision=String(BigInt(String(state.rows[0].facts_revision))+(inserts.length?1n:0n));
   const knownNow=new Date().toISOString(),calculation=`account-identity-v1:${state.rows[0].calculation_version}`;
   const version=digest(JSON.stringify([currentVersion,run,household,factsRevision,knownNow,calculation,inserts]));
   await c.query(`INSERT INTO app.portfolio_versions(household_id,id,run_id,facts_revision,market_revision,calculation_version,effective_as_of,known_at,view)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,[household,version,run,factsRevision,state.rows[0].market_revision,calculation,effective,knownNow,nextView]);
   if(inserts.length)await c.query(`INSERT INTO app.audit_log(household_id,actor_id,action,resource_id,details) VALUES($1,$2,'b3_position_accounts_resolved',$3,$4)`,[household,actor,String(run),{inserted:inserts.length,method:'exact owner, institution, effective date, instrument and quantity match',portfolio_published:false,financial_quantities_changed:false,positions_relabeled:relabeled}]);
   await c.query('UPDATE app.household_state SET facts_revision=$2,latest_version=$3 WHERE household_id=$1',[household,factsRevision,version]);
   await c.query('COMMIT');console.log(JSON.stringify({...summary,mode:'applied',inserted:inserts.length,portfolio_version:version,facts_revision:factsRevision,identity_complete:nextView.identity_complete,portfolio_published:false,financial_quantities_changed:false}));
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 }
}finally{await db.end();}
