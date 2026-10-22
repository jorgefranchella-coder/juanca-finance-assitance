"use client";

import {useCallback,useEffect,useState} from "react";

type Snapshot={document_id:string;owner:string;source_system:string;original_name:string;content_sha256:string;effective_as_of:string;rows:number;invalid_rows:number;published:boolean};
type Data={snapshots:Snapshot[]};
const sourceName=(source:string)=>source==='Avenue'?'Avenue':'Previdência';

export default function ExternalSnapshotPublicationPanel(){
 const [data,setData]=useState<Data|null>(null),[loading,setLoading]=useState(true),[saving,setSaving]=useState(""),[error,setError]=useState("");
 const load=useCallback(async()=>{const response=await fetch("/api/shadow/reconciliation/external/snapshots",{cache:"no-store"});if(!response.ok)throw new Error("No se pudieron consultar los snapshots externos en PostgreSQL.");setData(await response.json() as Data);},[]);
 useEffect(()=>{let active=true;load().catch(e=>{if(active)setError(e instanceof Error?e.message:"Error al consultar snapshots externos.");}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[load]);
 const publish=async(snapshot:Snapshot)=>{
  if(!window.confirm(`Vas a reemplazar en la cartera sombra las posiciones de ${snapshot.owner} del extracto ${sourceName(snapshot.source_system)} con fecha ${snapshot.effective_as_of}. No se aplicarán movimientos ni se registrará caja. ¿Publicar?`))return;
  setSaving(snapshot.document_id);setError("");
  try{const request_key=Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,"0")).join("");
   const response=await fetch(`/api/shadow/reconciliation/external/snapshots/${encodeURIComponent(snapshot.document_id)}/publish`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({request_key,content_sha256:snapshot.content_sha256})});
   const result=await response.json() as {code?:string};if(!response.ok){const messages:Record<string,string>={CUSTODY_ACCOUNT_UNRESOLVED:"La cuenta de custodia no está identificada en este extracto.",PENSION_PROVIDER_UNRESOLVED:"No se pudo verificar la entidad de previdencia.",POSITION_MARKET_VALUE_MISSING:"Hay una posición sin valor de mercado.",POSITION_REFERENCE_DATE_MISMATCH:"La fecha de una fila no coincide con la del extracto.",HISTORICAL_SNAPSHOT_REQUIRES_CORRECTION_FLOW:"Este extracto es anterior al corte actual y requiere una corrección histórica.",POST_SNAPSHOT_APPLIED_EVENT_PRESENT:"Hay operaciones aprobadas posteriores a este corte; usa un extracto más reciente.",SNAPSHOT_ALREADY_PUBLISHED:"Este extracto ya fue publicado."};throw new Error(messages[result.code??""]??"No se pudo publicar el snapshot; revisa las identidades y los valores del extracto.");}
   await load();window.dispatchEvent(new Event("shadow-portfolio-updated"));
  }catch(e){setError(e instanceof Error?e.message:"No se pudo publicar el snapshot.");}finally{setSaving("");}
 };
 return <section className="panel" aria-live="polite"><div className="panel-title"><div><p>AVENUE Y PREVIDENCIA · POSTGRESQL</p><h2>Snapshots externos</h2><span>Publicar requiere confirmación explícita. Los movimientos siguen como evidencia y la caja queda fuera.</span></div><button type="button" className="text-button" onClick={()=>{setLoading(true);setError("");load().catch(e=>setError(e instanceof Error?e.message:"Error al consultar.")).finally(()=>setLoading(false));}} disabled={loading}>Actualizar</button></div>
  {loading?<p>Consultando snapshots externos…</p>:error&&<p className="chat-error" role="alert">{error}</p>}
  {!loading&&data?.snapshots.length===0&&<p>No hay snapshots de Avenue o previdencia en PostgreSQL.</p>}
  {!loading&&data?.snapshots.map(snapshot=><div className="review-card" key={snapshot.document_id}><strong>{snapshot.owner} · {sourceName(snapshot.source_system)} · {snapshot.effective_as_of} · {snapshot.original_name}</strong><span>{snapshot.rows} posiciones · {snapshot.invalid_rows} filas incompletas</span>
   {snapshot.published?<span className="review-badge">Publicado en sombra</span>:<button type="button" disabled={!!saving||snapshot.rows===0||snapshot.invalid_rows>0} onClick={()=>void publish(snapshot)}>{saving===snapshot.document_id?"Publicando…":"Revisar y publicar snapshot"}</button>}
  </div>)}
 </section>;
}
