import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {pool} from '../../services/application/src/db.ts';
import {fixedIncomeProjection} from '../../services/application/src/fixed-income.ts';

const source=process.argv.find(x=>x.startsWith('--source='))?.slice(9);
if(!source)throw new Error('Usage: node --experimental-strip-types infra/migration/preview_cost_basis.ts --source=/private/path/to/d1.sqlite');
const exported=spawnSync('python3',[new URL('./export_cost_basis.py',import.meta.url).pathname,source],{encoding:'utf8',maxBuffer:8*1024*1024});
if(exported.status!==0)throw new Error('COST_BASIS_EXPORT_FAILED');
const envelope=JSON.parse(exported.stdout) as {sha256:string;payload:{format:string;rows:Array<Record<string,unknown>>}};
if(envelope.payload.format!=='juanca-cost-basis-v1'||!/^[0-9a-f]{64}$/.test(envelope.sha256))throw new Error('INVALID_COST_BASIS_EXPORT');
const config=JSON.parse(await readFile(process.env.JUANCA_SHADOW_CONFIG??'/home/jorge/.local/share/juanca-shadow/application.json','utf8')) as {household_id:string};
const db=pool();
try{
 const projection=await fixedIncomeProjection(db,config.household_id);
 const identityRows=await db.query(`SELECT o.display_name AS owner,p.instrument_code,p.currency,
   count(DISTINCT COALESCE(r.custody_account_id,p.custody_account_id)) FILTER (WHERE COALESCE(r.custody_account_id,p.custody_account_id) IS NOT NULL)::int AS resolved_accounts
   FROM app.position_identities p JOIN app.owners o ON o.household_id=p.household_id AND o.id=p.owner_id
   LEFT JOIN LATERAL (SELECT custody_account_id FROM app.position_identity_resolutions x WHERE x.household_id=p.household_id AND x.position_id=p.id ORDER BY revision DESC LIMIT 1) r ON true
   WHERE p.household_id=$1 GROUP BY o.display_name,p.instrument_code,p.currency`,[config.household_id]);
 const key=(owner:unknown,instrument:unknown,currency:unknown)=>JSON.stringify([String(owner??''),String(instrument??'').trim().toUpperCase().replace(/^(BVMF|NASDAQ|NYSE|NYSEARCA):/,''),String(currency??'BRL')]);
 const positions=new Map<string,typeof projection.items>();
 for(const item of projection.items){const k=key(item.owner,item.instrument_code,item.currency);positions.set(k,[...(positions.get(k)??[]),item]);}
 const accountCounts=new Map(identityRows.rows.map((row:any)=>[key(row.owner,row.instrument_code,row.currency),Number(row.resolved_accounts)]));
 const counts={total:envelope.payload.rows.length,eligible:0,unmatched:0,ambiguous:0,account_unresolved:0,quantity_mismatch:0,date_invalid:0,not_sheet_source:0};
 for(const row of envelope.payload.rows){
  if(!String(row.source??'').startsWith('google_sheet:')){counts.not_sheet_source++;continue;}
  const matches=positions.get(key(row.owner,row.instrument_code,row.currency))??[];
  if(!matches.length){counts.unmatched++;continue;}
  if(matches.length!==1){counts.ambiguous++;continue;}
  const item=matches[0];
  if(!item.account&&accountCounts.get(key(row.owner,row.instrument_code,row.currency))!==1){counts.account_unresolved++;continue;}
  const qty=Number(row.quantity),current=Number(item.quantity),tolerance=Math.max(0.000001,Math.abs(current)*1e-8);
  if(!Number.isFinite(qty)||Math.abs(qty-current)>tolerance){counts.quantity_mismatch++;continue;}
  const date=String(row.as_of??'');if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||date>=item.reference_date){counts.date_invalid++;continue;}
  counts.eligible++;
 }
 console.log(JSON.stringify({mode:'read_only_preflight',sha256:envelope.sha256,...counts,shadow_projection_positions:projection.items.length,shadow_projection_reference_date:projection.reference_date}));
}finally{await db.end();}
