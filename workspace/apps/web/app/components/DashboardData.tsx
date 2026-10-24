"use client";

import { useCallback, useEffect, useState } from "react";

type Summary = { import_count: number; review_count: number };

type Position = {
  owner: string;
  account: string | null;
  asset_class: string;
  product_name: string;
  institution: string;
  instrument_code: string;
  quantity: number;
  market_value_cents: number | null;
  maturity_date: string | null;
  reference_date: string;
  currency?: "BRL" | "USD";
  current_unit_price?: number;
  price_as_of?: string;
  source?: string;
  average_unit_cost?: number | null;
  cost_currency?: "BRL" | "USD" | null;
  cost_basis_cents?: number | null;
  unrealized_pnl_cents?: number | null;
  cost_status?: "available" | "missing" | "ambiguous_position";
};
type PositionsResponse = {
  count: number;
  total_value_cents: number;
  positions: Position[];
};

type DashboardResponse = {
  valuation_complete?: boolean;
  unvalued_count?: number;
  total_value_cents: number;
  owners: { owner: string; value_cents: number }[];
  allocation: { key: string; label: string; value_cents: number; share: number }[];
  reference_date: string;
  activity: { key: string; label: string; count: number; value_cents: number }[];
  activity_period: { from: string; to: string };
  coverage: "b3_only" | "b3_avenue" | "b3_pension" | "b3_avenue_pension";
  sources?: { avenue_positions: number; pension_positions?: number; ptax: { rate: number | string; date: string } | null; quote_status: string; us_quote_count?: number; latest_us_quote?: string | null };
};

const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

function shortDate(value: string) {
  if (!value) return "—";
  return value.split("-").reverse().join("/");
}

function formatPtaxRate(value: number | string) {
  const rate = typeof value === "number" ? value : Number(value);
  return Number.isFinite(rate) ? rate.toFixed(4).replace(".", ",") : "—";
}

function usePortfolioSummary() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState(false);
  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/portfolio/summary", { cache: "no-store" });
      if (!response.ok) throw new Error("summary unavailable");
      setSummary(await response.json() as Summary);
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void load(), 0);
    window.addEventListener("portfolio-data-updated", load);
    return () => {
      window.clearTimeout(initialLoad);
      window.removeEventListener("portfolio-data-updated", load);
    };
  }, [load]);
  return { summary, error, load };
}

export function DataQualitySummary() {
  const { summary, error } = usePortfolioSummary();
  if (error) return <span><i className="warn" />Dados indisponíveis</span>;
  return (
    <>
      <span><i className="ok" />{summary ? summary.import_count : "…"} arquivos processados</span>
      <span><i className={summary?.review_count ? "warn" : "ok"} />{summary ? summary.review_count : "…"} revisões pendentes</span>
    </>
  );
}

