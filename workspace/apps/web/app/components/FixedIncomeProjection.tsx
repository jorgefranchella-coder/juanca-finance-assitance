"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { buildFixedIncomeMatrixYears, fixedIncomePeriodValue, summarizeFixedIncomePeriod, type ProjectionPeriodValue } from "@/lib/fixed-income-projection";

type ProjectionItem = {
  owner: string; account: string | null; instrument_code: string; product_name: string; institution: string; issuer: string;
  maturity_date: string; reference_date: string; quantity: number; current_unit_price: number;
  current_value_cents: number; projected_value_cents: number | null; projected_gain_cents: number | null;
  observationCount: number; firstDate: string; lastDate: string; elapsedDays: number;
  periodReturn: number | null; annualizedReturn: number | null;
  confidence: "high" | "medium" | "low" | "insufficient"; reason: string | null;
};
type ProjectionResponse = {
  reference_date: string;
  summary: { total_current_cents: number; covered_current_cents: number; covered_projected_cents: number;
    projected_gain_cents: number; coverage: number; projected_count: number; total_count: number };
  items: ProjectionItem[];
  methodology: string;
};
type IssuerGroup = { key: string; owner: string; issuer: string; items: ProjectionItem[] };

const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const percent = new Intl.NumberFormat("pt-BR", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 2 });
function date(value: string) { return value ? value.split("-").reverse().join("/") : "—"; }

function ValueCell({ value }: { value: ProjectionPeriodValue }) {
  const labels = { projected: "Saldo projetado", maturity: "Vencimento", matured: "Vencido",
    insufficient_data: "Faltam dados", outside_coverage: "Sem cobertura", conflict: "Em revisão" };
  return <span className="matrix-value">
    {value.balance_cents === null ? <span className="matrix-empty">{labels[value.status]}</span>
      : value.status === "matured" ? <span className="matrix-empty">Vencido</span>
      : <strong>{money.format(value.balance_cents / 100)}</strong>}
    {value.maturity_cents !== null && value.maturity_cents > 0 && <small>Venc. {money.format(value.maturity_cents / 100)}</small>}
    {value.partial && value.balance_cents !== null && <small>Parcial</small>}
    {value.reason && <details className="matrix-reason"><summary>Motivo</summary><span>{value.reason}</span></details>}
  </span>;
}

export default function FixedIncomeProjection() {
  const [data, setData] = useState<ProjectionResponse | null>(null);
  const [owner, setOwner] = useState("Todos");
  const [error, setError] = useState("");
  const [expandedYears, setExpandedYears] = useState<Set<string>>(() => new Set());
  const [expandedIssuers, setExpandedIssuers] = useState<Set<string>>(() => new Set());
  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/portfolio/fixed-income-projection", { cache: "no-store" });
      const result = await response.json() as ProjectionResponse & { detail?: string };
      if (!response.ok) throw new Error(result.detail ?? "Não foi possível calcular a projeção.");
      setData(result); setError("");
    } catch (loadError) { setError(loadError instanceof Error ? loadError.message : "Não foi possível calcular a projeção."); }
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    window.addEventListener("portfolio-data-updated", load);
    return () => { window.clearTimeout(timer); window.removeEventListener("portfolio-data-updated", load); };
  }, [load]);
  const items = useMemo(() => (data?.items ?? []).filter((item) => owner === "Todos" || item.owner === owner), [data, owner]);
  const summary = useMemo(() => {
    const covered = items.filter((item) => item.projected_value_cents !== null);
    const totalCurrent = items.reduce((sum, item) => sum + item.current_value_cents, 0);
    const coveredCurrent = covered.reduce((sum, item) => sum + item.current_value_cents, 0);
    const coveredProjected = covered.reduce((sum, item) => sum + (item.projected_value_cents ?? 0), 0);
    return { totalCurrent, coveredCurrent, coveredProjected, gain: coveredProjected - coveredCurrent,
      coverage: totalCurrent ? coveredCurrent / totalCurrent : 0, projectedCount: covered.length };
  }, [items]);
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

  return <section className="panel fixed-income-projection" id="renda-fixa">
    <div className="panel-title fixed-income-title">
      <div><p>Projeção baseada no histórico</p><h2>Renda fixa até o vencimento</h2><span>Expanda um ano para ver os meses; expanda um emissor para ver cada título.</span></div>
      <label>Investidor<select value={owner} onChange={(event) => { setOwner(event.target.value); setExpandedIssuers(new Set()); }}><option>Todos</option><option>Jorge</option><option>Julia</option></select></label>
    </div>
    {error ? <p className="projection-error">{error}</p> : !data ? <p className="projection-loading">Calculando histórico de preços…</p> : <>
      <div className="fixed-income-metrics">
        <div><small>Valor atual coberto</small><strong>{money.format(summary.coveredCurrent / 100)}</strong><span>{summary.projectedCount} de {items.length} títulos</span></div>
        <div><small>Estimativa nos vencimentos</small><strong>{summary.projectedCount ? money.format(summary.coveredProjected / 100) : "Aguardando histórico"}</strong><span>cada título em sua própria data</span></div>
        <div><small>Crescimento estimado</small><strong className={summary.gain >= 0 ? "positive" : "negative"}>{summary.projectedCount ? money.format(summary.gain / 100) : "—"}</strong><span>antes de impostos e fluxos</span></div>
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
                {columns.map((column) => <td key={`${group.key}-${column.key}`}><ValueCell value={summarizeFixedIncomePeriod(group.items, column.start, column.date)} /></td>)}
              </tr>
              {expanded && group.items.map((item) => <tr key={`${group.key}-${item.institution}-${item.account ?? "pending"}-${item.instrument_code}`} className="matrix-instrument-row">
                <td className="matrix-label"><span className="matrix-instrument-name"><strong>{item.instrument_code}</strong><small>{item.product_name} · vence {date(item.maturity_date)}</small><small>{item.institution || "Custódia pendente"}{item.account ? ` · conta ${item.account}` : " · conta não identificada"}</small><small>Referência: {date(item.reference_date)}</small>{item.reason && <small>{item.reason}</small>}</span></td>
                {columns.map((column) => <td key={`${item.instrument_code}-${column.key}`}><ValueCell value={fixedIncomePeriodValue(item, column.start, column.date)} /></td>)}
              </tr>)}
            </Fragment>;
          })}</tbody>
        </table>
        {!!issuerGroups.length && !years.length && <p className="projection-empty">Sem datas válidas para construir o calendário de projeção.</p>}
        {!issuerGroups.length && <p className="projection-empty">Nenhum título de renda fixa para este investidor.</p>}
      </div>
      <p className="projection-method"><strong>Leitura:</strong> o valor principal da célula é o saldo projetado no fim do período; “Venc.” mostra separadamente os títulos que vencem naquele período. O saldo anual é o saldo no corte; os vencimentos anuais somam os fluxos dos meses. Períodos sem cobertura são identificados e não equivalem a saldo zero. A taxa histórica de cada ativo é composta até o vencimento. {data.methodology} Não é a taxa contratada e não inclui impostos, cupons ou amortizações.</p>
    </>}
  </section>;
}
