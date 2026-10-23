"use client";

import { useState } from "react";

type Quote={market_code:string;symbol:string;currency:string;price:string;provider:string;observed_at:string};
type Job={id:string;status:string;attempts:number;result?:{quotes?:Quote[];fx?:Array<{pair:string;rate:string;observed_at:string}>;failures?:string[]};last_error?:string|null};
const b3Pattern=/^[A-Z]{4}\d{1,2}[A-Z]?$/;
const usPattern=/^[A-Z.]{1,10}$/;
const parseSymbols=(value:string,pattern:RegExp)=>[...new Set(value.split(/[\s,;]+/).map(x=>x.trim().toUpperCase()).filter(Boolean))].filter(x=>pattern.test(x));
const date=(value?:string)=>value?new Date(value).toLocaleString("pt-BR"):"—";

export default function ShadowMarketPanel(){
 const [b3,setB3]=useState("");const [us,setUs]=useState("");const [busy,setBusy]=useState(false);const [job,setJob]=useState<Job|null>(null);const [error,setError]=useState("");const [quotes,setQuotes]=useState<Quote[]>([]);const [fx,setFx]=useState<{rate:string;observed_at:string}|null>(null);
 async function loadObservations(b3Symbols:string[],usSymbols:string[]){
  const requests=[...(b3Symbols.length?[fetch(`/api/shadow/market/quotes?market=B3&symbols=${encodeURIComponent(b3Symbols.join(","))}`,{cache:"no-store"})]:[]),...(usSymbols.length?[fetch(`/api/shadow/market/quotes?market=US&symbols=${encodeURIComponent(usSymbols.join(","))}`,{cache:"no-store"})]:[]),fetch("/api/shadow/market/fx/USD-BRL",{cache:"no-store"})];
  const responses=await Promise.all(requests);if(responses.some(r=>!r.ok))throw new Error("No se pudieron leer las observaciones de mercado sombra.");const data=await Promise.all(responses.map(r=>r.json())) as Array<{quotes?:Quote[];observation?:{rate:string;observed_at:string}|null}>;setQuotes(data.flatMap(x=>x.quotes??[]));setFx(data.at(-1)?.observation??null);
 }
 async function refresh(){
  const b3Symbols=parseSymbols(b3,b3Pattern),usSymbols=parseSymbols(us,usPattern);if(!b3Symbols.length&&!usSymbols.length){setError("Escribe al menos un ticker válido (por ejemplo ITUB4 o AAPL).");return;}
  setBusy(true);setError("");setJob(null);try{
   const response=await fetch("/api/shadow/market/refresh",{method:"POST",headers:{"Content-Type":"application/json","X-Juanca-Request":"1","Idempotency-Key":`market-${crypto.randomUUID()}`},body:JSON.stringify({b3_symbols:b3Symbols,us_symbols:usSymbols,include_fx:true})});
   const first=await response.json() as Job&{code?:string};if(!response.ok)throw new Error(first.code??"No se pudo solicitar la actualización de mercado.");let current=first;setJob(current);
   for(let attempt=0;attempt<40&&!(["succeeded","partial","failed"].includes(current.status));attempt++){await new Promise(resolve=>window.setTimeout(resolve,1500));const poll=await fetch(`/api/shadow/market/jobs/${encodeURIComponent(current.id)}`,{cache:"no-store"});if(!poll.ok)throw new Error("No se pudo consultar el trabajo de actualización.");current=await poll.json() as Job;setJob(current);}
   await loadObservations(b3Symbols,usSymbols);
  }catch(e){setError(e instanceof Error?e.message:"Falló la actualización de mercado.");}finally{setBusy(false);}
 }
 return <section className="panel shadow-market" aria-live="polite"><div className="panel-title"><div><p>PostgreSQL · sombra</p><h2>Cotizaciones de mercado</h2><span>Observaciones independientes del valor oficial D1/R2. El refresco solo guarda precios y FX en la base sombra.</span></div><span className="review-badge">sin impacto oficial</span></div>
  <div className="shadow-market-form"><label>Ticker B3<input value={b3} onChange={e=>setB3(e.target.value)} placeholder="ITUB4, BBDC4" aria-label="Tickers de B3" /></label><label>Ticker EE. UU.<input value={us} onChange={e=>setUs(e.target.value)} placeholder="AAPL, MSFT" aria-label="Tickers de Estados Unidos" /></label><button type="button" onClick={()=>void refresh()} disabled={busy}>{busy?"Actualizando…":"Actualizar precios sombra"}</button></div>
  <p className="shadow-market-note">Los tickers se envían a proveedores de mercado para obtener cotizaciones; la consulta no se ejecuta automáticamente.</p>
  {error&&<p className="chat-error" role="alert">{error}</p>}{job&&<p className="shadow-market-job">Trabajo {job.id} · {job.status} · intentos {job.attempts}{job.last_error?` · ${job.last_error}`:""}</p>}
  {quotes.length>0&&<div className="table-wrap"><table><thead><tr><th>Mercado</th><th>Ticker</th><th>Precio</th><th>Proveedor</th><th>Observado</th></tr></thead><tbody>{quotes.map((q,i)=><tr key={`${q.market_code}-${q.symbol}-${i}`}><td>{q.market_code}</td><td>{q.symbol}</td><td>{q.currency} {q.price}</td><td>{q.provider}</td><td>{date(q.observed_at)}</td></tr>)}</tbody></table></div>}
  {fx&&<p className="shadow-market-job">USD/BRL: {fx.rate} · {date(fx.observed_at)}</p>}
 </section>;
}
