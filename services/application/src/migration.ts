import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import type pg from 'pg';
import {exact,integer} from './money.ts';
import {accountScope,buildPortfolio,selectInputs,type Row} from './portfolio.ts';
export type Envelope={source_sha256:string;exported_at:string;canonical_content:string;content:{format:number;tables:Record<string,Row[]>;conversation_archive:Row[]}};
export function hash(value:string){return createHash('sha256').update(value).digest('hex');}
export function ownerId(owner:string){return 'owner-'+hash(owner).slice(0,24);}
export function accountId(scope:string){return 'account-'+hash(scope).slice(0,24);}
export function summaryHash(p:Row){return hash(JSON.stringify([p.owner_id,p.account_id,p.instrument_code,p.side,exact(p.quantity).toFixed(),exact(p.unit_price).toFixed(),p.currency,p.effective_date,integer(p.fees_minor??'0')]));}
export async function importEnvelope(db:pg.Pool,path:string){
 const envelope=JSON.parse(await readFile(path,'utf8')) as Envelope;
 // Python's original canonical JSON is reserialized with sorted keys before hashing.
 const canonical=(v:unknown):string=>{if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';if(v&&typeof v==='object')return '{'+Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,val])=>JSON.stringify(k)+':'+canonical(val)).join(',')+'}';return JSON.stringify(v);};
 if(envelope.content.format!==1||hash(envelope.canonical_content)!==envelope.source_sha256||canonical(JSON.parse(envelope.canonical_content))!==canonical(envelope.content))throw new Error('SOURCE_HASH_MISMATCH');
 const c=await db.connect();const run=envelope.source_sha256;const tables=envelope.content.tables;
 try{
  await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(736429)');
  const old=await c.query('SELECT id FROM app.migration_runs WHERE source_sha256=$1',[run]);if(old.rowCount){await c.query('COMMIT');return {run_id:run,replayed:true};}
  const counts=Object.fromEntries(Object.entries(tables).map(([k,v])=>[k,v.length]));
  await c.query('INSERT INTO app.migration_runs(id,source_sha256,exported_at,source_counts,source_envelope) VALUES($1,$1,$2,$3,$4)',[run,envelope.exported_at,counts,envelope.canonical_content]);
  const households=[...new Set(tables.imports.map(r=>String(r.user_id)))];
  for(const h of households){
   await c.query('INSERT INTO app.households(id) VALUES($1) ON CONFLICT DO NOTHING',[h]);
   const actor='legacy-shared:'+h;await c.query("INSERT INTO app.actors(id,attribution) VALUES($1,'Shared legacy identity; individual author unknown') ON CONFLICT DO NOTHING",[actor]);
   await c.query("INSERT INTO app.memberships VALUES($1,$2,'legacy_shared') ON CONFLICT DO NOTHING",[h,actor]);
   await c.query('INSERT INTO app.household_state(household_id,facts_revision) VALUES($1,$2) ON CONFLICT(household_id) DO UPDATE SET facts_revision=GREATEST(app.household_state.facts_revision,EXCLUDED.facts_revision)',[h,String(tables.portfolio_revisions.find(r=>r.user_id===h)?.revision??0)]);
  }
  const imports=new Map(tables.imports.map(r=>[String(r.id),r]));
  for(const [table,rows] of Object.entries(tables))for(const [ordinal,r] of rows.entries()){
   const parent=table==='import_records'?imports.get(String(r.import_id)):null;const h=String(r.user_id??parent?.user_id??'');
   if(!households.includes(h))throw new Error('UNKNOWN_HOUSEHOLD');const original=canonical(r);
   await c.query('INSERT INTO app.received_sources VALUES($1,$2,$3,$4,$5,$6,$7)',[run,table+':'+String(r.id??r.proposal_id??r.user_id),h,table,original,hash(original),ordinal]);
  }
  // Account identity remains unresolved unless evidence supplies it explicitly.
  async function account(h:string,owner:string,type:string,p:Row){
   const o=ownerId(owner);const scope=accountScope(owner,type,p);const id=accountId(scope);
   await c.query('INSERT INTO app.owners VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[h,o,owner]);
   await c.query('INSERT INTO app.accounts VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[h,id,o,scope,p.account?'known':'unresolved']);
   return {owner_id:o,account_id:id};
  }
  for(const r of tables.import_records){
   const i=imports.get(String(r.import_id));if(!i)throw new Error('ORPHAN_SOURCE');
   const p=JSON.parse(String(r.payload)) as Row;const owner=String(p.owner??i.owner);const h=String(i.user_id);const a=await account(h,owner,String(i.file_type),p);
   if(r.record_kind==='position'&&p.reference_date){await c.query('INSERT INTO app.snapshots VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING',[run,h,String(i.id)+':'+String(r.id),a.owner_id,a.account_id,String(p.reference_date),String(i.created_at)+'Z',i.file_type,'unresolved']);}
   if(r.record_kind==='trade'){
    await c.query(`INSERT INTO app.events(household_id,id,owner_id,account_id,instrument_code,currency,side,quantity,unit_price,fees_minor,effective_date,settlement_date,known_at,evidence_id,application_status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'evidence_only') ON CONFLICT DO NOTHING`,[h,'legacy-record:'+String(r.id),a.owner_id,a.account_id,p.instrument_code,p.currency??'BRL',p.side,exact(p.quantity).toFixed(),exact(p.unit_price).toFixed(),integer(p.fees_minor??0),p.trade_date,p.settlement_date??null,String(i.created_at)+'Z','import_records:'+String(r.id)]);
   }
  }
  for(const p of tables.transaction_proposals){
   const h=String(p.user_id);const a=await account(h,String(p.owner),'chat_transaction',p);const normalized={...p,...a,effective_date:p.trade_date};
   await c.query(`INSERT INTO app.proposals(household_id,id,owner_id,account_id,instrument_code,currency,side,quantity,unit_price,fees_minor,effective_date,summary_hash,status,source_message_id,applied_event_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT DO NOTHING`,[h,p.id,a.owner_id,a.account_id,p.instrument_code,p.currency,p.side,exact(p.quantity).toFixed(),exact(p.unit_price).toFixed(),integer(p.fees_minor),p.trade_date,summaryHash(normalized),p.status,p.source_message_id??null,p.applied_import_id?'legacy-import:'+String(p.applied_import_id):null]);
  }
  for(const m of envelope.content.conversation_archive){await c.query('INSERT INTO app.conversation_archives VALUES($1,$2,$3,$4,$5)',[run,m.user_id,String(m.id),m.origin,canonical(m)]);}
  for(const h of households){await c.query("INSERT INTO app.audit_log(household_id,actor_id,action,resource_id,details) VALUES($1,$2,'shadow_evidence_import',$3,$4)",[h,'legacy-shared:'+h,run,{counts,actions_replayed:0}]);}
  await c.query('COMMIT');return {run_id:run,replayed:false};
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
export async function loadEnvelopeTables(db:pg.Pool,run:string,h:string){
 const result=await db.query('SELECT source_table,original FROM app.received_sources WHERE run_id=$1 AND household_id=$2 ORDER BY source_table,source_ordinal',[run,h]);
 const tables:Record<string,Row[]>=Object.fromEntries(['imports','import_records','market_quotes','fx_observations','portfolio_revisions','transaction_proposals','review_decisions','cost_basis','chat_messages','proposal_applications'].map(name=>[name,[]]));for(const row of result.rows){(tables[row.source_table]??=[]).push(JSON.parse(row.original) as Row);}
 return tables;
}
export async function publish(db:pg.Pool,run:string,h:string,effective:string,known:string){
 // Evidence is immutable, so building outside the publication transaction is safe.
 const tables=await loadEnvelopeTables(db,run,h);if(!tables.imports?.length)throw new Error('NOT_FOUND');
 const inputs=selectInputs(tables,h,effective,known);
 const positionResolutions=await db.query(`SELECT DISTINCT ON(par.source_record_id) par.source_record_id,par.snapshot_id,par.assertion_id,par.custody_account_id,ci.id AS institution_id,o.display_name AS owner
   FROM app.position_account_resolutions par JOIN app.custody_accounts ca ON ca.household_id=par.household_id AND ca.id=par.custody_account_id
   JOIN app.custody_institutions ci ON ci.id=ca.institution_id JOIN app.owners o ON o.household_id=ca.household_id AND o.id=ca.owner_id
   WHERE par.run_id=$1 AND par.household_id=$2 ORDER BY par.source_record_id,par.resolution_version DESC`,[run,h]);
 const positionMap=new Map<string,{custody_account_id:string;institution_id:string;assertion_id:string}>(positionResolutions.rows.map(r=>[String(r.snapshot_id),{custody_account_id:String(r.custody_account_id),institution_id:String(r.institution_id),assertion_id:String(r.assertion_id)}]));
 const resolvedScopes=new Map<string,string>(positionResolutions.rows.map(r=>[String(r.snapshot_id),JSON.stringify([String(r.owner),'custody:'+String(r.custody_account_id)])]));
 const resolutions=await db.query(`SELECT ar.source_record_id,ar.snapshot_id,a.source_scope FROM app.account_resolutions ar
   JOIN app.accounts a ON a.household_id=ar.household_id AND a.id=ar.account_id
   WHERE ar.run_id=$1 AND ar.household_id=$2 ORDER BY ar.source_record_id`,[run,h]);
 const aliases=await db.query(`SELECT o.display_name AS owner,ar.source_account_ref,a.source_scope FROM app.account_alias_resolutions ar
   JOIN app.accounts a ON a.household_id=ar.household_id AND a.id=ar.account_id
   JOIN app.owners o ON o.household_id=ar.household_id AND o.id=ar.owner_id
   WHERE ar.run_id=$1 AND ar.household_id=$2 ORDER BY ar.owner_id,ar.source_account_ref`,[run,h]);
 const attributions=await db.query(`SELECT ar.source_record_id,o.display_name AS owner,a.source_scope FROM app.trade_attribution_resolutions ar
   JOIN app.accounts a ON a.household_id=ar.household_id AND a.id=ar.account_id
   JOIN app.owners o ON o.household_id=ar.household_id AND o.id=ar.owner_id
   WHERE ar.run_id=$1 AND ar.household_id=$2 ORDER BY ar.source_record_id`,[run,h]);
 const revision=await db.query('SELECT facts_revision FROM app.household_state WHERE household_id=$1',[h]);
 if(!revision.rowCount)throw new Error('NOT_FOUND');
 const factsRevision=String(revision.rows[0].facts_revision);
 const accountResolutionMap=new Map<string,string>(resolutions.rows.map(r=>[String(r.source_record_id),resolvedScopes.get(String(r.snapshot_id))??String(r.source_scope)]));
 const view=buildPortfolio(inputs,accountResolutionMap,new Map(aliases.rows.map(r=>[r.owner+'\0'+r.source_account_ref,r.source_scope])),new Map(attributions.rows.map(r=>[r.source_record_id,{owner:r.owner,source_scope:r.source_scope}])),positionMap);
 view.positions=view.positions.map(p=>({...p,owner_id:ownerId(p.owner),account_id:accountId(p.account_id)}));
 const marketRevision=hash(JSON.stringify([inputs.quotes,inputs.fx]));const calculation='decimal-half-up-v1:'+hash((await readFile(new URL('./portfolio.ts',import.meta.url),'utf8'))+(await readFile(new URL('./money.ts',import.meta.url),'utf8')));
 const version=hash(JSON.stringify([run,h,effective,known,factsRevision,marketRevision,calculation,resolutions.rows,aliases.rows,attributions.rows,positionResolutions.rows]));
 const c=await db.connect();try{
  await c.query('BEGIN');const state=await c.query('SELECT facts_revision FROM app.household_state WHERE household_id=$1 FOR UPDATE',[h]);
  if(String(state.rows[0]?.facts_revision)!==factsRevision)throw new Error('STALE_RECONCILIATION');
  await c.query('INSERT INTO app.portfolio_versions(household_id,id,run_id,facts_revision,market_revision,calculation_version,effective_as_of,known_at,view) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING',[h,version,run,factsRevision,marketRevision,calculation,effective,known,view]);
  // Publishing a historical query cannot replace the current pointer.
  await c.query(`UPDATE app.household_state s SET latest_version=$2 WHERE s.household_id=$1 AND NOT EXISTS(SELECT 1 FROM app.portfolio_versions v WHERE v.household_id=s.household_id AND v.id=s.latest_version AND (v.effective_as_of>$3::date OR v.effective_as_of=$3::date AND v.known_at>$4::timestamptz))`,[h,version,effective,known]);
  await c.query('COMMIT');return {portfolio_version:version,view};
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
