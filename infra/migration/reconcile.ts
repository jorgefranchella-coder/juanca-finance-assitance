import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {pool} from '../../services/application/src/db.ts';
import {publish,hash,type Envelope} from '../../services/application/src/migration.ts';
import {selectInputs} from '../../services/application/src/portfolio.ts';
const [envelopePath,legacyModule,reportPath]=process.argv.slice(2);
if(!reportPath)throw new Error('Usage: reconcile.ts private-envelope legacy-pure-module private-report');
const envelope=JSON.parse(await readFile(envelopePath,'utf8')) as Envelope;const db=pool();
try{
 const h=String(envelope.content.tables.imports[0].user_id);const inputs=selectInputs(envelope.content.tables,h,envelope.exported_at.slice(0,10),envelope.exported_at);
 const legacy=await import(pathToFileURL(legacyModule).href);
 const fx=inputs.fx?{rate:Number(inputs.fx.rate),date:inputs.fx.quoted_at,provider:inputs.fx.provider}:null;
 const old=legacy.buildPortfolioView(inputs.snapshots,inputs.trades,inputs.quotes,fx);
 const result=await publish(db,envelope.source_sha256,h,envelope.exported_at.slice(0,10),envelope.exported_at);
 const current=result.view;
 const key=(p:{owner:string;instrument_code:string;currency:string})=>JSON.stringify([p.owner,p.instrument_code,p.currency]);
 const isCash=(p:Record<string,unknown>)=>String(p.asset_class??'').toLowerCase()==='cash'||String(p.instrument_code??'').toUpperCase().endsWith('_CASH');
 const previousPositions=(old.positions as Record<string,unknown>[]).filter(p=>!isCash(p)),currentPositions=current.positions.filter(p=>!isCash(p as unknown as Record<string,unknown>));
 const previous=new Map<string,Record<string,unknown>>(previousPositions.map(p=>[key(p as never),p]));
 const diffs:Record<string,unknown>[]=[];
 for(const p of currentPositions){const k=key(p);const original=previous.get(k);if(!original){diffs.push({identity_hash:hash(k),reason:'position_missing_legacy',current:p});continue;}
  for(const field of ['quantity','market_value_cents','market_value_minor'])if(String(original[field])!==String(p[field as keyof typeof p]))diffs.push({identity_hash:hash(k),field,previous:original[field],current:p[field as keyof typeof p],reason:field==='quantity'?'account_or_coverage_policy':'exact_decimal_or_account_policy'});
  previous.delete(k);
 }
 for(const [k,p] of previous)diffs.push({identity_hash:hash(k),reason:'position_missing_shadow',previous:p});
 const investedTotal=(positions:Record<string,unknown>[])=>positions.some(p=>p.market_value_cents===null||p.market_value_cents===undefined)?null:positions.reduce((sum,p)=>sum+BigInt(String(p.market_value_cents)),0n).toString();
 const previousTotal=investedTotal(previousPositions),currentTotal=investedTotal(currentPositions),totalMatch=previousTotal!==null&&currentTotal!==null&&previousTotal===currentTotal;
 const report={source_sha256:envelope.source_sha256,portfolio_version:result.portfolio_version,previous_count:previousPositions.length,current_count:currentPositions.length,excluded_cash_previous:old.positions.length-previousPositions.length,excluded_cash_current:current.positions.length-currentPositions.length,quantities_match:!diffs.some(d=>d.field==='quantity'||String(d.reason).startsWith('position_missing')),values_match:diffs.length===0,previous_invested_total_cents:previousTotal,current_invested_total_cents:currentTotal,total_match:totalMatch,old_issues:old.issues,new_issues:current.issues,identity_complete:current.identity_complete,differences:diffs};
 await writeFile(reportPath,JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify({previous_count:report.previous_count,current_count:report.current_count,quantities_match:report.quantities_match,values_match:report.values_match,total_match:report.total_match,differences:diffs.length,new_issue_codes:[...new Set(current.issues.map(i=>i.code))]}));
}finally{await db.end();}
