"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildFixedIncomeMatrixYears, fixedIncomePeriodValue, summarizeFixedIncomePeriod, type ProjectionPeriodValue } from "@/lib/fixed-income-projection";
import { contractualPeriod, contractualSummary } from "@/lib/fixed-income-contract-schedule";

type ProjectionItem = {
  owner: string; account: string | null; instrument_code: string; product_name: string; institution: string; issuer: string;
  maturity_date: string; reference_date: string; quantity: number; current_unit_price: number;
  current_value_cents: number; projected_value_cents: number | null; projected_gain_cents: number | null;
  observationCount: number; firstDate: string; lastDate: string; elapsedDays: number;
  periodReturn: number | null; annualizedReturn: number | null;
  observation_sources: string[]; has_mixed_valuation_methods: boolean;
  excluded_observation_sources: string[];
  has_unverified_sheet_source: boolean;
  confidence: "high" | "medium" | "low" | "insufficient"; reason: string | null;
  contractual?: { status: "complete" | "incomplete"; missing: string[]; version: string; position_id?: string;
    revision?: number; source_document_id?: string; source_locator?: string; rate_pct?: number; indexer?: string; indexer_relation?: "additive" | "compound" | "multiplier"; indexer_assumption_pct?: string | null;
    gross_maturity_cents: number | null; net_maturity_cents: number | null; gross_cashflows_cents: number | null; net_cashflows_cents: number | null; tax_status?: string;
    calendar: Array<{ date: string; balance_cents: number; cashflow_cents: number; maturity_cents: number }> };
};
type ProjectionResponse = {
  reference_date: string;
  summary: { total_current_cents: number; covered_current_cents: number; covered_projected_cents: number;
    projected_gain_cents: number; coverage: number; projected_count: number; total_count: number };
  items: ProjectionItem[];
  acquisition_lot_diagnostics?: { active_lots: number; voided_lots: number; account_unresolved: number; no_current_position: number; ambiguous_position: number; invalid_or_not_historical: number; used_lots: number };
  cost_basis_diagnostics?: { total: number; google_sheet: number; verified: number; unmatched: number; ambiguous: number; account_unresolved: number; quantity_mismatch: number; date_invalid: number; superseded_by_acquisition_lot: number; other_source: number };
  methodology: string;
  contractual_summary?: { total_count: number; projected_count: number; current_cents: number; gross_maturity_cents: number; coverage: number; version: string };
};
type ContractPosition = { position_id: string; instrument_code: string; currency: string; owner: string; institution: string; account: string | null;
  custody_identity_resolved: boolean;
  source_document_id?: string | null; source_locator?: string | null; revision?: number; interest_treatment?: "capitalize" | "cashflow"; indexer_relation?: "additive" | "compound" | "multiplier"; schedule_confirmed?: boolean;
  method?: "fixed" | "indexed"; indexer?: "none" | "CDI" | "IPCA" | "SELIC"; annual_rate_pct?: string; indexer_assumption_pct?: string | null;
  tax_rate_pct?: string | null; payment_schedule?: Array<{ date: string; kind: "coupon" | "amortization"; amount_per_unit: string }>;
};
type ContractDocument = { source_document_id: string; owner: string; original_name: string; source_system: string; effective_as_of: string | null };
type ContractResponse = { positions: ContractPosition[]; source_documents: ContractDocument[] };
type Model = "historical" | "contractual";
type IssuerGroup = { key: string; owner: string; issuer: string; items: ProjectionItem[] };

const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const percent = new Intl.NumberFormat("pt-BR", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 2 });
const decimalValue = (value: string) => value.trim().replace(",", ".");
function date(value: string) { return value ? value.split("-").reverse().join("/") : "—"; }
function confidenceName(value: ProjectionItem["confidence"]) {
  if (value === "high") return "alta (≥180 días y ≥4 precios)";
  if (value === "medium") return "media (≥90 días y ≥3 precios)";
  if (value === "low") return "baixa (histórico curto)";
  return "insuficiente";
}
function sourceName(value: string) {
  const label = ({ b3_mtm: "MTM B3", b3_curve: "curva B3", b3_close: "fechamento B3", b3_position: "posição B3", acquisition_lot: "lote de aquisição revisado", manual: "custo manual", broker_note: "nota de corretagem" } as Record<string, string>)[value];
  if (label) return label;
  if (value.startsWith("google_sheet:")) return `hoja de cálculo · ${value.split(":").slice(2).join(":")}`;
  return value.replaceAll("_", " ");
}

