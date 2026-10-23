"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Status = "no_snapshot_quantity" | "no_acquisition_lots" | "lots_after_snapshot" | "matches_snapshot" | "acquisitions_exceed_snapshot" | "snapshot_exceeds_acquisitions";
type Position = { position_id: string; owner: string; institution: string; custody_account_id: string | null; custody_identity_resolved: boolean; instrument_code: string; currency: string; snapshot_as_of: string | null; snapshot_quantity: string | null; current_lot_count: number; active_lot_count: number; current_gross_acquisition_quantity: string; latest_lot_date: string | null; status: Status; snapshot_minus_gross_acquisitions: string | null };
type Report = { positions: Position[]; position_count: number; status_counts: Record<string, number>; portfolio_changed: false };
type Lot = { acquisition_id: string; revision: number; effective_date: string; quantity: string; unit_price: string; fees_minor: number | null; currency: string; evidence_kind: string; evidence_id: string; voided: boolean };
type LotReport = { lots: Lot[]; current_lots: Lot[]; portfolio_changed: false; authoritative: false };

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
  const [selected, setSelected] = useState<Position | null>(null);
  const [lotReport, setLotReport] = useState<LotReport | null>(null);
  const [lotError, setLotError] = useState("");
  const [savingLot, setSavingLot] = useState(false);
  const [lotDate, setLotDate] = useState("");
  const [lotQuantity, setLotQuantity] = useState("");
  const [lotPrice, setLotPrice] = useState("");
  const [lotEvidence, setLotEvidence] = useState("");
  const [editingLot, setEditingLot] = useState<Lot | null>(null);
  const [voidLot, setVoidLot] = useState(false);
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
  const loadLots = useCallback(async (position: Position) => {
    setSelected(position); setLotReport(null); setLotError("");
    try {
      const response = await fetch(`/api/shadow/position-identities/${position.position_id}/acquisitions`, { cache: "no-store" });
      const result = await response.json() as LotReport & { code?: string };
      if (!response.ok) throw new Error(result.code ?? "No fue posible consultar los lotes.");
      setLotReport(result);
    } catch (problem) { setLotError(problem instanceof Error ? problem.message : "No fue posible consultar los lotes."); }
  }, []);
  const recordLot = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected || !selected.custody_identity_resolved || savingLot) return;
    setSavingLot(true); setLotError("");
    try {
      const response = await fetch(`/api/shadow/position-identities/${selected.position_id}/acquisitions`, {
        method: "POST", headers: { "Content-Type": "application/json", "X-Juanca-Request": "1" },
        body: JSON.stringify({ request_key: crypto.randomUUID(), ...(editingLot ? { acquisition_id: editingLot.acquisition_id, supersedes_revision: editingLot.revision } : {}),
          effective_date: lotDate, quantity: lotQuantity, unit_price: lotPrice, currency: selected.currency,
          evidence_kind: "legacy_review", evidence_id: lotEvidence.trim(), ...(editingLot ? { voided: voidLot } : {}) }),
      });
      const result = await response.json() as { code?: string };
      if (!response.ok) throw new Error(result.code ?? "No fue posible registrar el lote.");
      setLotDate(""); setLotQuantity(""); setLotPrice(""); setLotEvidence("");
      setEditingLot(null); setVoidLot(false);
      await loadLots(selected); await load();
    } catch (problem) { setLotError(problem instanceof Error ? problem.message : "No fue posible registrar el lote."); }
    finally { setSavingLot(false); }
  };
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
        <td><button type="button" className="acquisition-position-button" onClick={() => void loadLots(position)} aria-expanded={selected?.position_id === position.position_id}><strong>{position.instrument_code}</strong><small>{position.owner} · {position.currency} · revisar lotes</small></button></td>
        <td>{position.institution}<small>{position.custody_account_id ?? "Cuenta pendiente"}</small></td>
        <td>{position.snapshot_quantity ?? "—"}<small>{position.snapshot_as_of ?? "Sin fecha de corte"}</small></td>
        <td>{position.current_gross_acquisition_quantity}<small>{position.active_lot_count} lotes vigentes</small></td>
        <td>{position.snapshot_minus_gross_acquisitions ?? "—"}</td>
        <td><span className={`acquisition-status status-${position.status}`}>{labels[position.status]}</span></td>
      </tr>)}</tbody></table></div> : <p className="acquisition-reconciliation-empty">No hay posiciones con lotes para este filtro.</p>}
      <label className="acquisition-reconciliation-all"><input type="checkbox" checked={showAll} onChange={event => setShowAll(event.target.checked)} /> Incluir posiciones sin lotes registrados</label>
      {selected && <div className="acquisition-lot-review"><div><strong>{selected.owner} · {selected.instrument_code}</strong><small>{selected.institution} · {selected.currency} · {selected.custody_account_id ?? "Cuenta pendiente"}</small></div>
        {lotError && <p className="acquisition-reconciliation-error">{lotError}</p>}
        {!lotReport && !lotError ? <p className="projection-loading">Cargando lotes…</p> : lotReport && <>
          {lotReport.current_lots.length ? <div className="fixed-income-table-wrap"><table className="fixed-income-table acquisition-lot-table"><thead><tr><th>Fecha</th><th>Cantidad</th><th>Precio unitario</th><th>Referencia de evidencia</th><th>Estado / acción</th></tr></thead><tbody>{lotReport.current_lots.map(lot => <tr key={`${lot.acquisition_id}-${lot.revision}`}><td>{lot.effective_date}<small>Revisión {lot.revision}</small></td><td>{lot.quantity}</td><td>{lot.unit_price} {lot.currency}</td><td>{lot.evidence_kind}: {lot.evidence_id}</td><td>{lot.voided ? "Anulado" : "Vigente"}{!lot.voided && selected.custody_identity_resolved && <button type="button" className="acquisition-lot-edit" onClick={() => { setEditingLot(lot); setLotDate(lot.effective_date); setLotQuantity(lot.quantity); setLotPrice(lot.unit_price); setLotEvidence(""); setVoidLot(false); }}>Crear revisión</button>}</td></tr>)}</tbody></table></div> : <p className="acquisition-reconciliation-empty">No hay lotes vigentes.</p>}
          {selected.custody_identity_resolved ? <form className="acquisition-lot-form" onSubmit={recordLot}><strong>{editingLot ? `Nueva revisión del lote · revisión ${editingLot.revision}` : "Registrar lote histórico en PostgreSQL sombra"}</strong><div><label>Fecha de compra<input type="date" required value={lotDate} onChange={event => setLotDate(event.target.value)} /></label><label>Cantidad<input type="number" min="0.00000001" step="any" required value={lotQuantity} onChange={event => setLotQuantity(event.target.value)} /></label><label>Precio unitario<input type="number" min="0.00000001" step="any" required value={lotPrice} onChange={event => setLotPrice(event.target.value)} /></label><label>Referencia de evidencia<input required maxLength={500} value={lotEvidence} onChange={event => setLotEvidence(event.target.value)} placeholder="Hoja, archivo, fila o confirmación" /></label></div>{editingLot && <label className="acquisition-lot-void"><input type="checkbox" checked={voidLot} onChange={event => setVoidLot(event.target.checked)} /> Anular este lote en la nueva revisión</label>}<div className="acquisition-lot-actions"><button type="submit" disabled={savingLot}>{savingLot ? "Guardando…" : editingLot ? "Guardar nueva revisión" : "Registrar lote de sombra"}</button>{editingLot && <button type="button" disabled={savingLot} onClick={() => { setEditingLot(null); setVoidLot(false); setLotDate(""); setLotQuantity(""); setLotPrice(""); setLotEvidence(""); }}>Cancelar</button>}</div><small>Los cambios quedan versionados y auditados. No alteran saldo, costo base oficial ni proyección vigente.</small></form> : <p className="acquisition-reconciliation-note">No se puede registrar el lote mientras la identidad de custodia esté pendiente.</p>}
        </>}
      </div>}
      <small className="acquisition-reconciliation-footnote">* Diferencia = cantidad del snapshot menos compras brutas vigentes. Se omite si faltan datos de corte o hay compras posteriores al snapshot.</small>
    </> : null}
  </section>;
}