export function DashboardMetrics() {
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [error, setError] = useState(false);
  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/portfolio/dashboard", { cache: "no-store" });
      if (!response.ok) throw new Error("dashboard unavailable");
      setData(await response.json() as DashboardResponse);
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => {
      void load();
    }, 0);
    window.addEventListener("portfolio-data-updated", load);
    return () => {
      window.clearTimeout(initialLoad);
      window.removeEventListener("portfolio-data-updated", load);
    };
  }, [load]);

  return (
    <>
      <section className="hero-grid">
        <article className="net-worth-card">
          <div className="metric-heading"><p>{data?.coverage === "b3_avenue_pension" ? "Patrimônio B3 + Avenue + previdência" : data?.coverage === "b3_pension" ? "Patrimônio B3 + previdência" : data?.coverage === "b3_avenue" ? "Patrimônio B3 + Avenue" : "Subtotal coberto pela B3"}</p><span className="coverage-badge">{data?.valuation_complete===false?"Valoração incompleta":"Cobertura parcial"}</span></div>
          <strong>{error ? "Indisponível" : data ? money.format(data.total_value_cents / 100) : "Carregando…"}</strong>
          <div className="trend">{data ? `Posição-base de ${shortDate(data.reference_date)}${data.sources?.ptax ? ` · USD/BRL PTAX ${formatPtaxRate(data.sources.ptax.rate)} (${shortDate(data.sources.ptax.date)})` : ""}` : "Calculando a posição mais recente…"}</div>
          <p>{data?.valuation_complete===false?"Subtotal dos ativos valorados. Há posições sem conversão ou com pendências de conciliação.":""}</p>
          <div className="owners">
            {(data?.owners.length ? data.owners : [{ owner: "Jorge", value_cents: 0 }, { owner: "Julia", value_cents: 0 }]).map((item) => (
              <div key={item.owner}><small>{item.owner}</small><b>{data ? money.format(item.value_cents / 100) : "—"}</b></div>
            ))}
          </div>
        </article>
        <article className="quality-card">
          <div className="card-heading"><div><p>Qualidade dos dados</p><strong>Conciliação em andamento</strong></div><span className="score">{data?.valuation_complete===false?"!":"—"}</span></div>
          <div className="quality-line"><span className="quality-fill" /></div>
          <div className="quality-items"><DataQualitySummary /><span><i className={data?.sources?.us_quote_count ? "ok" : "warn"} />{data?.sources?.us_quote_count ? `${data.sources.us_quote_count} cotações dos EUA automáticas` : "Cotações automáticas pendentes"}</span></div>
        </article>
      </section>

      <section className="detail-grid" id="carteira">
        <article className="panel allocation-panel">
          <div className="panel-title"><div><p>Alocação consolidada</p><h2>Por classe de ativo</h2></div><PortfolioDialog /></div>
          {error ? <p className="metric-error">Não foi possível calcular a alocação.</p> : (
            <div className="allocation-list">
              {(data?.allocation ?? []).map((item, index) => (
                <div className="allocation-row" key={item.key}>
                  <div className="allocation-label"><span>{item.label}</span><b>{money.format(item.value_cents / 100)}</b></div>
                  <div className="bar"><span className={`allocation-tone tone-${index % 6}`} style={{ width: `${item.share}%` }} /></div>
                  <small>{item.share.toFixed(1).replace(".", ",")}%</small>
                </div>
              ))}
              {!data && <p className="metric-loading">Calculando alocação…</p>}
            </div>
          )}
        </article>
        <article className="panel activity-panel" id="movimentos">
          <div className="panel-title"><div><p>Atividade importada</p><h2>Extrato B3</h2></div><span className="period">{data ? `${shortDate(data.activity_period.from)} – ${shortDate(data.activity_period.to)}` : "—"}</span></div>
          {error ? <p className="metric-error">Não foi possível calcular a atividade.</p> : (data?.activity ?? []).map((item) => (
            <div className="stat-row" key={item.key}><span>{item.label}</span><b>{item.count}</b><em>{item.value_cents ? money.format(item.value_cents / 100) : "sem valor"}</em></div>
          ))}
          {!data && <p className="metric-loading">Calculando atividade…</p>}
        </article>
      </section>
    </>
  );
}

