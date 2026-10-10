"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type ProjectionItem = {
  owner: string; instrument_code: string; product_name: string; institution: string;
  maturity_date: string; reference_date: string; current_value_cents: number;
  projected_value_cents: number | null; projected_gain_cents: number | null;
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

const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const percent = new Intl.NumberFormat("pt-BR", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 2 });
function date(value: string) { return value ? value.split("-").reverse().join("/") : "—"; }

export default function FixedIncomeProjection() {
  const [data, setData] = useState<ProjectionResponse | null>(null);
  const [owner, setOwner] = useState("Todos");
  const [error, setError] = useState("");
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

  return <section className="panel fixed-income-projection" id="renda-fixa">
    <div className="panel-title fixed-income-title">
      <div><p>Projeção baseada no histórico</p><h2>Renda fixa até o vencimento</h2><span>Compara preços observados e extrapola a rentabilidade efetiva somente quando há histórico suficiente.</span></div>
      <label>Investidor<select value={owner} onChange={(event) => setOwner(event.target.value)}><option>Todos</option><option>Jorge</option><option>Julia</option></select></label>
    </div>
    {error ? <p className="projection-error">{error}</p> : !data ? <p className="projection-loading">Calculando histórico de preços…</p> : <>
      <div className="fixed-income-metrics">
        <div><small>Valor atual coberto</small><strong>{money.format(summary.coveredCurrent / 100)}</strong><span>{summary.projectedCount} de {items.length} títulos</span></div>
        <div><small>Estimativa nos vencimentos</small><strong>{summary.projectedCount ? money.format(summary.coveredProjected / 100) : "Aguardando histórico"}</strong><span>cada título em sua própria data</span></div>
        <div><small>Crescimento estimado</small><strong className={summary.gain >= 0 ? "positive" : "negative"}>{summary.projectedCount ? money.format(summary.gain / 100) : "—"}</strong><span>antes de impostos e fluxos</span></div>
        <div><small>Cobertura do modelo</small><strong>{percent.format(summary.coverage)}</strong><span>do valor atual de renda fixa</span></div>
      </div>
      <div className="fixed-income-table-wrap">
        <table className="fixed-income-table"><thead><tr><th>Ativo</th><th>Vencimento</th><th>Histórico</th><th>Rentabilidade a.a.</th><th>Valor atual</th><th>Projeção</th></tr></thead>
          <tbody>{items.map((item) => <tr key={`${item.owner}-${item.instrument_code}`}>
            <td><strong>{item.instrument_code}</strong><span>{item.owner} · {item.product_name}</span></td>
            <td>{date(item.maturity_date)}</td>
            <td>{item.observationCount} preços<span>{item.firstDate ? `${date(item.firstDate)} a ${date(item.lastDate)}` : item.reason}</span></td>
            <td>{item.annualizedReturn === null ? <em>Aguardando histórico</em> : <><strong>{percent.format(item.annualizedReturn)}</strong><span className={`confidence ${item.confidence}`}>{item.confidence === "high" ? "alta" : item.confidence === "medium" ? "média" : "baixa"} confiança</span></>}</td>
            <td>{money.format(item.current_value_cents / 100)}</td>
            <td>{item.projected_value_cents === null ? <em title={item.reason ?? "Histórico insuficiente"}>—</em> : <><strong>{money.format(item.projected_value_cents / 100)}</strong><span className={(item.projected_gain_cents ?? 0) >= 0 ? "gain" : "loss"}>{(item.projected_gain_cents ?? 0) >= 0 ? "+" : ""}{money.format((item.projected_gain_cents ?? 0) / 100)}</span></>}</td>
          </tr>)}</tbody>
        </table>
        {!items.length && <p className="projection-empty">Nenhum título de renda fixa para este investidor.</p>}
      </div>
      <p className="projection-method"><strong>Método:</strong> {data.methodology} Históricos inferiores a 30 dias geram estimativas de baixa confiança. Não é a taxa contratada e não inclui impostos, cupons ou amortizações.</p>
    </>}
  </section>;
}
