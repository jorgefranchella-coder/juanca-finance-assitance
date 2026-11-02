"use client";

import {useCallback,useEffect,useRef,useState} from "react";

type Snapshot={document_id:string;owner:string;source_system:string;original_name:string;content_sha256:string;effective_as_of:string;rows:number;invalid_rows:number;published:boolean;latest:boolean;position_details?:{assertion_id:string;identity_decision_id:string|null;identity_decision_revision:number|null;identity_status:string|null;identity_review_reasons?:string[];plan_number:string|null;product_name:string|null;fund:string|null;fund_cnpj:string|null;plans?:{plan_number:string;gross_balance:string;net_balance:string}[]}[]};
type Data={snapshots:Snapshot[];portfolio_effective_as_of:string|null};
const sourceName=(source:string)=>source==='Avenue'?'Avenue':`Previdência · ${source}`;

export default function ExternalSnapshotPublicationPanel(){
 const [data,setData]=useState<Data|null>(null),[loading,setLoading]=useState(true),[saving,setSaving]=useState(""),[error,setError]=useState("");
 const [editing,setEditing]=useState(''),[plan,setPlan]=useState(''),[fund,setFund]=useState(''),[cnpj,setCnpj]=useState(''),[locator,setLocator]=useState('');
 const pending=useRef<{body:string;key:string}|null>(null);
 const load=useCallback(async()=>{const response=await fetch("/api/shadow/reconciliation/external/snapshots",{cache:"no-store"});if(!response.ok)throw new Error("No se pudieron consultar los snapshots externos en PostgreSQL.");setData(await response.json() as Data);},[]);
 useEffect(()=>{let active=true;load().catch(e=>{if(active)setError(e instanceof Error?e.message:"Error al consultar snapshots externos.");}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[load]);
 const decide=async(assertionId:string)=>{
  if(!plan.trim()||!fund.trim()||!cnpj.trim()||!locator.trim()){setError('Completa plan, fondo, CNPJ y ubicación de la evidencia.');return;}
  setSaving(assertionId);setError('');try{
   const payload={assertion_id:assertionId,plan_number:plan.trim(),fund_name:fund.trim(),fund_cnpj:cnpj.trim(),source_locator:locator.trim()};
   const fingerprint=JSON.stringify(payload);if(pending.current?.body!==fingerprint)pending.current={body:fingerprint,key:`pension_${crypto.randomUUID().replaceAll('-','')}`};
   const response=await fetch('/api/shadow/reconciliation/pension/identities/decisions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...payload,request_key:pending.current.key})});const result=await response.json() as {code?:string};if(!response.ok)throw new Error(result.code==='PENSION_AGGREGATED_PLANS_REQUIRES_SPLIT'?'Esta posición reúne varios planes y debe separarse con nueva evidencia.':'No se pudo guardar la identidad para revisión.');
   pending.current=null;setEditing('');await load();
  }catch(e){setError(e instanceof Error?e.message:'No se pudo guardar la identidad.');}finally{setSaving('');}
 };
 const publish=async(snapshot:Snapshot)=>{
  if(!window.confirm(`Vas a reemplazar en la cartera sombra las posiciones de ${snapshot.owner} del extracto ${sourceName(snapshot.source_system)} con fecha ${snapshot.effective_as_of}. La cartera se reconstruirá al ${data?.portfolio_effective_as_of??snapshot.effective_as_of}, conservando la fecha real del extracto. No se aplicarán movimientos ni se registrará caja. ¿Publicar?`))return;
  setSaving(snapshot.document_id);setError("");
  try{const request_key=Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,"0")).join("");
   const response=await fetch(`/api/shadow/reconciliation/external/snapshots/${encodeURIComponent(snapshot.document_id)}/publish`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({request_key,content_sha256:snapshot.content_sha256})});
   const result=await response.json() as {code?:string};if(!response.ok){const messages:Record<string,string>={CUSTODY_ACCOUNT_UNRESOLVED:"La cuenta de custodia no está identificada en este extracto.",PENSION_PROVIDER_UNRESOLVED:"No se pudo verificar la entidad de previdencia.",PENSION_IDENTITY_REVIEW_REQUIRED:"Confirma el plan y el fondo con su evidencia antes de publicar.",PENSION_LEGACY_POSITION_REVIEW_REQUIRED:"Existe una posición anterior agrupada por fondo. Debe conciliarse para evitar duplicar el patrimonio.",PENSION_AGGREGATED_PLANS_REQUIRES_SPLIT:"La evidencia reúne varios planes y debe separarse antes de publicar.",POSITION_MARKET_VALUE_MISSING:"Hay una posición sin valor de mercado.",POSITION_REFERENCE_DATE_MISMATCH:"La fecha de una fila no coincide con la del extracto.",HISTORICAL_SNAPSHOT_REQUIRES_CORRECTION_FLOW:"Este extracto ya fue superado por una publicación posterior y requiere una corrección histórica.",POST_SNAPSHOT_APPLIED_EVENT_PRESENT:"Hay operaciones aprobadas posteriores a este corte; usa un extracto más reciente.",SNAPSHOT_ALREADY_PUBLISHED:"Este extracto ya fue publicado."};throw new Error(messages[result.code??""]??"No se pudo publicar el snapshot; revisa las identidades y los valores del extracto.");}
   await load();window.dispatchEvent(new Event("shadow-portfolio-updated"));
  }catch(e){setError(e instanceof Error?e.message:"No se pudo publicar el snapshot.");}finally{setSaving("");}
 };
 return <section className="panel" aria-live="polite"><div className="panel-title"><div><p>AVENUE Y PREVIDENCIA · POSTGRESQL</p><h2>Snapshots externos</h2><span>Publicar requiere confirmación explícita. Los movimientos siguen como evidencia y la caja queda fuera.</span></div><button type="button" className="text-button" onClick={()=>{setLoading(true);setError("");load().catch(e=>setError(e instanceof Error?e.message:"Error al consultar.")).finally(()=>setLoading(false));}} disabled={loading}>Actualizar</button></div>
  {loading?<p>Consultando snapshots externos…</p>:error&&<p className="chat-error" role="alert">{error}</p>}
  {!loading&&data?.snapshots.length===0&&<p>No hay snapshots de Avenue o previdencia en PostgreSQL.</p>}
  {!loading&&data?.snapshots.map(snapshot=><div className="review-card" key={snapshot.document_id}><strong>{snapshot.owner} · {sourceName(snapshot.source_system)} · {snapshot.effective_as_of} · {snapshot.original_name}</strong><span>{snapshot.rows} posiciones · {snapshot.invalid_rows} filas incompletas{data.portfolio_effective_as_of&&snapshot.effective_as_of!==data.portfolio_effective_as_of?` · la cartera se conservará al ${data.portfolio_effective_as_of}`:""}</span>
   {snapshot.position_details?.flatMap(position=>position.plans??[]).map(plan=><span key={`${snapshot.document_id}:${plan.plan_number}`}>Plan {plan.plan_number} · bruto {money.format(Number(plan.gross_balance))} · líquido {money.format(Number(plan.net_balance))}</span>)}
   {snapshot.source_system!=='Avenue'&&snapshot.position_details?.map(position=><div key={position.assertion_id}>
    <span>Plan: {position.plan_number||'sin identificar'} · Fondo: {position.fund||'sin identificar'} · CNPJ: {position.fund_cnpj||'sin identificar'}{position.identity_decision_revision?` · revisión ${position.identity_decision_revision}`:''}</span>
    {!snapshot.published&&(position.plans?.length??0)>1?<small>Esta fila reúne varios planes; requiere una nueva evidencia separada por plan.</small>:!snapshot.published&&<button type="button" onClick={()=>{setEditing(position.assertion_id);setPlan(position.plan_number??'');setFund(position.fund??'');setCnpj(position.fund_cnpj??'');setLocator('');setError('');}}>Confirmar o corregir identidad</button>}
    {editing===position.assertion_id&&<div><p>La decisión conserva el original y no publica ni modifica el patrimonio.</p><label>Número de plan<input value={plan} onChange={e=>setPlan(e.target.value)} /></label><label>Fondo<input value={fund} onChange={e=>setFund(e.target.value)} /></label><label>CNPJ del fondo<input value={cnpj} onChange={e=>setCnpj(e.target.value)} /></label><label>Ubicación de la evidencia (página o sección)<input value={locator} onChange={e=>setLocator(e.target.value)} /></label><button type="button" disabled={!!saving} onClick={()=>void decide(position.assertion_id)}>Guardar decisión</button><button type="button" onClick={()=>setEditing('')}>Cancelar</button></div>}
   </div>)}
   {snapshot.published?<span className="review-badge">Publicado en sombra</span>:!snapshot.latest?<span>Reemplazado por un extracto más reciente de esta fuente; requiere corrección histórica.</span>:<button type="button" disabled={!!saving||snapshot.rows===0||snapshot.invalid_rows>0} onClick={()=>void publish(snapshot)}>{saving===snapshot.document_id?"Publicando…":"Aprobar y publicar snapshot"}</button>}
  </div>)}
 </section>;
}