export function PortfolioDialog() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<PositionsResponse | null>(null);
  const [owner, setOwner] = useState("Todos");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");

  const loadPositions = useCallback(async () => {
    setError("");
    try {
      const response = await fetch("/api/portfolio/positions", { cache: "no-store" });
      if (!response.ok) throw new Error("Não foi possível carregar a carteira.");
      setData(await response.json() as PositionsResponse);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Não foi possível carregar a carteira.");
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  function showPortfolio() {
    setOpen(true);
    void loadPositions();
  }

  const normalized = query.trim().toLocaleLowerCase("pt-BR");
  const positions = (data?.positions ?? []).filter((position) => {
    const ownerMatches = owner === "Todos" || position.owner === owner;
    const queryMatches = !normalized || `${position.instrument_code} ${position.product_name} ${position.institution}`.toLocaleLowerCase("pt-BR").includes(normalized);
    return ownerMatches && queryMatches;
  });
  const filteredTotal = positions.reduce((sum, position) => sum + (position.market_value_cents ?? 0), 0);

  return (
    <>
      <button className="text-button" onClick={showPortfolio}>Ver carteira completa</button>
      {open && (
        <div className="portfolio-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setOpen(false);
        }}>
          <section className="portfolio-dialog" role="dialog" aria-modal="true" aria-labelledby="portfolio-title">
            <header>
              <div><p>POSIÇÕES B3 + AVENUE</p><h2 id="portfolio-title">Carteira completa</h2></div>
              <button className="dialog-close" aria-label="Fechar carteira" onClick={() => setOpen(false)}>×</button>
            </header>
            <div className="portfolio-filters">
              <label>Investidor<select value={owner} onChange={(event) => setOwner(event.target.value)}><option>Todos</option><option>Jorge</option><option>Julia</option></select></label>
              <label>Buscar ativo ou instituição<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Código, produto ou banco" /></label>
              <div><small>Posições exibidas</small><strong>{positions.length}</strong></div>
              <div><small>Valor exibido</small><strong>{money.format(filteredTotal / 100)}</strong></div>
            </div>
            <div className="valuation-toolbar">
              <button className="secondary-button" onClick={() => window.dispatchEvent(new CustomEvent("juanca-action", { detail: { type: "open_postgres_market" } }))}>Atualizar cotizaciones en PostgreSQL</button>
              <span>O preço sombra pode ser atualizado no painel PostgreSQL; esta carteira D1 permanece apenas como referência antes do corte.</span>
            </div>
            {error ? (
              <div className="portfolio-state"><p>{error}</p><button className="secondary-button" onClick={() => void loadPositions()}>Tentar novamente</button></div>
            ) : !data ? (
              <div className="portfolio-state">Carregando carteira…</div>
            ) : (
              <div className="portfolio-table-wrap">
                <table className="portfolio-table">
                  <thead><tr><th>Investidor</th><th>Ativo</th><th>Quantidade</th><th>Preço atual</th><th>Preço médio</th><th>Valor atual</th><th>Lucro / prejuízo</th><th /></tr></thead>
                  <tbody>
                    {positions.map((position, index) => (
                      <tr key={`${position.owner}-${position.instrument_code}-${index}`}>
                        <td>{position.owner}</td>
                        <td><strong>{position.instrument_code || position.product_name}</strong><small>{position.product_name} · {position.institution || "Custodia não identificada"}{position.account ? ` · conta ${position.account}` : " · conta não informada"}</small></td>
                        <td>{position.quantity.toLocaleString("pt-BR")}</td>
                        <td><strong>{position.current_unit_price === undefined ? "—" : new Intl.NumberFormat("pt-BR", { style: "currency", currency: position.currency ?? "BRL" }).format(position.current_unit_price)}</strong><small>{position.source?.replaceAll("_", " ") ?? ""}</small></td>
                        <td>{position.average_unit_cost === null || position.average_unit_cost === undefined ? "—" : new Intl.NumberFormat("pt-BR", { style: "currency", currency: position.cost_currency ?? position.currency ?? "BRL" }).format(position.average_unit_cost)}{position.cost_status === "ambiguous_position" && <small>Custo legado sem conta; precisa de revisão</small>}</td>
                        <td>{position.market_value_cents===null?"Conversão indisponível":money.format(position.market_value_cents / 100)}</td>
                        <td className={position.unrealized_pnl_cents === null || position.unrealized_pnl_cents === undefined ? "" : position.unrealized_pnl_cents >= 0 ? "pnl-positive" : "pnl-negative"}>{position.unrealized_pnl_cents === null || position.unrealized_pnl_cents === undefined ? "—" : money.format(position.unrealized_pnl_cents / 100)}</td>
                        <td><button className="cost-button" onClick={() => window.dispatchEvent(new CustomEvent("juanca-action", { detail: { type: "open_reviews" } }))}>Revisar compras em PostgreSQL</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!positions.length && <p className="portfolio-empty">Nenhuma posição corresponde aos filtros.</p>}
              </div>
            )}
          </section>
        </div>
      )}
    </>
  );
}
