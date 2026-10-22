import {accountId} from '../../services/application/src/migration.ts';
import {pool} from '../../services/application/src/db.ts';

type SourceAccount={household_id:string;id:string;owner_id:string;display_name:string;source_scope:string;identity_status:string};
type Custody={id:string;institution_id:string;canonical_name:string;identity_basis:string;owner_id:string;display_name:string};
function normalize(value:string){return value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/[^A-Z0-9]+/g,' ').trim().replace(/\s+/g,' ');}
const db=pool();
const apply=process.argv.includes('--apply');
try{
 const household=await db.query('SELECT household_id FROM app.household_state ORDER BY household_id LIMIT 1');if(!household.rowCount)throw new Error('HOUSEHOLD_NOT_FOUND');
 const h=String(household.rows[0].household_id);
 const accounts=await db.query(`SELECT a.household_id,a.id,a.owner_id,o.display_name,a.source_scope,a.identity_status
   FROM app.accounts a JOIN app.owners o ON o.household_id=a.household_id AND o.id=a.owner_id
   WHERE a.household_id=$1 AND a.identity_status='unresolved' ORDER BY o.display_name,a.source_scope`,[h]);
 const custody=await db.query(`SELECT ca.id,ca.owner_id,ca.institution_id,ca.identity_basis,o.display_name,ci.canonical_name
   FROM app.custody_accounts ca JOIN app.owners o ON o.household_id=ca.household_id AND o.id=ca.owner_id
   JOIN app.custody_institutions ci ON ci.id=ca.institution_id WHERE ca.household_id=$1`,[h]);
 const aliases=await db.query('SELECT normalized_alias,institution_id FROM app.custody_institution_aliases');
 const avenueAliases=await db.query(`SELECT DISTINCT ON(ar.owner_id,ar.source_account_ref) ar.owner_id,ar.source_account_ref,ar.account_id,a.identity_status
   FROM app.account_alias_resolutions ar JOIN app.accounts a ON a.household_id=ar.household_id AND a.id=ar.account_id
   JOIN app.migration_runs mr ON mr.id=ar.run_id
   WHERE ar.household_id=$1 AND ar.source_type='avenue_confirmation' AND ar.decision='same_account_confirmed_by_user'
   ORDER BY ar.owner_id,ar.source_account_ref,mr.exported_at DESC`,[h]);
 const plan:Array<{source:SourceAccount;canonicalId:string;canonicalScope:string;custodyId:string|null;decision:'user_confirmed_one_account_per_institution'|'user_confirmed_avenue_account_alias';evidence:Record<string,unknown>}>=[];
 const unresolved:Array<{owner:string;scope_kind:string;reason:string}> = [];
 for(const raw of accounts.rows as SourceAccount[]){
  const scope=JSON.parse(raw.source_scope) as string[],source=scope[1]??'';
  const match=source.match(/^unresolved:(positions|movements):(.+)$/);
  if(match){
   const alias=normalize(match[2]),institutionIds=[...new Set(aliases.rows.filter(a=>a.normalized_alias===alias).map(a=>String(a.institution_id)))];
   if(institutionIds.length!==1){unresolved.push({owner:raw.display_name,scope_kind:match[1],reason:'institution_alias_not_unique'});continue;}
   const candidates=(custody.rows as Custody[]).filter(c=>c.owner_id===raw.owner_id&&c.institution_id===institutionIds[0]&&c.identity_basis!=='pending');
   if(candidates.length!==1){unresolved.push({owner:raw.display_name,scope_kind:match[1],reason:candidates.length?'custody_account_not_unique':'custody_account_missing'});continue;}
   const ca=candidates[0],canonicalScope=JSON.stringify([raw.display_name,'custody:'+ca.id]);
   plan.push({source:raw,canonicalId:accountId(canonicalScope),canonicalScope,custodyId:ca.id,decision:'user_confirmed_one_account_per_institution',evidence:{source_scope_kind:match[1],institution_id:ca.institution_id,confirmation:'one_account_per_institution_and_holder',basis:ca.identity_basis}});
   continue;
  }
  if(source==='unresolved:chat_transaction:Avenue'){
   const candidates=avenueAliases.rows.filter(a=>a.owner_id===raw.owner_id&&a.source_account_ref==='6AJ-74139'&&a.identity_status==='known');
   if(candidates.length===1){const id=String(candidates[0].account_id),target=await db.query('SELECT source_scope FROM app.accounts WHERE household_id=$1 AND id=$2',[h,id]);
    if(target.rowCount===1){plan.push({source:raw,canonicalId:id,canonicalScope:String(target.rows[0].source_scope),custodyId:null,decision:'user_confirmed_avenue_account_alias',evidence:{source_account_alias:'Avenue',confirmed_reference:'6AJ-74139',confirmation:'same_account_confirmed_by_user'}});continue;}}
   unresolved.push({owner:raw.display_name,scope_kind:'chat_transaction',reason:'avenue_account_confirmation_missing_or_ambiguous'});continue;
  }
  unresolved.push({owner:raw.display_name,scope_kind:source.startsWith('unresolved:')?source.split(':')[1]:'other',reason:'no_explicit_identity_evidence'});
 }
 const already=await db.query(`SELECT DISTINCT ON(account_id) account_id,canonical_account_id,custody_account_id,decision
   FROM app.command_account_identity_resolutions WHERE household_id=$1 ORDER BY account_id,revision DESC`,[h]);
 const current=new Map(already.rows.map(r=>[String(r.account_id),r]));
 const actionable=plan.filter(x=>{const old=current.get(x.source.id);return !old||(old.canonical_account_id!==x.canonicalId||old.custody_account_id!==x.custodyId||old.decision!==x.decision);});
 if(apply&&actionable.length){
  const c=await db.connect();try{await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(736431)');
   for(const item of actionable){
    await c.query(`INSERT INTO app.accounts(household_id,id,owner_id,source_scope,identity_status) VALUES($1,$2,$3,$4,'known')
      ON CONFLICT(household_id,id) DO NOTHING`,[h,item.canonicalId,item.source.owner_id,item.canonicalScope]);
    const canonical=await c.query('SELECT owner_id,source_scope,identity_status FROM app.accounts WHERE household_id=$1 AND id=$2',[h,item.canonicalId]);
    if(canonical.rowCount!==1||canonical.rows[0].owner_id!==item.source.owner_id||canonical.rows[0].source_scope!==item.canonicalScope||canonical.rows[0].identity_status!=='known')throw new Error('CANONICAL_ACCOUNT_COLLISION');
    const old=await c.query('SELECT revision,canonical_account_id,custody_account_id,decision FROM app.command_account_identity_resolutions WHERE household_id=$1 AND account_id=$2 ORDER BY revision DESC LIMIT 1 FOR UPDATE',[h,item.source.id]);
    const revision=Number(old.rows[0]?.revision??0)+1;
    await c.query(`INSERT INTO app.command_account_identity_resolutions(household_id,account_id,owner_id,revision,canonical_account_id,custody_account_id,decision,evidence,actor_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[h,item.source.id,item.source.owner_id,revision,item.canonicalId,item.custodyId,item.decision,item.evidence,'legacy-shared:'+h]);
    await c.query("INSERT INTO app.audit_log(household_id,actor_id,action,resource_id,details) VALUES($1,$2,'command_account_identity_resolved',$3,$4)",[h,'legacy-shared:'+h,item.source.id,{canonical_account_id:item.canonicalId,custody_account_id:item.custodyId,decision:item.decision,evidence:item.evidence,financial_facts_changed:false}]);
   }
   await c.query('COMMIT');
  }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
 }
 const candidateDecisions:Record<string,number>={};for(const item of plan)candidateDecisions[item.decision]=(candidateDecisions[item.decision]??0)+1;
 console.log(JSON.stringify({mode:apply?'applied':'dry_run',candidate_count:plan.length,applied:apply?actionable.length:0,replayed:plan.length-actionable.length,
  candidate_decisions:candidateDecisions,excluded_unresolved:unresolved,
  parser_status_changed:false,movements_reconciled:false,holdings_changed:false,portfolio_published:false}));
}finally{await db.end();}
