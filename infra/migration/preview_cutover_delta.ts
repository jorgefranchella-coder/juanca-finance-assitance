import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {comparePortfolioPositions,type PortfolioPosition} from './cutover_delta.ts';

const credentialsPath=process.env.JUANCA_GATEWAY_CREDENTIALS??'/home/jorge/.hermes/profiles/juanca/workspace/patrimonio-familiar-source/integration/credentials.json';
const baseUrl=process.env.JUANCA_GATEWAY_URL??'http://127.0.0.1:3040';
const freezeConfirmed=process.argv.includes('--freeze-confirmed');
const effectiveAsOf=process.argv.find(value=>value.startsWith('--effective-as-of='))?.slice(18);
if(effectiveAsOf&&(!/^\d{4}-\d{2}-\d{2}$/.test(effectiveAsOf)||Number.isNaN(Date.parse(`${effectiveAsOf}T00:00:00Z`))||new Date(`${effectiveAsOf}T00:00:00Z`).toISOString().slice(0,10)!==effectiveAsOf))throw new Error('INVALID_EFFECTIVE_AS_OF');
const privateRoot='/home/jorge/.local/share/juanca-shadow/reports/';
const requested=process.argv.find(value=>value.startsWith('--report='))?.slice(9)??`${privateRoot}cutover-delta-${new Date().toISOString().replaceAll(':','-')}.json`;
const reportPath=resolve(requested);if(!reportPath.startsWith(privateRoot))throw new Error('PRIVATE_REPORT_PATH_REQUIRED');
const auth=JSON.parse(await readFile(credentialsPath,'utf8')) as {token:string};if(typeof auth.token!=='string'||auth.token.length<24)throw new Error('GATEWAY_CREDENTIAL_REQUIRED');
async function read(path:string){const response=await fetch(new URL(path,baseUrl),{headers:{authorization:`Bearer ${auth.token}`,accept:'application/json'},cache:'no-store'});if(!response.ok)throw new Error(`READ_${response.status}:${path}`);return await response.json() as Record<string,unknown>;}
const shadowPath=effectiveAsOf?`/api/shadow/portfolio?effective_as_of=${effectiveAsOf}`:'/api/shadow/portfolio';
const [d1,postgres]=await Promise.all([read('/api/portfolio/positions'),read(shadowPath)]);
if(!Array.isArray(d1.positions)||!Array.isArray(postgres.positions))throw new Error('POSITION_ARRAY_REQUIRED');
const comparison=comparePortfolioPositions(d1.positions as PortfolioPosition[],postgres.positions as PortfolioPosition[]);
const [d1After,postgresAfter]=await Promise.all([read('/api/portfolio/positions'),read(shadowPath)]);
const stable=String(d1.facts_revision)===String(d1After.facts_revision)&&String(d1.portfolio_version)===String(d1After.portfolio_version)
 &&String(postgres.facts_revision)===String(postgresAfter.facts_revision)&&String(postgres.portfolio_version)===String(postgresAfter.portfolio_version);
const datesMatch=String(d1.reference_date)===String(postgres.effective_as_of);
const equal=comparison.differences.length===0&&comparison.d1_total_cents===comparison.postgres_total_cents;
const report={format:'juanca-cutover-delta-v1',captured_at:new Date().toISOString(),mode:freezeConfirmed?'freeze_asserted_read_only':'preflight_read_only',freeze_confirmed_by_operator:freezeConfirmed,
 d1:{reference_date:d1.reference_date,facts_revision:d1.facts_revision,portfolio_version:d1.portfolio_version,response_sha256:createHash('sha256').update(JSON.stringify(d1)).digest('hex')},
 postgres:{effective_as_of:postgres.effective_as_of,facts_revision:postgres.facts_revision,portfolio_version:postgres.portfolio_version,response_sha256:createHash('sha256').update(JSON.stringify(postgres)).digest('hex')},
 capture_stable:stable,dates_match:datesMatch,positions_and_values_match:equal,delta_final_verified:freezeConfirmed&&stable&&datesMatch&&equal,comparison};
await mkdir(dirname(reportPath),{recursive:true,mode:0o700});const temporary=`${reportPath}.${randomUUID()}.tmp`;
await writeFile(temporary,JSON.stringify(report,null,2),{mode:0o600,flag:'wx'});await rename(temporary,reportPath);
console.log(JSON.stringify({report:reportPath,mode:report.mode,capture_stable:stable,dates_match:datesMatch,positions_and_values_match:equal,delta_final_verified:report.delta_final_verified,d1_reference_date:d1.reference_date,postgres_effective_as_of:postgres.effective_as_of,d1_position_count:comparison.d1_position_count,postgres_position_count:comparison.postgres_position_count,matched_position_count:comparison.matched_position_count,counts:comparison.counts,net_value_difference_cents:comparison.net_value_difference_cents,content_sha256:comparison.content_sha256}));
