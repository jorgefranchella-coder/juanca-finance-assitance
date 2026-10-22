"use client";

import {useCallback,useEffect,useState} from "react";

type Snapshot={document_id:string;owner:string;original_name:string;content_sha256:string;effective_as_of:string;rows:number;invalid_rows:number;account_pending:number;published:boolean};
type Data={snapshots:Snapshot[]};
const label=(s:Snapshot)=>`${s.owner} · ${s.effective_as_of} · ${s.original_name}`;

export default function B3SnapshotPublicationPanel(){
 const [data,setData]=useState<Data|null>(null),[loading,setLoading]=useState(true),[saving,setSaving]=useState(""),[error,setError]=useState("");
 const load=useCallback(async()=>{const response=await fetch("/api/shadow/reconciliation/b3/snapshots",{cache:"no-store"});if(!response.ok)throw new Error("No se pudieron consultar los snapshots B3 en PostgreSQL.");const value=await response.json() as Data;setData(value);},[]);
 useEffect(()=>{let active=true;load().catch(e=>{if(active)setError(e instanceof Error?e.message:"Error al consultar snapshots B3.");}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[load]);
 const publish=async(snapshot:Snapshot)=>{
  if(!window.confirm(`Vas a reemplazar las posiciones B3 de ${snapshot.owner} para las instituciones incluidas en este archivo, con fecha ${snapshot.effective_as_of}. Los movimientos seguirán como evidencia sin aplicar. ¿Publicar en la cartera sombra de PostgreSQL?`))return;
  setSaving(snapshot.document_id);setError("");
  try{const bytes=crypto.getRandomValues(new Uint8Array(16)),request_key=Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("");
   const response=await fetch(`/api/shadow/reconciliation/b3/snapshots/${encodeURIComponent(snapshot.document_id)}/publish`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({request_key,content_sha256:snapshot.content_sha256})});
   const result=await response.json() as {code?:string};if(!response.ok){const message:Record<string,string>={CUSTODY_ACCOUNT_UNRESOLVED:"Hay cuentas de custodia sin identidad confirmada para este snapshot.",CUSTODY_ACCOUNT_REFERENCE_MISMATCH:"La referencia de cuenta del archivo no coincide con la cuenta identificada.",POSITION_IDENTITY_OR_QUANTITY_INVALID:"Hay posiciones sin instrumento o cantidad válida.",POSITION_REFERENCE_DATE_MISMATCH:"La fecha de una fila no coincide con la fecha de referencia del archivo.",POSITION_MARKET_VALUE_MISSING:"Hay posiciones sin valor de mercado en el archivo.",DUPLICATE_ACCOUNT_INSTRUMENT:"El archivo repite un instrumento dentro de la misma cuenta.",STALE_SNAPSHOT:"El archivo cambió desde que se cargó; vuelve a actualizar.",HISTORICAL_SNAPSHOT_REQUIRES_CORRECTION_FLOW:"La fecha es anterior a la cartera actual y requiere el flujo de corrección histórica.",POST_SNAPSHOT_APPLIED_EVENT_PRESENT:"Hay operaciones aprobadas posteriores a este corte; publica un snapshot más reciente.",SNAPSHOT_ALREADY_PUBLISHED:"Este snapshot ya fue publicado.",PUBLISHED_BASELINE_REQUIRED:"Falta publicar primero una cartera base en PostgreSQL."};throw new Error(message[result.code??""]??"No se pudo publicar el snapshot. Revisa la identidad de cuentas y posiciones.");}
   await load();window.dispatchEvent(new Event("shadow-portfolio-updated"));
  }catch(e){setError(e instanceof Error?e.message:"No se pudo publicar el snapshot.");}finally{setSaving("");}
 };
 return <section className="panel" aria-live="polite"><div className="panel-title"><div><p>B3 · POSTGRESQL</p><h2>Snapshots de posiciones</h2><span>Publicar requiere confirmación explícita de un approver. No aplica movimientos ni registra caja.</span></div><button type="button" className="text-button" onClick={()=>{setLoading(true);setError("");load().catch(e=>setError(e instanceof Error?e.message:"Error al consultar." )).finally(()=>setLoading(false));}} disabled={loading}>Actualizar</button></div>
  {loading?<p>Consultando snapshots B3…</p>:error&&<p className="chat-error" role="alert">{error}</p>}
  {!loading&&data?.snapshots.length===0&&<p>No hay snapshots B3 en PostgreSQL.</p>}
  {!loading&&data?.snapshots.map(snapshot=><div className="review-card" key={snapshot.document_id}><strong>{label(snapshot)}</strong><span>{snapshot.rows} filas · {snapshot.account_pending} sin cuenta observada · {snapshot.invalid_rows} filas inválidas</span>
   {snapshot.published?<span className="review-badge">Publicado en sombra</span>:<button type="button" disabled={!!saving||snapshot.rows===0||snapshot.invalid_rows>0} onClick={()=>void publish(snapshot)}>{saving===snapshot.document_id?"Publicando…":"Revisar y publicar snapshot"}</button>}
  </div>)}
 </section>;
}
