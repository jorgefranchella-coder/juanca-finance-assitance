import {readFile} from 'node:fs/promises';
import {pool,migrate} from '../../services/application/src/db.ts';
import {selectInputs,type Row} from '../../services/application/src/portfolio.ts';
import {confirmTradeAttribution} from '../../services/application/src/resolution.ts';
import {publish} from '../../services/application/src/migration.ts';
const [envelopePath,sourceOwner,targetOwner,code,date,decision]=process.argv.slice(2);
if(!envelopePath||!sourceOwner||!targetOwner||!code||!date||decision!=='confirmed_owner_and_account')throw new Error('Usage: confirm_trade_attribution.ts private-envelope source-owner target-owner symbol YYYY-MM-DD confirmed_owner_and_account');
const envelope=JSON.parse(await readFile(envelopePath,'utf8')) as {source_sha256:string;exported_at:string;content:{tables:Record<string,Row[]>}};
const households=[...new Set(envelope.content.tables.imports.map(row=>String(row.user_id)))];if(households.length!==1)throw new Error('EXPECTED_ONE_HOUSEHOLD');
const household=households[0],effective=envelope.exported_at.slice(0,10),inputs=selectInputs(envelope.content.tables,household,effective,envelope.exported_at);
const trades=inputs.trades.filter(row=>row.file_type==='avenue_confirmation'&&row.owner===sourceOwner&&(()=>{const trade=JSON.parse(row.payload) as Row;return trade.instrument_code===code&&trade.trade_date===date;})());
const snapshots=inputs.snapshots.filter(row=>row.file_type==='avenue_statement'&&row.owner===targetOwner&&(()=>{const item=JSON.parse(row.payload) as Row;return item.instrument_code===code&&Boolean(item.account);})());
if(trades.length!==1||snapshots.length!==1)throw new Error('SOURCE_OR_TARGET_EVIDENCE_NOT_UNAMBIGUOUS');
const snapshot=snapshots[0],snapshotId=snapshot.import_id+':'+snapshot.id,db=pool();try{
 await migrate(db);const resolution=await confirmTradeAttribution(db,{run:envelope.source_sha256,household,source_record_id:trades[0].id,source_owner:sourceOwner,target_owner:targetOwner,instrument_code:code,snapshot_id:snapshotId});
 const portfolio=await publish(db,envelope.source_sha256,household,effective,envelope.exported_at);
 console.log(JSON.stringify({trade_attribution_recorded:!resolution.replayed,replayed:resolution.replayed,source_record_id:trades[0].id,target_snapshot_record_id:snapshotId,portfolio_version:portfolio.portfolio_version,position_count:portfolio.view.count,financial_live_system_modified:false}));
}finally{await db.end();}
