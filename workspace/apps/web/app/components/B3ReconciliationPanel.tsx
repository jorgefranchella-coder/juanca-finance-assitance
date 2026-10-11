"use client";

import { useCallback, useEffect, useState } from "react";

type Difference = {
  key: string;
  kind: string;
  instrument_code: string | null;
  delta: string;
  unit_rollforward?: { status: string; net_quantity: string | null; expected_delta: string };
  candidate_movement_details?: Array<{ date: string | null; source_event_type: string | null }>;
  review_reasons?: string[];
  review?: { decision: "confirmed" | "dismissed"; revision: number; stale: boolean } | null;
};
type Report = {
  prior_document_id: string;
  current_document_id: string;
  prior_snapshot_date: string;
  new_snapshot_date: string;
  prior_positions: number;
  new_positions: number;
  movement_interval_complete: boolean;
  differences: Difference[];
  portfolio_published: false;
};
type Result = { reports: Report[]; count: number; apply_enabled: false };

const kindLabel: Record<string, string> = {
  added: "Posición nueva",
  removed: "Posición ausente",
  quantity_changed: "Cantidad diferente",
};
const rollforwardLabel: Record<string, string> = {
  matches: "Movimientos explican la variación de unidades",
  mismatch: "Los movimientos no explican la variación",
  inconclusive: "Semántica insuficiente para calcular unidades",
  not_available: "Sin rollforward de unidades",
};
const reasonLabel: Record<string, string> = {
  custody_account_pending: "Falta confirmar la cuenta de custodia",
  instrument_pending: "Falta identificar el instrumento",
  no_post_snapshot_movement: "No hay movimiento posterior al corte anterior",
  movement_identity_pending: "Falta resolver la identidad de un movimiento",
  movement_quantity_semantics_incomplete: "El movimiento no permite calcular unidades con seguridad",
  movement_quantity_delta_mismatch: "La suma de unidades difiere del cambio del snapshot",
};

export default function B3ReconciliationPanel() {
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/shadow/reconciliation/b3/candidates", { cache: "no-store" });
      if (!response.ok) throw new Error("No se pudo consultar la conciliación en sombra.");
      setResult(await response.json() as Result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo consultar la conciliación en sombra.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const decide = async (difference: Difference, decision: "confirmed" | "dismissed") => {
    if (!report) return;
    setSaving(difference.key);
    setError("");
    try {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      const request_key = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
      const response = await fetch("/api/shadow/reconciliation/b3/decisions", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request_key, prior_document_id: report.prior_document_id, current_document_id: report.current_document_id, candidate_key: difference.key, decision }),
      });
      const result = await response.json() as { code?: string };
      if (!response.ok) throw new Error(result.code === "STALE_CANDIDATE" ? "La diferencia cambió; actualiza el informe antes de decidir." : "No se pudo guardar la revisión auditada.");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo guardar la revisión.");
    } finally { setSaving(""); }
  };

  const report = result?.reports[0];
  return <article className="panel b3-reconciliation-panel" aria-live="polite">
    <div className="panel-title">
      <div><p>B3 · SOMBRA</p><h2>Comparación de snapshots</h2></div>
      <span className="safe-badge">no modifica la cartera</span>
    </div>
    {loading && <p>Consultando informes de conciliación…</p>}
    {!loading && error && <div className="inline-error" role="alert">{error} <button type="button" className="text-button" onClick={() => void load()}>Reintentar</button></div>}
    {!loading && !error && !report && <p>No hay comparaciones B3 disponibles todavía.</p>}
    {!loading && !error && report && <>
      <p>Snapshot anterior {report.prior_snapshot_date} ({report.prior_positions} filas) → nuevo {report.new_snapshot_date} ({report.new_positions} filas).</p>
      {!report.movement_interval_complete && <p className="review-note">La cobertura de movimientos no llega a cubrir todo el intervalo; las diferencias requieren revisión.</p>}
      {report.differences.length === 0 ? <p>Sin diferencias de cantidad detectadas.</p> : <ul className="b3-difference-list">
        {report.differences.map((difference, index) => <li key={`${difference.instrument_code ?? "unknown"}-${index}`}>
          <strong>{kindLabel[difference.kind] ?? "Diferencia"}: {difference.instrument_code ?? "Instrumento pendiente"}</strong>
          <span>Variación observada: {difference.delta} unidades.</span>
          <span>{rollforwardLabel[difference.unit_rollforward?.status ?? "not_available"] ?? "Rollforward pendiente"}.</span>
          {!!difference.review_reasons?.length && <span>{difference.review_reasons.map(reason => reasonLabel[reason] ?? "Pendiente de revisión").join(" · ")}</span>}
          {!!difference.candidate_movement_details?.length && <small>Movimientos candidatos: {difference.candidate_movement_details.map(movement => `${movement.date ?? "fecha pendiente"} ${movement.source_event_type ?? ""}`).join("; ")}</small>}
          {difference.review?.stale ? <small>La revisión anterior corresponde a una versión distinta de esta diferencia.</small> : difference.review && <small>Revisión guardada: {difference.review.decision === "confirmed" ? "confirmada" : "descartada"} · revisión {difference.review.revision}</small>}
          <div className="manual-b3-actions">
            <button type="button" disabled={!!saving} onClick={() => void decide(difference, "confirmed")}>{saving === difference.key ? "Guardando…" : difference.review?.decision === "confirmed" && !difference.review.stale ? "Confirmada · cambiar" : "Confirmar diferencia"}</button>
            <button type="button" disabled={!!saving} onClick={() => void decide(difference, "dismissed")}>{difference.review?.decision === "dismissed" && !difference.review.stale ? "Descartada · cambiar" : "Descartar diferencia"}</button>
          </div>
        </li>)}
      </ul>}
      <p className="review-note">Solo lectura. Ninguna diferencia se acepta ni se aplica desde esta pantalla; la cartera vigente permanece sin cambios.</p>
    </>}
    <button type="button" className="text-button" onClick={() => void load()} disabled={loading}>Actualizar informe</button>
  </article>;
}
