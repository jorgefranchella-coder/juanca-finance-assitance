"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Status = "no_snapshot_quantity" | "no_acquisition_lots" | "lots_after_snapshot" | "matches_snapshot" | "acquisitions_exceed_snapshot" | "snapshot_exceeds_acquisitions";
type Position = { position_id: string; owner: string; institution: string; custody_account_id: string | null; instrument_code: string; currency: string; snapshot_as_of: string | null; snapshot_quantity: string | null; current_lot_count: number; active_lot_count: number; current_gross_acquisition_quantity: string; latest_lot_date: string | null; status: Status; snapshot_minus_gross_acquisitions: string | null };
type Report = { positions: Position[]; position_count: number; status_counts: Record<string, number>; portfolio_changed: false };

const labels: Record<Status, string> = {
  no_snapshot_quantity: "Sem quantidade de snapshot",
  no_acquisition_lots: "Sem compras registradas",
  lots_after_snapshot: "Compras posteriores ao snapshot",
  matches_snapshot: "Compras iguais ao snapshot",
  acquisitions_exceed_snapshot: "Compras acima do snapshot",
  snapshot_exceeds_acquisitions: "Snapshot acima das compras",
};

export default function AcquisitionReconciliationPanel() {
  const [report, setReport] = useState<Report | null>(null);
  const [owner, setOwner] = useState("Todos");
  const [showAll, setShowAll] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/shadow/position-identities/acquisition-reconciliation", { cache: "no-store" });
      const result = await response.json() as Report & { code?: string };
      if (!response.ok) throw new Error(result.code ?? "No fue posible consultar la conciliación de compras.");
      setReport(result); setError("");
    } catch (problem) { setError(problem instanceof Error ? problem.message : "No fue posible consultar la conciliación de compras."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    window.addEventListener("portfolio-data-updated", load);
    return () => { window.clearTimeout(timer); window.removeEventListener("portfolio-data-updated", load); };
  }, [load]);
  const owners = useMemo(() => [...new Set((report?.positions ?? []).map(position => position.owner))].sort((a, b) => a.localeCompare(b)), [report]);
  const positions = useMemo(() => (report?.positions ?? []).filter(position => (owner === "Todos" || position.owner === owner) && (showAll || position.current_lot_count > 0)), [report, owner, showAll]);

  return <section className="panel acquisition-reconciliation" aria-labelledby="acquisition-reconciliation-title">
    <header className="acquisition-reconciliation-header">
      <div><p className="eyebrow">Evidencia de renta fija</p><h2 id="acquisition-reconciliation-title">Compras frente al snapshot B3</h2><p>Conciliación de cantidades registradas por título. No modifica la cartera.</p></div>
      <div className="acquisition-reconciliation-controls">
        <label>Titular<select value={owner} onChange={event => setOwner(event.target.value)}><option>Todos</option>{owners.map(name => <option key={name}>{name}</option>)}</select></label>
        <button type="button" onClick={() => void load()} disabled={loading}>Actualizar</button>
      </div>
    </header>
    <p className="acquisition-reconciliation-note">Las compras son cantidades brutas: no descuentan ventas, rescates ni transferencias y no representan por sí solas el saldo de apertura.</p>
    {error ? <p className="acquisition-reconciliation-error">{error}</p> : loading && !report ? <p className="projection-loading">Cargando conciliación…</p> : report ? <>
      <div className="acquisition-reconciliation-counts"><span>{report.position_count} posiciones revisadas</span>{Object.entries(report.status_counts).map(([status, count]) => <span key={status}>{count} · {labels[status as Status] ?? status}</span>)}</div>
      {positions.length ? <div className="fixed-income-table-wrap acquisition-reconciliation-table-wrap"><table className="fixed-income-table acquisition-reconciliation-table"><thead><tr><th>Titular / activo</th><th>Custodia</th><th>Snapshot</th><th>Compras brutas</th><th>Diferencia*</th><th>Estado</th></tr></thead><tbody>{positions.map(position => <tr key={position.position_id}>
        <td><strong>{position.instrument_code}</strong><small>{position.owner} · {position.currency}</small></td>
        <td>{position.institution}<small>{position.custody_account_id ?? "Cuenta pendiente"}</small></td>
        <td>{position.snapshot_quantity ?? "—"}<small>{position.snapshot_as_of ?? "Sin fecha de corte"}</small></td>
        <td>{position.current_gross_acquisition_quantity}<small>{position.active_lot_count} lotes vigentes</small></td>
        <td>{position.snapshot_minus_gross_acquisitions ?? "—"}</td>
        <td><span className={`acquisition-status status-${position.status}`}>{labels[position.status]}</span></td>
      </tr>)}</tbody></table></div> : <p className="acquisition-reconciliation-empty">No hay posiciones con lotes para este filtro.</p>}
      <label className="acquisition-reconciliation-all"><input type="checkbox" checked={showAll} onChange={event => setShowAll(event.target.checked)} /> Incluir posiciones sin lotes registrados</label>
      <small className="acquisition-reconciliation-footnote">* Diferencia = cantidad del snapshot menos compras brutas vigentes. Se omite si faltan datos de corte o hay compras posteriores al snapshot.</small>
    </> : null}
  </section>;
}
