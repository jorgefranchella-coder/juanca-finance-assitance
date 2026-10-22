"use client";

import { useCallback, useEffect, useState } from "react";

type Position={owner:string;instrument_code:string;currency?:string;quantity:string|number;market_value_cents:string|number|null};
type Portfolio={positions:Position[];total_value_cents:string|number;reference_date?:string;portfolio_version?:string;valuation_complete?:boolean};
type Comparison={legacyTotal:string;shadowTotal:string;totalDiff:string;positionCountD1:number;positionCountPg:number;keyDiff:number;quantityDiff:number;valueDiff:number;unmatched:Array<{key:string;d1?:Position;pg?:Position}>};
const money=new Intl.NumberFormat("pt-BR",{style:"currency",currency:"BRL"});
function cents(value:string|number|null){if(value===null)return 0;const n=Number(value);return Number.isFinite(n)?Math.round(n):0;}
function grouped(rows:Position[]){const result=new Map<string,Position>();for(const p of rows){const key=JSON.stringify([p.owner,p.instrument_code.trim().toUpperCase(),p.currency??"BRL"]),old=result.get(key);result.set(key,old?{...old,quantity:Number(old.quantity)+Number(p.quantity),market_value_cents:cents(old.market_value_cents)+cents(p.market_value_cents)}:p);}return result;}

export default function ShadowPortfolioPanel(){
 const [comparison,setComparison]=useState<Comparison|null>(null);const [error,setError]=useState("");const [loading,setLoading]=useState(true);
 const load=useCallback(async()=>{setLoading(true);setError("");try{
  const responses=await Promise.all([fetch("/api/portfolio/positions",{cache:"no-store"}),fetch("/api/shadow/portfolio",{cache:"no-store"}),fetch("/api/shadow/positions?limit=200",{cache:"no-store"})]);
  if(responses.some(r=>!r.ok))throw new Error("No se pudieron leer ambas carteras para comparar.");
  const [legacy,portfolio,positions]=await Promise.all(responses.map(r=>r.json())) as [{positions:Position[];total_value_cents?:string|number},Portfolio,{positions:Position[];portfolio_version?:string}];
  if(portfolio.portfolio_version&&positions.portfolio_version&&portfolio.portfolio_version!==positions.portfolio_version)throw new Error("La versión de PostgreSQL cambió durante la comparación. Vuelve a cargar.");
  const legacyInvested=(legacy.positions??[]).filter(p=>p.instrument_code!=='USD_CASH'),shadowInvested=(positions.positions??[]).filter(p=>p.instrument_code!=='USD_CASH');
  const left=grouped(legacyInvested),right=grouped(shadowInvested),keys=new Set([...left.keys(),...right.keys()]);let keyDiff=0,quantityDiff=0,valueDiff=0;const unmatched=[];
  for(const key of keys){const d=left.get(key),p=right.get(key);if(!d||!p){keyDiff++;unmatched.push({key,d1:d,pg:p});continue;}if(Math.abs(Number(d.quantity)-Number(p.quantity))>1e-8)quantityDiff++;if(cents(d.market_value_cents)!==cents(p.market_value_cents))valueDiff++;}
  const legacyTotal=String(legacyInvested.reduce((sum,p)=>sum+cents(p.market_value_cents),0)),shadowTotal=String(portfolio.total_value_cents),totalDiff=(BigInt(Math.round(Number(shadowTotal)))-BigInt(Math.round(Number(legacyTotal)))).toString();
  setComparison({legacyTotal,shadowTotal,totalDiff,positionCountD1:legacyInvested.length,positionCountPg:shadowInvested.length,keyDiff,quantityDiff,valueDiff,unmatched:unmatched.slice(0,8)});
 }catch(e){setError(e instanceof Error?e.message:"No se pudo comparar la cartera.");}finally{setLoading(false);}},[]);
 useEffect(()=>{const timer=window.setTimeout(()=>void load(),0);return()=>window.clearTimeout(timer);},[load]);
 return <section className="panel"><div className="panel-title"><div><p>PostgreSQL · sombra</p><h2>Comparación de cartera invertida</h2><span>Compara posiciones agregadas por titular, instrumento y moneda; excluye caja y no fusiona cuentas en el registro patrimonial.</span></div><span className="review-badge">solo lectura</span></div>
  {loading?<p>Comparando D1 con PostgreSQL…</p>:error?<p className="chat-error" role="alert">{error}</p>:comparison&&<div className="table-wrap"><table><thead><tr><th>Control</th><th>D1/R2</th><th>PostgreSQL</th><th>Diferencias</th></tr></thead><tbody>
   <tr><td>Posiciones</td><td>{comparison.positionCountD1}</td><td>{comparison.positionCountPg}</td><td>{comparison.keyDiff} instrumentos · {comparison.quantityDiff} cantidades · {comparison.valueDiff} valores</td></tr>
   <tr><td>Valor invertido</td><td>{money.format(Number(comparison.legacyTotal)/100)}</td><td>{money.format(Number(comparison.shadowTotal)/100)}</td><td>{comparison.totalDiff==="0"?"Coincide":money.format(Number(comparison.totalDiff)/100)}</td></tr>
  </tbody></table>{comparison.unmatched.length>0&&<details><summary>Instrumentos presentes en una sola fuente ({comparison.keyDiff})</summary><ul>{comparison.unmatched.map((x,i)=><li key={i}>{x.key} · {x.d1?"D1":"PostgreSQL"}</li>)}</ul></details>}</div>}
 </section>;
}
