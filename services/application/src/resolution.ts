import type pg from 'pg';
import {Conflict} from './commands.ts';
import {accountId,ownerId} from './migration.ts';
import type {Row} from './portfolio.ts';
export type AccountConfirmation={run:string;household:string;trade_record_id:string;snapshot_id:string};
/** Records a user's specific account confirmation in the shadow only. */
export async function confirmSameAccount(db:pg.Pool,input:AccountConfirmation){
 const c=await db.connect();
 try{
  await c.query('BEGIN');
  const state=await c.query('SELECT latest_version FROM app.household_state WHERE household_id=$1 FOR UPDATE',[input.household]);
  if(!state.rowCount)throw new Conflict('NOT_FOUND',404);
  const latest=await c.query('SELECT run_id FROM app.portfolio_versions WHERE household_id=$1 AND id=$2',[input.household,state.rows[0].latest_version]);
  if(latest.rows[0]?.run_id!==input.run)throw new Conflict('STALE_SOURCE');
  const existing=await c.query('SELECT snapshot_id FROM app.account_resolutions WHERE run_id=$1 AND household_id=$2 AND source_record_id=$3',[input.run,input.household,input.trade_record_id]);
  if(existing.rowCount){if(existing.rows[0].snapshot_id!==input.snapshot_id)throw new Conflict('RESOLUTION_CHANGED');await c.query('COMMIT');return {replayed:true};}
  const source=await c.query("SELECT original FROM app.received_sources WHERE run_id=$1 AND household_id=$2 AND id=$3 AND source_table='import_records'",[input.run,input.household,'import_records:'+input.trade_record_id]);
  const snapshot=await c.query(`SELECT s.*,a.identity_status,a.source_scope,r.original AS record_original
    FROM app.snapshots s JOIN app.accounts a ON a.household_id=s.household_id AND a.id=s.account_id
    JOIN app.received_sources r ON r.run_id=s.run_id AND r.household_id=s.household_id AND r.id='import_records:'||split_part(s.id,':',2)
    WHERE s.run_id=$1 AND s.household_id=$2 AND s.id=$3 FOR UPDATE OF s`,[input.run,input.household,input.snapshot_id]);
  if(!source.rowCount||!snapshot.rowCount)throw new Conflict('NOT_FOUND',404);
  const trade=JSON.parse(String((JSON.parse(source.rows[0].original) as Row).payload)) as Row;
  const position=JSON.parse(String((JSON.parse(snapshot.rows[0].record_original) as Row).payload)) as Row;
  const row=snapshot.rows[0];
  if(trade.account||row.identity_status!=='known'||!position.account||!trade.instrument_code||trade.instrument_code!==position.instrument_code||trade.owner!==position.owner||!trade.trade_date||String(trade.trade_date)<=String(row.effective_date)||trade.currency&&position.currency&&trade.currency!==position.currency||ownerId(String(trade.owner))!==row.owner_id||accountId(row.source_scope)!==row.account_id)throw new Conflict('EVIDENCE_MISMATCH');
  const actor='legacy-shared:'+input.household;
  await c.query("INSERT INTO app.account_resolutions(run_id,household_id,source_record_id,snapshot_id,account_id,decision,actor_id) VALUES($1,$2,$3,$4,$5,'same_account_confirmed_by_user',$6)",[input.run,input.household,input.trade_record_id,input.snapshot_id,row.account_id,actor]);
  await c.query('UPDATE app.household_state SET facts_revision=facts_revision+1 WHERE household_id=$1',[input.household]);
  await c.query("INSERT INTO app.audit_log(household_id,actor_id,action,resource_id,details) VALUES($1,$2,'account_resolution_confirmed',$3,$4)",[input.household,actor,input.trade_record_id,{run_id:input.run,snapshot_id:input.snapshot_id,individual_attribution:'unknown',origin:'user_confirmation_in_work_session'}]);
  await c.query('COMMIT');return {replayed:false};
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
export type AccountAliasConfirmation={run:string;household:string;owner:string;source_account_ref:string;snapshot_id:string};
/** Records a confirmed provider account alias for one owner and evidence run. */
export async function confirmAccountAlias(db:pg.Pool,input:AccountAliasConfirmation){
 const c=await db.connect();try{
  await c.query('BEGIN');const state=await c.query('SELECT latest_version FROM app.household_state WHERE household_id=$1 FOR UPDATE',[input.household]);if(!state.rowCount)throw new Conflict('NOT_FOUND',404);
  const latest=await c.query('SELECT run_id FROM app.portfolio_versions WHERE household_id=$1 AND id=$2',[input.household,state.rows[0].latest_version]);if(latest.rows[0]?.run_id!==input.run)throw new Conflict('STALE_SOURCE');
  const ownerKey=ownerId(input.owner),sourceRef=input.source_account_ref.trim();if(!sourceRef||sourceRef.length>128)throw new Conflict('INVALID_ACCOUNT_REFERENCE',422);
  const existing=await c.query('SELECT snapshot_id,account_id FROM app.account_alias_resolutions WHERE run_id=$1 AND household_id=$2 AND owner_id=$3 AND source_type=$4 AND source_account_ref=$5',[input.run,input.household,ownerKey,'avenue_confirmation',sourceRef]);
  const snapshot=await c.query(`SELECT s.*,a.identity_status,a.source_scope,r.original AS record_original
   FROM app.snapshots s JOIN app.accounts a ON a.household_id=s.household_id AND a.id=s.account_id
   JOIN app.received_sources r ON r.run_id=s.run_id AND r.household_id=s.household_id AND r.id='import_records:'||split_part(s.id,':',2)
   WHERE s.run_id=$1 AND s.household_id=$2 AND s.id=$3 FOR UPDATE OF s`,[input.run,input.household,input.snapshot_id]);
  if(!snapshot.rowCount)throw new Conflict('NOT_FOUND',404);const row=snapshot.rows[0];
  const position=JSON.parse(String((JSON.parse(row.record_original) as Row).payload)) as Row;
  if(row.source_type!=='avenue_statement'||row.owner_id!==ownerKey||row.identity_status!=='known'||String(position.owner)!==input.owner||!position.account||String(position.account)===sourceRef||accountId(row.source_scope)!==row.account_id)throw new Conflict('EVIDENCE_MISMATCH');
  const sourceRows=await c.query(`SELECT r.original,i.original AS import_original FROM app.received_sources r
   JOIN app.received_sources i ON i.run_id=r.run_id AND i.household_id=r.household_id AND i.source_table='imports'
    AND i.id='imports:'||((r.original::jsonb)->>'import_id')
   WHERE r.run_id=$1 AND r.household_id=$2 AND r.source_table='import_records'`,[input.run,input.household]);
  let matches=0;for(const source of sourceRows.rows){const imported=JSON.parse(source.import_original) as Row;const record=JSON.parse(source.original) as Row;if(imported.file_type!=='avenue_confirmation'||String(imported.owner)!==input.owner||record.record_kind!=='trade')continue;const trade=JSON.parse(String(record.payload)) as Row;if(String(trade.account??'')===sourceRef)matches++;}
  if(!matches)throw new Conflict('ALIAS_EVIDENCE_NOT_FOUND');
  if(existing.rowCount){if(existing.rows[0].snapshot_id!==input.snapshot_id||existing.rows[0].account_id!==row.account_id)throw new Conflict('RESOLUTION_CHANGED');await c.query('COMMIT');return{replayed:true,matched_records:matches};}
  const actor='legacy-shared:'+input.household;
  await c.query("INSERT INTO app.account_alias_resolutions(run_id,household_id,owner_id,source_type,source_account_ref,snapshot_id,account_id,decision,actor_id) VALUES($1,$2,$3,'avenue_confirmation',$4,$5,$6,'same_account_confirmed_by_user',$7)",[input.run,input.household,ownerKey,sourceRef,input.snapshot_id,row.account_id,actor]);
  await c.query('UPDATE app.household_state SET facts_revision=facts_revision+1 WHERE household_id=$1',[input.household]);
  await c.query("INSERT INTO app.audit_log(household_id,actor_id,action,resource_id,details) VALUES($1,$2,'account_alias_resolution_confirmed',$3,$4)",[input.household,actor,sourceRef,{run_id:input.run,owner:input.owner,snapshot_id:input.snapshot_id,account_id:row.account_id,matched_records:matches,individual_attribution:'unknown',origin:'user_confirmation_in_work_session'}]);
  await c.query('COMMIT');return{replayed:false,matched_records:matches};
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
export type TradeAttributionConfirmation={run:string;household:string;source_record_id:string;source_owner:string;target_owner:string;instrument_code:string;snapshot_id:string};
/** Records an explicit user correction of who owns one source trade and its custody account. */
export async function confirmTradeAttribution(db:pg.Pool,input:TradeAttributionConfirmation){
 const c=await db.connect();try{
  await c.query('BEGIN');const state=await c.query('SELECT latest_version FROM app.household_state WHERE household_id=$1 FOR UPDATE',[input.household]);if(!state.rowCount)throw new Conflict('NOT_FOUND',404);
  const latest=await c.query('SELECT run_id FROM app.portfolio_versions WHERE household_id=$1 AND id=$2',[input.household,state.rows[0].latest_version]);if(latest.rows[0]?.run_id!==input.run)throw new Conflict('STALE_SOURCE');
  const source=await c.query(`SELECT r.original,i.original AS import_original FROM app.received_sources r
   JOIN app.received_sources i ON i.run_id=r.run_id AND i.household_id=r.household_id AND i.source_table='imports'
    AND i.id='imports:'||((r.original::jsonb)->>'import_id')
   WHERE r.run_id=$1 AND r.household_id=$2 AND r.id=$3 AND r.source_table='import_records'`,[input.run,input.household,'import_records:'+input.source_record_id]);if(!source.rowCount)throw new Conflict('NOT_FOUND',404);
  const original=JSON.parse(source.rows[0].original) as Row,imported=JSON.parse(source.rows[0].import_original) as Row,trade=JSON.parse(String(original.payload)) as Row;
  if(imported.file_type!=='avenue_confirmation'||String(imported.owner)!==input.source_owner||original.record_kind!=='trade'||String(trade.owner)!==input.source_owner||String(trade.instrument_code)!==input.instrument_code||String(trade.side)!=='buy')throw new Conflict('SOURCE_TRADE_MISMATCH');
  const ownerKey=ownerId(input.target_owner),target=await c.query(`SELECT s.*,a.source_scope,a.identity_status,o.display_name,r.original AS record_original FROM app.snapshots s
   JOIN app.accounts a ON a.household_id=s.household_id AND a.id=s.account_id JOIN app.owners o ON o.household_id=s.household_id AND o.id=s.owner_id
   JOIN app.received_sources r ON r.run_id=s.run_id AND r.household_id=s.household_id AND r.id='import_records:'||split_part(s.id,':',2)
   WHERE s.run_id=$1 AND s.household_id=$2 AND s.id=$3 FOR UPDATE OF s`,[input.run,input.household,input.snapshot_id]);if(!target.rowCount)throw new Conflict('NOT_FOUND',404);
  const row=target.rows[0],position=JSON.parse(String((JSON.parse(row.record_original) as Row).payload)) as Row;
  if(row.source_type!=='avenue_statement'||row.identity_status!=='known'||row.owner_id!==ownerKey||row.display_name!==input.target_owner||String(position.owner)!==input.target_owner||String(position.instrument_code)!==input.instrument_code||!position.account||!trade.account||String(trade.account)===String(position.account)||String(trade.currency??'USD')!=='USD'||String(position.currency??'USD')!=='USD'||String(trade.trade_date)>=String(row.effective_date)||accountId(row.source_scope)!==row.account_id)throw new Conflict('EVIDENCE_MISMATCH');
  const alias=await c.query(`SELECT account_id FROM app.account_alias_resolutions WHERE run_id=$1 AND household_id=$2 AND owner_id=$3 AND source_type='avenue_confirmation' AND source_account_ref=$4`,[input.run,input.household,ownerKey,String(trade.account)]);if(!alias.rowCount||alias.rows[0].account_id!==row.account_id)throw new Conflict('ACCOUNT_ALIAS_NOT_CONFIRMED');
  const existing=await c.query('SELECT snapshot_id,owner_id,account_id FROM app.trade_attribution_resolutions WHERE run_id=$1 AND household_id=$2 AND source_record_id=$3',[input.run,input.household,input.source_record_id]);
  if(existing.rowCount){if(existing.rows[0].snapshot_id!==input.snapshot_id||existing.rows[0].owner_id!==ownerKey||existing.rows[0].account_id!==row.account_id)throw new Conflict('RESOLUTION_CHANGED');await c.query('COMMIT');return{replayed:true};}
  const actor='legacy-shared:'+input.household;
  await c.query("INSERT INTO app.trade_attribution_resolutions(run_id,household_id,source_record_id,source_owner_ref,owner_id,account_id,snapshot_id,decision,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,'owner_and_account_confirmed_by_user',$8)",[input.run,input.household,input.source_record_id,input.source_owner,ownerKey,row.account_id,input.snapshot_id,actor]);
  await c.query('UPDATE app.household_state SET facts_revision=facts_revision+1 WHERE household_id=$1',[input.household]);
  await c.query("INSERT INTO app.audit_log(household_id,actor_id,action,resource_id,details) VALUES($1,$2,'trade_attribution_confirmed',$3,$4)",[input.household,actor,input.source_record_id,{run_id:input.run,source_owner:input.source_owner,target_owner:input.target_owner,instrument_code:input.instrument_code,snapshot_id:input.snapshot_id,account_id:row.account_id,individual_attribution:'user_confirmed',origin:'user_confirmation_in_work_session'}]);
  await c.query('COMMIT');return{replayed:false};
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
