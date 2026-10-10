/** Apply one explicit user's source-to-account confirmation to the shadow only. */
import {readFile} from 'node:fs/promises';
import {pool} from '../../services/application/src/db.ts';
import {selectInputs,type Row} from '../../services/application/src/portfolio.ts';
import {confirmSameAccount} from '../../services/application/src/resolution.ts';
const [envelopePath,owner,code,date,decision]=process.argv.slice(2);
if(!envelopePath||!owner||!code||!date||decision!=='confirmed_same_account')throw new Error('Usage: confirm_account.ts private-envelope owner code YYYY-MM-DD confirmed_same_account');
const raw=JSON.parse(await readFile(envelopePath,'utf8')) as {source_sha256:string;exported_at:string;content:{tables:Record<string,Row[]>}};
const households=[...new Set(raw.content.tables.imports.map(r=>String(r.user_id)))];if(households.length!==1)throw new Error('EXPECTED_ONE_HOUSEHOLD');
const household=households[0];const selected=selectInputs(raw.content.tables,household,raw.exported_at.slice(0,10),raw.exported_at);
const trades=selected.trades.filter(r=>{const p=JSON.parse(r.payload) as Row;return p.owner===owner&&p.instrument_code===code&&p.trade_date===date&&!p.account;});
const candidates=selected.snapshots.filter(r=>{const p=JSON.parse(r.payload) as Row;return p.owner===owner&&p.instrument_code===code&&Boolean(p.account)&&String(p.reference_date)<date;});
if(trades.length!==1||candidates.length!==1)throw new Error('SOURCE_ACCOUNT_NOT_UNAMBIGUOUS');
const snapshot=candidates[0];const accountSnapshotId=snapshot.import_id+':'+snapshot.id;
const db=pool();try{
 const result=await confirmSameAccount(db,{run:raw.source_sha256,household,trade_record_id:trades[0].id,snapshot_id:accountSnapshotId});
 console.log(JSON.stringify({account_confirmation_recorded:!result.replayed,replayed:result.replayed,source_record_id:trades[0].id,snapshot_record_id:accountSnapshotId,financial_live_system_modified:false}));
}finally{await db.end();}
