"use client";

import { useCallback, useEffect, useState } from "react";

type Candidate={assertion_id:string;date:string;source_event_type:string|null;event_type:string|null;direction:string|null;quantity:string;custodian:string|null;date_distance_days:number;review:{decision:"related"|"not_related";revision:number;decided_at:string}|null};
type Match={intake_id:string;owner:string;original_text:string;trade_date:string;instrument_code:string;side:string;quantity:string;match_status:"single_candidate"|"multiple_candidates";candidate_count:number;candidates:Candidate[];decision:"human_review_required";portfolio_changed:false};

export default function ManualB3Candidates(){
 const [matches,setMatches]=useState<Match[]>([]);const[loading,setLoading]=useState(true);const[error,setError]=useState("");const[saving,setSaving]=useState("");
 const load=useCallback(async()=>{const response=await fetch("/api/shadow/reconciliation/manual-b3/candidates",{cache:"no-store"});if(!response.ok)throw new Error("No fue posible consultar las sugerencias escritas ↔ B3.");const result=await response.json() as {candidates:Match[]};return result.candidates??[];},[]);
 useEffect(()=>{let active=true;load().then(value=>{if(active)setMatches(value);}).catch(problem=>{if(active)setError(problem instanceof Error?problem.message:"Error de consulta.");}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[load]);
 const refresh=async()=>{setLoading(true);setError("");try{setMatches(await load());}catch(problem){setError(problem instanceof Error?problem.message:"Error de consulta.");}finally{setLoading(false);}};
 async function decide(match:Match,candidate:Candidate,decision:"related"|"not_related"){
  setSaving(candidate.assertion_id);setError("");
  try{const bytes=crypto.getRandomValues(new Uint8Array(16));const request_key=Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("");const response=await fetch("/api/shadow/reconciliation/manual-b3/decisions",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({request_key,intake_id:match.intake_id,assertion_id:candidate.assertion_id,decision})});const result=await response.json() as {code?:string};if(!response.ok)throw new Error(result.code==="STALE_CANDIDATE"?"La sugerencia cambió; actualiza la bandeja antes de decidir.":"No se pudo guardar la decisión auditada.");await refresh();}catch(problem){setError(problem instanceof Error?problem.message:"No se pudo guardar la decisión.");}finally{setSaving("");}
 }
 return <article className="panel manual-b3-panel" aria-live="polite">
  <div className="panel-title"><div><p>Conciliación · sombra</p><h2>Coincidencias escritas ↔ B3</h2></div><span className="safe-badge">sugerencias · no aplica</span></div>
  <p className="review-note">Coincidencia exacta de titular, activo y cantidad dentro de siete días. El tipo y crédito/débito B3 se muestran como evidencia; no determinan por sí solos compra o venta. Negociación, liquidación y transferencia pueden ser etapas de una sola operación.</p>
  {loading&&<p>Buscando coincidencias…</p>}{!loading&&error&&<div className="inline-error" role="alert">{error} <button type="button" className="text-button" onClick={()=>void refresh()}>Reintentar</button></div>}
  {!loading&&!error&&!matches.length&&<p>No hay coincidencias exactas pendientes entre textos y movimientos B3.</p>}
  {!loading&&!error&&matches.map(match=><section className="manual-b3-match" key={match.intake_id}>
    <div className="manual-b3-summary"><strong>{match.owner} · {match.side} {match.quantity} {match.instrument_code}</strong><span>{match.trade_date} · {match.candidate_count} fila(s) B3 candidata(s)</span></div>
    <blockquote>{match.original_text}</blockquote>
    <ul>{match.candidates.map(candidate=><li key={candidate.assertion_id}><span>{candidate.date} · {candidate.source_event_type??candidate.event_type??"evento B3"}</span><span>{candidate.direction??"sentido pendiente"} · {candidate.quantity} unidades · {candidate.custodian??"custodio pendiente"} · diferencia {candidate.date_distance_days} día(s)</span>{candidate.review&&<small>Decisión guardada: {candidate.review.decision==="related"?"relacionada":"no relacionada"} · revisión {candidate.review.revision}</small>}<div className="manual-b3-actions"><button type="button" disabled={!!saving} onClick={()=>void decide(match,candidate,"related")}>{saving===candidate.assertion_id?"Guardando…":candidate.review?.decision==="related"?"Confirmada · cambiar":"Confirmar relación"}</button><button type="button" disabled={!!saving} onClick={()=>void decide(match,candidate,"not_related")}>{candidate.review?.decision==="not_related"?"Descartada · cambiar":"No coincide"}</button></div></li>)}</ul>
    <small>Solo sugerencia de relación. No confirma que las filas sean el mismo evento ni cambia la cartera.</small>
  </section>)}
  <button type="button" className="text-button" onClick={()=>void refresh()} disabled={loading}>Actualizar coincidencias</button>
 </article>;
}
