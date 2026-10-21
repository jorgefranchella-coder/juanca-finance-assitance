"use client";

import { useCallback, useEffect, useState } from "react";

type Action = { key: string; label: string; description?: string; keeps_open?: boolean };
type Item = {
  id: string; owner: string; category: string; title: string;
  context: Record<string, unknown>; evidence: string[]; actions: Action[];
  status: "open" | "resolved"; created_at: string;
  decision: { action_key: string; note: string | null; decided_at: string | null } | null;
};
type Result = { items: Item[]; open_count: number };

function contextText(context: Record<string, unknown>) {
  return Object.entries(context).map(([key, value]) => `${key.replaceAll("_", " ")}: ${String(value)}`).join(" · ");
}

export default function ConfirmationQueue() {
  const [result, setResult] = useState<Result | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const response = await fetch(`/api/portfolio/confirmations${showResolved ? "" : "?status=open"}`, { cache: "no-store" });
    if (!response.ok) throw new Error("No se pudo cargar la base de confirmaciones.");
    setResult(await response.json() as Result);
  }, [showResolved]);

  useEffect(() => {
    let active = true;
    const refresh = () => { void load().catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "Error de carga."); }); };
    refresh();
    window.addEventListener("confirmations-updated", refresh);
    return () => { active = false; window.removeEventListener("confirmations-updated", refresh); };
  }, [load]);

  async function decide(item: Item) {
    const actionKey = choices[item.id] ?? item.decision?.action_key;
    if (!actionKey) { setError("Elige una acción para responder cada duda."); return; }
    setSaving(item.id); setError("");
    try {
      const response = await fetch(`/api/portfolio/confirmations/${encodeURIComponent(item.id)}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action_key: actionKey, note: notes[item.id] ?? "" }),
      });
      const body = await response.json() as { detail?: string };
      if (!response.ok) throw new Error(body.detail ?? "No se pudo guardar la respuesta.");
      await load();
      window.dispatchEvent(new Event("portfolio-data-updated"));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo guardar la respuesta."); }
    finally { setSaving(""); }
  }

  const items = result?.items ?? [];
  return <section className="confirmation-queue panel" aria-label="Base de confirmaciones">
    <div className="panel-title"><div><p>Decisiones del usuario</p><h2>Base de confirmaciones</h2></div><span className="review-badge">{result?.open_count ?? "…"} abiertas</span></div>
    <p className="confirmation-queue-intro">Las dudas de conciliación quedan guardadas con evidencia y acciones concretas. Tu respuesta se registra con fecha; cualquier cambio patrimonial posterior se procesa aparte.</p>
    {error && <p className="confirmation-queue-error" role="alert">{error}</p>}
    {items.length === 0 ? <p className="confirmation-queue-empty">{result ? showResolved ? "Todavía no hay confirmaciones registradas." : "No hay decisiones pendientes." : "Cargando confirmaciones…"}</p> : <div className="confirmation-queue-list">
      {items.map((item) => <article className="confirmation-item" key={item.id}>
        <div className="confirmation-item-meta"><span>{item.owner} · {item.category}</span><time>{new Date(item.created_at.replace(" ", "T") + "Z").toLocaleDateString("es-AR")}</time></div>
        <h3>{item.title}</h3>
        {!!Object.keys(item.context).length && <p>{contextText(item.context)}</p>}
        {!!item.evidence.length && <details><summary>Evidencia consultada ({item.evidence.length})</summary><ul>{item.evidence.map((entry, index) => <li key={index}>{entry}</li>)}</ul></details>}
        {item.status === "resolved" ? <div className="confirmation-saved"><strong>Respuesta registrada{item.decision?.decided_at ? ` · ${new Date(item.decision.decided_at.replace(" ", "T") + "Z").toLocaleDateString("es-AR")}` : ""}</strong><p>{item.actions.find((action) => action.key === item.decision?.action_key)?.label ?? item.decision?.action_key}</p>{item.decision?.note && <small>{item.decision.note}</small>}</div> : <>
          <fieldset><legend>¿Qué hacemos con este caso?</legend>{item.actions.map((action) => <label className="confirmation-action" key={action.key}>
            <input type="radio" name={`action-${item.id}`} value={action.key} checked={(choices[item.id] ?? item.decision?.action_key) === action.key} onChange={() => setChoices((current) => ({ ...current, [item.id]: action.key }))} />
            <span><strong>{action.label}</strong>{action.description && <small>{action.description}</small>}</span>
          </label>)}</fieldset>
          <label className="confirmation-note">Nota opcional<textarea value={notes[item.id] ?? item.decision?.note ?? ""} onChange={(event) => setNotes((current) => ({ ...current, [item.id]: event.target.value }))} maxLength={1000} rows={2} /></label>
          {item.decision && <div className="confirmation-saved"><strong>Siguiente paso registrado · pendiente de cierre</strong><p>{item.actions.find((action) => action.key === item.decision?.action_key)?.label ?? item.decision.action_key}</p>{item.decision.note && <small>{item.decision.note}</small>}</div>}
          <button type="button" className="confirmation-save" disabled={saving === item.id || !(choices[item.id] ?? item.decision?.action_key)} onClick={() => void decide(item)}>{saving === item.id ? "Guardando…" : item.decision ? "Actualizar respuesta" : "Registrar respuesta"}</button>
        </>}
      </article>)}
    </div>}
    <button type="button" className="text-button confirmation-history" onClick={() => setShowResolved((value) => !value)}>{showResolved ? "Ver solo pendientes" : "Ver historial de respuestas"}</button>
  </section>;
}
