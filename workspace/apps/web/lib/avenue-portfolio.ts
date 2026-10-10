import { env } from "cloudflare:workers";

import type { AvenuePosition, AvenueTrade } from "@/lib/avenue";

type Stored = { owner: string; reference_date: string; payload: string };

export type ConsolidatedAvenuePosition = AvenuePosition & {
  market_value_cents: number | null;
  price_source: "avenue_statement" | "avenue_confirmation";
  price_as_of: string;
};

export type PtaxRate = { rate: number; date: string } | null;

function odataDate(date: Date) {
  return `${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}-${date.getUTCFullYear()}`;
}

export async function fetchLatestPtax(): Promise<PtaxRate> {
  try {
    const end = new Date();
    const start = new Date(end.getTime() - 14 * 86_400_000);
    const base = "https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoDolarPeriodo(dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)";
    const url = `${base}?@dataInicial='${odataDate(start)}'&@dataFinalCotacao='${odataDate(end)}'&%24top=100&%24orderby=dataHoraCotacao%20desc&%24format=json`;
    const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(12000) });
    if (!response.ok) return null;
    const data = await response.json() as { value?: { cotacaoVenda?: number; dataHoraCotacao?: string }[] };
    const item = data.value?.find((candidate) => Number.isFinite(Number(candidate.cotacaoVenda)));
    return item ? { rate: Number(item.cotacaoVenda), date: String(item.dataHoraCotacao ?? "").slice(0, 10) } : null;
  } catch {
    return null;
  }
}

export async function loadAvenuePortfolio(userId: string) {
  const statements = await env.DB.prepare(`
    SELECT i.owner, i.reference_date, r.payload
    FROM import_records r JOIN imports i ON i.id = r.import_id
    WHERE i.user_id = ? AND i.status = 'processed' AND i.file_type = 'avenue_statement'
      AND r.record_kind = 'position'
      AND i.id = (SELECT latest.id FROM imports latest
        WHERE latest.user_id = i.user_id AND latest.owner = i.owner
          AND latest.file_type = 'avenue_statement' AND latest.status = 'processed'
        ORDER BY latest.reference_date DESC, latest.created_at DESC, latest.rowid DESC LIMIT 1)
    ORDER BY i.owner, r.id LIMIT 1000`).bind(userId).all<Stored>();
  const trades = await env.DB.prepare(`
    SELECT i.owner, i.reference_date, r.payload
    FROM import_records r JOIN imports i ON i.id = r.import_id
    WHERE i.user_id = ? AND i.status = 'processed'
      AND (i.file_type = 'avenue_confirmation' OR
        (i.file_type = 'chat_transaction' AND r.payload LIKE '%"currency":"USD"%'))
      AND r.record_kind = 'trade'
    ORDER BY i.reference_date, i.created_at, r.id LIMIT 2000`).bind(userId).all<Stored>();

  const holdings = new Map<string, AvenuePosition>();
  const baseDates = new Map<string, string>();
  for (const row of statements.results) {
    try {
      const item = JSON.parse(row.payload) as AvenuePosition;
      holdings.set(`${item.owner}\0${item.instrument_code}`, { ...item });
      baseDates.set(item.owner, item.reference_date);
    } catch { /* malformed rows remain excluded */ }
  }
  const latestTradeDates = new Map<string, string>();
  for (const row of trades.results) {
    try {
      const trade = JSON.parse(row.payload) as AvenueTrade;
      if (!baseDates.has(trade.owner) || trade.trade_date <= (baseDates.get(trade.owner) ?? "")) continue;
      const key = `${trade.owner}\0${trade.instrument_code}`;
      const existing = holdings.get(key);
      const signedQuantity = trade.side === "buy" ? trade.quantity : -trade.quantity;
      if (existing) {
        existing.quantity = Math.max(0, existing.quantity + signedQuantity);
        existing.unit_price = trade.unit_price;
        existing.market_value_minor = Math.round(existing.quantity * trade.unit_price * 100);
      } else if (trade.side === "buy") {
        holdings.set(key, {
          kind: "position", source: "avenue", owner: trade.owner,
          asset_class: "international_equity", product_name: trade.product_name,
          institution: "Avenue", account: trade.account, instrument_code: trade.instrument_code,
          quantity: trade.quantity, unit_price: trade.unit_price,
          market_value_minor: Math.round(trade.quantity * trade.unit_price * 100),
          currency: "USD", reference_date: baseDates.get(trade.owner) ?? trade.trade_date,
        });
      }
      const cashKey = `${trade.owner}\0USD_CASH`;
      const cash = holdings.get(cashKey);
      if (cash) {
        const delta = trade.side === "sell"
          ? trade.principal_minor - trade.fees_minor
          : -(trade.principal_minor + trade.fees_minor);
        cash.market_value_minor += delta;
        cash.quantity = cash.market_value_minor / 100;
      }
      latestTradeDates.set(key, trade.trade_date);
    } catch { /* malformed rows remain excluded */ }
  }

  const observed = await env.DB.prepare(`SELECT rate,quoted_at AS date FROM fx_observations
    WHERE user_id=? AND pair='USD/BRL' AND quoted_at<=date('now') ORDER BY quoted_at DESC,id DESC LIMIT 1`)
    .bind(userId).first<{ rate: number; date: string }>();
  const ptax: PtaxRate = observed ?? null;
  const positions: ConsolidatedAvenuePosition[] = Array.from(holdings.entries())
    .filter(([, item]) => item.quantity > 0.000001)
    .map(([key, item]) => ({
      ...item,
      market_value_cents: ptax ? Math.round(item.market_value_minor * ptax.rate) : null,
      price_source: latestTradeDates.has(key) ? "avenue_confirmation" : "avenue_statement",
      price_as_of: latestTradeDates.get(key) ?? item.reference_date,
    }));
  return { positions, ptax };
}
