"use client";

import { useCallback, useEffect, useState } from "react";

type Item = {
  id: string; owner: string; original_text: string; occurred_on: string|null; status: string; received_at: string;
  interpretation_status: "parsed_review"|"needs_manual_review"|"not_detected"|null;
  fields: { side?: string|null; instrument_code?: string|null; quantity?: string|null; unit_price?: string|null; currency?: string|null; trade_date?: string|null }|null;
  review_reasons: string[]|null;
};

export default function ManualIntakePanel() {
  const [items,setItems]=useState<Item[]>([]);const [loading,setLoading]=useState(true);const [error,setError]=useState("");
  const load=useCallback(async()=>{const response=await fetch("/api/shadow/evidence/text",{cache:"no-store"});if(!response.ok)throw new Error("No fue posible consultar la bandeja de evidencia escrita.");const result=await response.json() as {items:Item[]};return result.items??[];},[]);
  useEffect(()=>{let active=true;load().then(value=>{if(active)setItems(value);}).catch(problem=>{if(active)setError(problem instanceof Error?problem.message:"Error de consulta.");}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[load]);
  const refresh=async()=>{setLoading(true);setError("");try{setItems(await load());}catch(problem){setError(problem instanceof Error?problem.message:"Error de consulta.");}finally{setLoading(false);}};
  return <article className="panel manual-intake-panel" aria-live="polite">
    <div className="panel-title"><div><p>Movimientos escritos · sombra</p><h2>Evidencia recibida</h2></div><span className="safe-badge">solo lectura</span></div>
    {loading&&<p>Consultando entradas…</p>}{!loading&&error&&<div className="inline-error" role="alert">{error} <button type="button" className="text-button" onClick={()=>void refresh()}>Reintentar</button></div>}
    {!loading&&!error&&!items.length&&<p>No hay textos registrados en la nueva aplicación.</p>}
    {!loading&&!error&&items.length>0&&<div className="manual-intake-list">{items.map(item=><section className="manual-intake-item" key={item.id}>
      <header><strong>{item.owner}</strong><span>{item.status.replaceAll("_"," ")}</span><time>{new Date(item.received_at).toLocaleString("es-AR")}</time></header>
      <blockquote>{item.original_text}</blockquote>
      {item.interpretation_status&&<div className="manual-intake-reading"><strong>{item.interpretation_status==="parsed_review"?"Campos identificados · requieren confirmación":item.interpretation_status==="not_detected"?"Sin operación reconocida":"Interpretación incompleta · revisión manual"}</strong>{item.fields&&<p>{item.fields.side??"lado pendiente"} · {item.fields.instrument_code??"activo pendiente"} · {item.fields.quantity??"cantidad pendiente"} · {item.fields.unit_price&&item.fields.currency?`${item.fields.currency} ${item.fields.unit_price}`:"precio pendiente"} · {item.fields.trade_date??"fecha pendiente"}</p>}{!!item.review_reasons?.length&&<small>{item.review_reasons.map(reason=>reason.replaceAll("_"," ")).join(" · ")}</small>}</div>}
      <small className="manual-intake-meta">Fecha declarada: {item.occurred_on??"no indicada"} · Sin cambios en posiciones ni efectivo.</small>
    </section>)}</div>}
    <button type="button" className="text-button" onClick={()=>void refresh()} disabled={loading}>Actualizar bandeja</button>
  </article>;
}
