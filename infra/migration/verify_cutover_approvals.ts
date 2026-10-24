import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {basename,resolve} from 'node:path';

const privateRoot='/home/jorge/.local/share/juanca-shadow/reports/';
const reportArg=process.argv.find(value=>value.startsWith('--report='))?.slice(9);
const reportPath=resolve(reportArg??'');
if(!reportArg||!reportPath.startsWith(privateRoot))throw new Error('PRIVATE_FROZEN_REPORT_REQUIRED');
const report=JSON.parse(await readFile(reportPath,'utf8')) as any;
if(report.mode!=='freeze_asserted_read_only'||report.freeze_confirmed_by_operator!==true||report.capture_stable!==true||report.dates_match!==true)throw new Error('STABLE_FROZEN_CAPTURE_REQUIRED');
const comparison=report.comparison;
if(!Array.isArray(comparison?.differences)||typeof comparison.content_sha256!=='string')throw new Error('INVALID_DELTA_REPORT');
const credentialsPath=process.env.JUANCA_GATEWAY_CREDENTIALS??'/home/jorge/.hermes/profiles/juanca/workspace/patrimonio-familiar-source/integration/credentials.json';
const baseUrl=process.env.JUANCA_GATEWAY_URL??'http://127.0.0.1:3040';
const credentials=JSON.parse(await readFile(credentialsPath,'utf8')) as {token:string};
const response=await fetch(new URL('/api/shadow/confirmations?status=resolved',baseUrl),{headers:{authorization:`Bearer ${credentials.token}`,accept:'application/json'},cache:'no-store'});
if(!response.ok)throw new Error(`CONFIRMATIONS_READ_${response.status}`);
const payload=await response.json() as {items:Array<any>};
const byKey=new Map((payload.items??[]).map(item=>[item.source_key,item]));
const residual=byKey.get('cutover-residual-valuation-20261024-225aa910');
const covered:string[]=[];const uncovered:Array<{ticker:string;kind:string}>=[];
for(const difference of comparison.differences as Array<any>){
 const ticker=String(difference.instrument_code),kind=String(difference.kind);
 let item:any,valid=false;
 if(kind==='value_only'){
  item=residual;const context=item?.context??{};
  valid=item?.status==='resolved'&&item?.decision?.action_key==='accept_current_market_values'
   &&context.delta_sha256===comparison.content_sha256
   &&Number(context.diferencias_solo_valor)===Number(comparison.counts.value_only);
 }else if(kind==='quantity_and_value'){
  item=byKey.get(`cutover-delta-20261021-jorge-${ticker.toLowerCase()}-quantity`);const context=item?.context??{};
  valid=item?.status==='resolved'&&item?.decision?.action_key==='accept_latest_quantity'
   &&String(context.d1_cantidad)===String(difference.d1_quantity)
   &&String(context.postgres_cantidad)===String(difference.postgres_quantity);
 }else if(kind==='d1_only'){
  item=byKey.get(`cutover-delta-20261021-jorge-${ticker.toLowerCase()}-absent`);const context=item?.context??{};
  valid=item?.status==='resolved'&&item?.decision?.action_key==='not_held_on_cut'
   &&String(context.d1_cantidad)===String(difference.d1_quantity)&&!difference.postgres_quantity;
 }
 if(valid)covered.push(`${ticker}:${kind}`);else uncovered.push({ticker,kind});
}
const attestation={format:'juanca-cutover-approved-delta-v1',created_at:new Date().toISOString(),frozen_report:basename(reportPath),delta_sha256:comparison.content_sha256,
 capture_stable:report.capture_stable,dates_match:report.dates_match,difference_count:comparison.differences.length,covered_count:covered.length,uncovered};
if(uncovered.length)throw new Error(`UNAPPROVED_CUTOVER_DIFFERENCES:${JSON.stringify(uncovered)}`);
const out=`${privateRoot}cutover-approved-delta-${new Date().toISOString().replaceAll(':','-')}.json`;
await mkdir(privateRoot,{recursive:true,mode:0o700});await writeFile(out,JSON.stringify(attestation,null,2),{mode:0o600,flag:'wx'});
console.log(JSON.stringify({attestation:out,delta_sha256:attestation.delta_sha256,differences:attestation.difference_count,covered:attestation.covered_count,uncovered:0}));