function ValueCell({ value, cashflowLabel = "Venc." }: { value: ProjectionPeriodValue; cashflowLabel?: string }) {
  const labels = { projected: "Saldo projetado", maturity: "Vencimento", matured: "Vencido",
    insufficient_data: "Faltam dados", outside_coverage: "Sem cobertura", conflict: "Em revisão" };
  return <span className="matrix-value">
    {value.balance_cents === null ? <span className="matrix-empty">{labels[value.status]}</span>
      : value.status === "matured" ? <span className="matrix-empty">Vencido</span>
      : <strong>{money.format(value.balance_cents / 100)}</strong>}
    {value.maturity_cents !== null && value.maturity_cents > 0 && <small>{cashflowLabel} {money.format(value.maturity_cents / 100)}</small>}
    {value.partial && value.balance_cents !== null && <small>Parcial</small>}
    {value.reason && <details className="matrix-reason"><summary>Motivo</summary><span>{value.reason}</span></details>}
  </span>;
}

export default function FixedIncomeProjection({ endpoint = "/api/portfolio/fixed-income-projection", shadow = false }: { endpoint?: string; shadow?: boolean }) {
  const [data, setData] = useState<ProjectionResponse | null>(null);
  const [contracts, setContracts] = useState<ContractResponse | null>(null);
  const [model, setModel] = useState<Model>("historical");
  const [selectedPosition, setSelectedPosition] = useState("");
  const [method, setMethod] = useState<"fixed" | "indexed">("fixed");
  const [interestTreatment, setInterestTreatment] = useState<"capitalize" | "cashflow">("capitalize");
  const [indexerRelation, setIndexerRelation] = useState<"additive" | "compound" | "multiplier">("additive");
  const [indexer, setIndexer] = useState<"CDI" | "IPCA" | "SELIC">("CDI");
  const [rate, setRate] = useState("");
  const [indexRate, setIndexRate] = useState("");
  const [tax, setTax] = useState("");
  const [sourceDocument, setSourceDocument] = useState("");
  const [sourceLocator, setSourceLocator] = useState("");
  const [scheduleText, setScheduleText] = useState("");
  const [scheduleConfirmed, setScheduleConfirmed] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const pendingContractRequest = useRef<{ body: string; key: string } | null>(null);
  const [owner, setOwner] = useState("Todos");
  const [error, setError] = useState("");
  const [expandedYears, setExpandedYears] = useState<Set<string>>(() => new Set());
  const [expandedIssuers, setExpandedIssuers] = useState<Set<string>>(() => new Set());
  const load = useCallback(async () => {
    try {
      const response = await fetch(endpoint, { cache: "no-store" });
      const result = await response.json() as ProjectionResponse & { detail?: string };
      if (!response.ok) throw new Error(result.detail ?? "Não foi possível calcular a projeção.");
      setData(result); setError("");
      if (shadow) {
        const termsResponse = await fetch(endpoint.replace("fixed-income-projection", "fixed-income-terms"), { cache: "no-store" });
        const termsData = await termsResponse.json() as ContractResponse & { detail?: string };
        if (!termsResponse.ok) throw new Error(termsData.detail ?? "No se pudieron cargar las condiciones contractuales.");
        setContracts(termsData);
      }
    } catch (loadError) { setError(loadError instanceof Error ? loadError.message : "Não foi possível calcular a projeção."); }
  }, [endpoint, shadow]);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    window.addEventListener("portfolio-data-updated", load);
    return () => { window.clearTimeout(timer); window.removeEventListener("portfolio-data-updated", load); };
  }, [load]);
  const items = useMemo(() => (data?.items ?? []).filter((item) => owner === "Todos" || item.owner === owner), [data, owner]);
  const summary = useMemo(() => {
    if (model === "contractual") {
      const complete = items.filter((item) => item.contractual?.status === "complete");
      const current = items.reduce((sum, item) => sum + item.current_value_cents, 0);
      const projected = complete.reduce((sum, item) => sum + (item.contractual?.gross_maturity_cents ?? 0), 0);
      const covered = complete.reduce((sum, item) => sum + item.current_value_cents, 0);
      const netComplete = complete.filter((item) => item.contractual?.net_maturity_cents !== null);
      const netProjected = netComplete.reduce((sum, item) => sum + (item.contractual?.net_maturity_cents ?? 0), 0);
      return { totalCurrent: current, coveredCurrent: covered, coveredProjected: projected, gain: projected - covered, netProjected, netProjectedCount: netComplete.length,
        coverage: current ? covered / current : 0, projectedCount: complete.length };
    }
    const covered = items.filter((item) => item.projected_value_cents !== null);
    const totalCurrent = items.reduce((sum, item) => sum + item.current_value_cents, 0);
    const coveredCurrent = covered.reduce((sum, item) => sum + item.current_value_cents, 0);
    const coveredProjected = covered.reduce((sum, item) => sum + (item.projected_value_cents ?? 0), 0);
    return { totalCurrent, coveredCurrent, coveredProjected, gain: coveredProjected - coveredCurrent, netProjected: null, netProjectedCount: 0,
      coverage: totalCurrent ? coveredCurrent / totalCurrent : 0, projectedCount: covered.length };
  }, [items, model]);
  const years = useMemo(() => buildFixedIncomeMatrixYears(items), [items]);
  const columns = useMemo(() => years.flatMap((year) => expandedYears.has(year.year) ? year.months : [year.annual]), [years, expandedYears]);
  const issuerGroups = useMemo(() => {
    const groups = new Map<string, IssuerGroup>();
    for (const item of items) {
      const issuer = item.issuer || "Emissor não identificado";
      const key = `${item.owner}\0${issuer}`;
      const group = groups.get(key) ?? { key, owner: item.owner, issuer, items: [] };
      group.items.push(item);
      groups.set(key, group);
    }
    return Array.from(groups.values()).sort((a, b) => a.owner.localeCompare(b.owner) || a.issuer.localeCompare(b.issuer));
  }, [items]);
  const toggle = (setter: (value: Set<string>) => void, state: Set<string>, key: string) => {
    const next = new Set(state);
    if (next.has(key)) next.delete(key); else next.add(key);
    setter(next);
  };
  const selectedContractPosition = contracts?.positions.find((position) => position.position_id === selectedPosition);
  const saveTerms = async () => {
    const position = contracts?.positions.find((candidate) => candidate.position_id === selectedPosition);
    if (!position || !sourceDocument || !sourceLocator.trim() || !rate.trim()) { setSaveMessage("Completa título, documento, ubicación y tasa."); return; }
    setSaving(true); setSaveMessage("");
    try {
      const schedule = scheduleText.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
        const [dateValue, kindValue, rawAmount] = line.split(";").map((part) => part.trim());
        const amount = rawAmount ? decimalValue(rawAmount) : "";
        if (!dateValue || !["coupon", "amortization"].includes(kindValue) || !amount) throw new Error("Usa una fila por flujo: AAAA-MM-DD;coupon|amortization;importe por unidad.");
        return { date: dateValue, kind: kindValue as "coupon" | "amortization", amount_per_unit: amount };
      });
      const body = JSON.stringify({ position_id: selectedPosition, source_document_id: sourceDocument, source_locator: sourceLocator.trim(), terms: {
          method, interest_treatment: interestTreatment, indexer_relation: method === "fixed" ? "additive" : indexerRelation, indexer: method === "fixed" ? "none" : indexer, annual_rate_pct: decimalValue(rate),
          indexer_assumption_pct: method === "fixed" ? null : decimalValue(indexRate), tax_rate_pct: tax ? decimalValue(tax) : null, schedule_confirmed: scheduleConfirmed, payment_schedule: schedule,
        } });
      if (pendingContractRequest.current?.body !== body) pendingContractRequest.current = { body, key: `contract_${crypto.randomUUID().replaceAll("-", "")}` };
      const response = await fetch(endpoint.replace("fixed-income-projection", "fixed-income-terms"), { method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": pendingContractRequest.current.key }, body });
      const result = await response.json() as { detail?: string; code?: string };
      if (!response.ok) throw new Error(result.detail ?? result.code ?? "No se pudieron guardar las condiciones.");
      pendingContractRequest.current = null;
      setSaveMessage("Condiciones registradas como nueva revisión."); await load();
      window.dispatchEvent(new Event("portfolio-data-updated"));
    } catch (saveError) { setSaveMessage(saveError instanceof Error ? saveError.message : "Error al guardar."); }
    finally { setSaving(false); }
  };

  return <section className="panel fixed-income-projection" id="renda-fixa">
    <div className="panel-title fixed-income-title">
      <div><p>{shadow ? "PostgreSQL · autoridade ativa" : "Projeção baseada no histórico"}</p><h2>Renda fixa até o vencimento</h2><span>Expanda um ano para ver os meses; expanda um emissor para ver cada título.</span></div>
      <label>Investidor<select value={owner} onChange={(event) => { setOwner(event.target.value); setExpandedIssuers(new Set()); }}><option>Todos</option><option>Jorge</option><option>Julia</option></select></label>
    </div>
    {error ? <p className="projection-error">{error}</p> : !data ? <p className="projection-loading">Calculando histórico de preços…</p> : <>
      {shadow && <div className="projection-controls">
        <label>Modelo de proyección<select value={model} onChange={(event) => setModel(event.target.value as Model)}><option value="historical">Histórica</option><option value="contractual">Contractual</option></select></label>
        <button type="button" onClick={() => setEditorOpen(!editorOpen)}>{editorOpen ? "Ocultar condiciones" : "Registrar condiciones contractuales"}</button>
      </div>}
      {shadow && editorOpen && <div className="projection-contract-editor">
        <h3>Condiciones y evidencia del instrumento</h3>
        <p>Usa un contrato o extracto que muestre los términos. La tasa no se deduce del precio histórico ni del snapshot B3. Cada envío crea una revisión auditable.</p>
        <label>Título/cuenta<select value={selectedPosition} onChange={(event) => {
          const id = event.target.value, p = contracts?.positions.find((x) => x.position_id === id);
          setSelectedPosition(id); setSourceDocument(p?.source_document_id ?? ""); setSourceLocator(p?.source_locator ?? "");
          setMethod(p?.method ?? "fixed"); setInterestTreatment(p?.interest_treatment ?? "capitalize"); setIndexerRelation(p?.indexer_relation ?? "additive");
          setIndexer(p?.indexer && p.indexer !== "none" ? p.indexer : "CDI"); setRate(p?.annual_rate_pct ?? "");
          setIndexRate(p?.indexer_assumption_pct ?? ""); setTax(p?.tax_rate_pct ?? ""); setScheduleConfirmed(p?.schedule_confirmed ?? false);
          setScheduleText((p?.payment_schedule ?? []).map((x) => `${x.date};${x.kind};${x.amount_per_unit}`).join("\n"));
        }}><option value="">Seleccionar posición</option>{contracts?.positions.filter((p) => owner === "Todos" || p.owner === owner).map((p) => <option key={p.position_id} value={p.position_id} disabled={!p.custody_identity_resolved}>{p.owner} · {p.institution}{p.account ? ` · ${p.account}` : ""} · {p.instrument_code} {p.custody_identity_resolved ? p.method ? `(rev. ${p.revision})` : "(sin condiciones)" : "(cuenta sin resolver)"}</option>)}</select></label>
        <label>Documento<select value={sourceDocument} onChange={(event) => setSourceDocument(event.target.value)}><option value="">Seleccionar evidencia</option>{contracts?.source_documents.filter((d) => { const p = contracts.positions.find((x) => x.position_id === selectedPosition); return !p || d.owner === p.owner; }).map((doc) => <option key={doc.source_document_id} value={doc.source_document_id}>{doc.owner} · {doc.original_name} · {doc.source_system} · {doc.effective_as_of ?? "sin fecha"}</option>)}</select></label>
        <label>Ubicación precisa (página, sección, fila)<input value={sourceLocator} onChange={(event) => setSourceLocator(event.target.value)} maxLength={240} /></label>
        {selectedContractPosition?.method && <small>Condiciones actuales: revisión {selectedContractPosition.revision}; corregirlas crea una nueva revisión y conserva la anterior.</small>}
        <label>Tipo<select value={method} onChange={(event) => setMethod(event.target.value as "fixed" | "indexed")}><option value="fixed">Tasa fija</option><option value="indexed">Indexado</option></select></label>
        <label>Aplicación de interés<select value={interestTreatment} onChange={(event) => setInterestTreatment(event.target.value as "capitalize" | "cashflow")}><option value="capitalize">Capitaliza sobre el saldo</option><option value="cashflow">Interés pagado en flujos</option></select></label>
        {method === "indexed" && <><label>Índice<select value={indexer} onChange={(event) => setIndexer(event.target.value as "CDI" | "IPCA" | "SELIC")}><option>CDI</option><option>IPCA</option><option>SELIC</option></select></label><label>Relación con el índice<select value={indexerRelation} onChange={(event) => setIndexerRelation(event.target.value as "additive" | "compound" | "multiplier")}><option value="additive">Índice más spread: suma simple</option><option value="compound">Índice y spread: composición</option><option value="multiplier">Porcentaje del índice</option></select></label><label>Supuesto anual del índice (%)<input inputMode="decimal" value={indexRate} onChange={(event) => setIndexRate(event.target.value)} /></label></>}
        <label>{method === "indexed" && indexerRelation === "multiplier" ? "% del índice" : interestTreatment === "capitalize" ? "Tasa anual o spread (%)" : "Tasa/spread contractual declarado (%)"}<input inputMode="decimal" value={rate} onChange={(event) => setRate(event.target.value)} /></label>
        <label>Impuesto ilustrativo (%)<input inputMode="decimal" value={tax} onChange={(event) => setTax(event.target.value)} placeholder="Vacío = neto no disponible" /></label>
        <label>Calendario opcional en {selectedContractPosition?.currency ?? "moneda del título"}: AAAA-MM-DD;coupon|amortization;importe por unidad<textarea value={scheduleText} onChange={(event) => setScheduleText(event.target.value)} rows={3} placeholder="2027-06-15;coupon;0,45" /></label>
        <label><span><input type="checkbox" checked={scheduleConfirmed} onChange={(event) => setScheduleConfirmed(event.target.checked)} /> Confirmo que el calendario incluye todos los cupones y amortizaciones; puede estar vacío si no existen.</span></label>
        <button type="button" disabled={saving} onClick={() => void saveTerms()}>{saving ? "Guardando…" : "Guardar nueva revisión"}</button>{saveMessage && <span role="status">{saveMessage}</span>}
      </div>}
      {model === "contractual" && <p className="projection-lot-diagnostics">El escenario parte del valor de la posición en su última fotografía. Si ese valor es MTM, puede diferir de la curva contractual y del importe a cobrar. Usa una tasa anual constante y días corridos ACT/365,25; no reproduce el calendario de 252 días hábiles brasileños. Los flujos por unidad suponen que la cantidad se mantiene constante salvo amortizaciones declaradas. En títulos con amortizaciones no se calcula el neto sin una base fiscal suficiente.</p>}
      {shadow && data.acquisition_lot_diagnostics && <p className="projection-lot-diagnostics" role="status"><strong>Lotes de adquisición para la tasa histórica:</strong> {data.acquisition_lot_diagnostics.used_lots} usados de {data.acquisition_lot_diagnostics.active_lots} activos. {data.acquisition_lot_diagnostics.no_current_position > 0 && `${data.acquisition_lot_diagnostics.no_current_position} sin título vigente compatible. `}{data.acquisition_lot_diagnostics.ambiguous_position > 0 && `${data.acquisition_lot_diagnostics.ambiguous_position} ambiguos entre cuentas. `}{data.acquisition_lot_diagnostics.account_unresolved > 0 && `${data.acquisition_lot_diagnostics.account_unresolved} con cuenta sin resolver. `}{data.acquisition_lot_diagnostics.invalid_or_not_historical > 0 && `${data.acquisition_lot_diagnostics.invalid_or_not_historical} fuera del período histórico válido.`} Solo los lotes válidos contribuyen a la proyección PostgreSQL.</p>}
      <div className="fixed-income-metrics">
        <div><small>Valor atual coberto</small><strong>{money.format(summary.coveredCurrent / 100)}</strong><span>{summary.projectedCount} de {items.length} títulos</span></div>
        <div><small>{model === "contractual" ? "Principal bruto al vencimiento" : "Estimativa nos vencimentos"}</small><strong>{summary.projectedCount ? money.format(summary.coveredProjected / 100) : model === "contractual" ? "Faltan condiciones" : "Aguardando histórico"}</strong><span>{model === "contractual" ? "cupones y amortizaciones se muestran por separado" : "cada título em sua própria data"}</span></div>
        <div><small>{model === "contractual" ? "Principal neto ilustrativo" : "Crescimento estimado"}</small><strong className={model === "contractual" ? "positive" : summary.gain >= 0 ? "positive" : "negative"}>{model === "contractual" ? summary.netProjectedCount ? money.format((summary.netProjected ?? 0) / 100) : "Neto no disponible" : summary.projectedCount ? money.format(summary.gain / 100) : "—"}</strong><span>{model === "contractual" ? `${summary.netProjectedCount} títulos con escenario tributario explícito` : "antes de impuestos y flujos"}</span></div>
        <div><small>Cobertura do modelo</small><strong>{percent.format(summary.coverage)}</strong><span>do valor atual de renda fixa</span></div>
      </div>
      <div className="fixed-income-table-wrap matrix-wrap">
        <table className="fixed-income-table fixed-income-matrix">
          <thead>
            <tr><th className="matrix-label" rowSpan={2}>Emissor / título</th>{years.map((year) => {
              const expanded = expandedYears.has(year.year);
              const span = expanded ? Math.max(1, year.months.length) : 1;
              return <th key={year.year} colSpan={span} className="matrix-year"><button type="button" aria-expanded={expanded} onClick={() => toggle(setExpandedYears, expandedYears, year.year)}>{year.year}<span>{expanded ? " −" : " +"}</span></button></th>;
            })}</tr>
            <tr>{years.flatMap((year) => expandedYears.has(year.year)
              ? year.months.map((month) => <th key={month.key} className="matrix-month">{month.label}<small className="matrix-cutoff">Até {date(month.date)}</small></th>)
              : [<th key={`${year.year}-annual`} className="matrix-month">Ano<small className="matrix-cutoff">Até {date(year.annual.date)}</small></th>])}</tr>
          </thead>
          <tbody>{issuerGroups.map((group) => {
            const expanded = expandedIssuers.has(group.key);
            return <Fragment key={group.key}>
              <tr key={`${group.key}-issuer`} className="matrix-issuer-row">
                <td className="matrix-label"><button type="button" aria-expanded={expanded} onClick={() => toggle(setExpandedIssuers, expandedIssuers, group.key)}><span>{expanded ? "▾" : "▸"}</span><strong>{group.issuer}</strong></button><small>{group.owner} · {group.items.length} títulos</small></td>
                {columns.map((column) => <td key={`${group.key}-${column.key}`}><ValueCell cashflowLabel={model === "contractual" ? "Flujos" : "Venc."} value={model === "contractual" ? contractualSummary(group.items, column.start, column.date) : summarizeFixedIncomePeriod(group.items, column.start, column.date)} /></td>)}
              </tr>
              {expanded && group.items.map((item) => <tr key={`${group.key}-${item.institution}-${item.account ?? "pending"}-${item.instrument_code}`} className="matrix-instrument-row">
                <td className="matrix-label"><span className="matrix-instrument-name"><strong>{item.instrument_code}</strong><small>{item.product_name} · vence {date(item.maturity_date)}</small><small>{item.institution || "Custódia pendente"}{item.account ? ` · conta ${item.account}` : " · conta não identificada"}</small><small>Referência: {date(item.reference_date)}</small><small>Taxa histórica: {item.annualizedReturn === null ? "indisponível" : percent.format(item.annualizedReturn)} · {item.observationCount} observações · {date(item.firstDate)} a {date(item.lastDate)}</small>{model === "contractual" && item.contractual?.status === "complete" && <><small>Escenario contractual: {item.contractual.rate_pct === null ? `flujos explícitos; saldo sin capitalizar (${item.contractual.indexer} ${item.contractual.indexer_assumption_pct ?? ""}% solo informativo)` : percent.format(item.contractual.rate_pct / 100)} · revisión {item.contractual.revision}</small><small>Al vencimiento: bruto {money.format((item.contractual.gross_maturity_cents ?? 0) / 100)} · neto ilustrativo {item.contractual.net_maturity_cents === null ? "no disponible" : money.format(item.contractual.net_maturity_cents / 100)}</small><small>Flujos brutos fechados: {money.format((item.contractual.gross_cashflows_cents ?? 0) / 100)} · netos {item.contractual.net_cashflows_cents === null ? "no disponibles" : money.format(item.contractual.net_cashflows_cents / 100)}</small><small>Fuente: {item.contractual.source_document_id} · {item.contractual.source_locator}</small></>}{model === "contractual" && item.contractual?.status !== "complete" && <small className="projection-warning">Proyección incompleta: {item.contractual?.missing.join(", ") || "faltan términos/evidencia"}.</small>}<small>Confiabilidade histórica: {confidenceName(item.confidence)}</small><small>Fuentes históricas: {item.observation_sources.map(sourceName).join(", ") || "sem observações"}</small>{item.has_mixed_valuation_methods && <small className="projection-warning">A série alterna MTM e curva B3.</small>}{item.has_unverified_sheet_source && <small className="projection-warning">O custo com origem na planilha foi excluído da taxa até confirmar o mapeamento; revisar data e preço de compra.</small>}{item.excluded_observation_sources.map((source) => <small key={source}>Custo excluído: {sourceName(source)}</small>)}{item.reason && <small>{item.reason}</small>}</span></td>
                {columns.map((column) => <td key={`${item.instrument_code}-${column.key}`}><ValueCell cashflowLabel={model === "contractual" ? "Flujos" : "Venc."} value={model === "contractual" ? contractualPeriod(item, column.start, column.date) : fixedIncomePeriodValue(item, column.start, column.date)} /></td>)}
              </tr>)}
            </Fragment>;
          })}</tbody>
        </table>
        {!!issuerGroups.length && !years.length && <p className="projection-empty">Sem datas válidas para construir o calendário de projeção.</p>}
        {!issuerGroups.length && <p className="projection-empty">Nenhum título de renda fixa para este investidor.</p>}
      </div>
      <p className="projection-method"><strong>Leitura:</strong> o valor principal da célula é o saldo proyectado no cierre del período; “Venc.” separa títulos que vencen y “Flujos” muestra pagos contractuales. Los años usan saldo de cierre. Los períodos sin cobertura no equivalen a cero. {model === "historical" ? <>La tasa histórica se compone hasta el vencimiento. {data.methodology} No es la tasa contratada y no incluye impuestos, cupones ni amortizaciones.</> : <>El método contractual usa tasas y flujos explícitos documentados; para activos indexados aplica la relación seleccionada al supuesto anual del índice. El impuesto plano indicado es un escenario ilustrativo, no un cálculo tributario definitivo. {data.methodology}</>} {shadow && data.cost_basis_diagnostics && ` Precios de la planilla verificados: ${data.cost_basis_diagnostics.verified} de ${data.cost_basis_diagnostics.google_sheet}; ${data.cost_basis_diagnostics.superseded_by_acquisition_lot} títulos usan lotes de adquisición revisados.`}</p>
    </>}
  </section>;
}
