import {readFile} from 'node:fs/promises';
import {pool,migrate} from '../../services/application/src/db.ts';
import {selectInputs,type Row} from '../../services/application/src/portfolio.ts';
import {confirmAccountAlias} from '../../services/application/src/resolution.ts';
import {publish} from '../../services/application/src/migration.ts';
const [envelopePath,owner,alias,decision]=process.argv.slice(2);
if(!envelopePath||!owner||!alias||decision!=='confirmed_same_account')throw new Error('Usage: confirm_account_alias.ts private-envelope owner provider-account-reference confirmed_same_account');
const envelope=JSON.parse(await readFile(envelopePath,'utf8')) as {source_sha256:string;exported_at:string;content:{tables:Record<string,Row[]>}};
const households=[...new Set(envelope.content.tables.imports.map(row=>String(row.user_id)))];if(households.length!==1)throw new Error('EXPECTED_ONE_HOUSEHOLD');
const household=households[0],effective=envelope.exported_at.slice(0,10),inputs=selectInputs(envelope.content.tables,household,effective,envelope.exported_at);
const sourceTrades=inputs.trades.filter(row=>row.file_type==='avenue_confirmation'&&row.owner===owner&&String((JSON.parse(row.payload) as Row).account??'')===alias);if(!sourceTrades.length)throw new Error('ALIAS_EVIDENCE_NOT_FOUND');
const statements=inputs.snapshots.filter(row=>row.file_type==='avenue_statement'&&row.owner===owner&&Boolean((JSON.parse(row.payload) as Row).account));
const accountRefs=[...new Set(statements.map(row=>String((JSON.parse(row.payload) as Row).account)))];if(accountRefs.length!==1)throw new Error('STATEMENT_ACCOUNT_NOT_UNAMBIGUOUS');
const target=statements[0];if(!target)throw new Error('STATEMENT_SNAPSHOT_NOT_FOUND');const snapshotId=target.import_id+':'+target.id;
const db=pool();try{
 await migrate(db);const resolution=await confirmAccountAlias(db,{run:envelope.source_sha256,household,owner,source_account_ref:alias,snapshot_id:snapshotId});
 const portfolio=await publish(db,envelope.source_sha256,household,effective,envelope.exported_at);
 console.log(JSON.stringify({account_alias_resolution_recorded:!resolution.replayed,replayed:resolution.replayed,matched_source_records:resolution.matched_records,portfolio_version:portfolio.portfolio_version,position_count:portfolio.view.count,financial_live_system_modified:false}));
}finally{await db.end();}
