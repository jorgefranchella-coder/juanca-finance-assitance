import { env } from "cloudflare:workers";

type RawPosition = Record<string, unknown> & { raw?: Record<string, unknown> };

function decimal(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim() || value.trim() === "-") return null;
  const raw = value.replace(/R\$/g, "").replace(/\s/g, "");
  const normalized = raw.includes(",") ? raw.replace(/\./g, "").replace(",", ".") : raw;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function b3Valuation(item: RawPosition) {
  const raw = item.raw ?? {};
  const candidates = [
    [raw["Valor Atualizado MTM"], raw["Preço Atualizado MTM"], "b3_mtm"],
    [raw["Valor Atualizado FECHAMENTO"], raw["Preço Atualizado FECHAMENTO"] ?? raw["Preço de Fechamento"], "b3_close"],
    [raw["Valor Atualizado CURVA"], raw["Preço Atualizado CURVA"], "b3_curve"],
    [raw["Valor Atualizado"], raw["Preço de Fechamento"], "b3_position"],
  ] as const;
  for (const [valueRaw, priceRaw, source] of candidates) {
    const value = decimal(valueRaw);
    if (value !== null) {
      return {
        market_value_cents: Math.round(value * 100),
        unit_price: decimal(priceRaw) ?? Number(item.unit_price ?? 0),
        price_source: source,
      };
    }
  }
  return {
    market_value_cents: Number(item.market_value_cents ?? 0),
    unit_price: Number(item.unit_price ?? 0),
    price_source: "b3_position",
  };
}

export async function ensureValuationSchema() {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS cost_basis (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      user_id TEXT NOT NULL, owner TEXT NOT NULL, instrument_code TEXT NOT NULL,
      currency TEXT NOT NULL, quantity REAL NOT NULL, average_unit_cost REAL NOT NULL,
      as_of TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL)`),
    env.DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cost_basis_identity
      ON cost_basis(user_id, owner, instrument_code, currency)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS cost_basis_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      user_id TEXT NOT NULL, request_id TEXT NOT NULL, owner TEXT NOT NULL,
      instrument_code TEXT NOT NULL, currency TEXT NOT NULL, quantity REAL NOT NULL,
      average_unit_cost REAL NOT NULL, as_of TEXT NOT NULL, source TEXT NOT NULL,
      institution TEXT, account TEXT, recorded_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      UNIQUE(user_id, request_id))`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_cost_basis_history_position
      ON cost_basis_history(user_id, owner, instrument_code, recorded_at)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS market_quotes (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      user_id TEXT NOT NULL, market TEXT NOT NULL, symbol TEXT NOT NULL,
      currency TEXT NOT NULL, price REAL NOT NULL, provider TEXT NOT NULL,
      quoted_at TEXT NOT NULL, updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL)`),
    env.DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_market_quotes_identity
      ON market_quotes(user_id, market, symbol)`),
  ]);
}

export function normalizedCode(value: unknown) {
  return String(value ?? "").trim().toUpperCase().replace(/^(BVMF|NASDAQ|NYSE|NYSEARCA):/, "");
}

export type CostBasisRow = {
  owner: string; instrument_code: string; currency: string; quantity: number;
  average_unit_cost: number; as_of: string; source: string;
};

export async function loadCostBasis(userId: string) {
  await ensureValuationSchema();
  const stored = await env.DB.prepare(`SELECT owner, instrument_code, currency, quantity,
    average_unit_cost, as_of, source FROM cost_basis WHERE user_id = ?`)
    .bind(userId).all<CostBasisRow>();
  const costs = new Map(stored.results.map((row) => [
    `${row.owner}\0${normalizedCode(row.instrument_code)}`,
    { ...row, quantity: Number(row.quantity), average_unit_cost: Number(row.average_unit_cost) },
  ]));
  const events = await env.DB.prepare(`SELECT r.payload FROM import_records r
    JOIN imports i ON i.id=r.import_id
    WHERE i.user_id=? AND i.status='processed' AND r.record_kind IN ('trade','movement')
      AND (r.event_type IN ('buy','sell') OR r.payload LIKE '%"side":"buy"%' OR r.payload LIKE '%"side":"sell"%')
    ORDER BY i.reference_date, i.created_at, r.id LIMIT 5000`).bind(userId).all<{ payload: string }>();
  for (const row of events.results) {
    try {
      const item = JSON.parse(row.payload) as Record<string, unknown>;
      const owner = String(item.owner ?? "");
      const code = normalizedCode(item.instrument_code);
      const side = String(item.side ?? item.event_type ?? "");
      const date = String(item.trade_date ?? item.occurred_on ?? "");
      const quantity = Number(item.quantity ?? 0);
      const unitPrice = Number(item.unit_price ?? 0);
      if (!owner || !code || !["buy", "sell"].includes(side) || !date || quantity <= 0) continue;
      const key = `${owner}\0${code}`;
      const current = costs.get(key);
      if (current && date <= current.as_of) continue;
      if (side === "buy" && unitPrice > 0) {
        const currency = String(item.currency ?? "BRL");
        if (!current) {
          costs.set(key, { owner, instrument_code: code, currency, quantity,
            average_unit_cost: unitPrice, as_of: date, source: "broker_note" });
        } else {
          const totalCost = current.average_unit_cost * current.quantity + unitPrice * quantity;
          current.quantity += quantity;
          current.average_unit_cost = totalCost / current.quantity;
          current.as_of = date;
          current.source = `${current.source}+broker_note`;
        }
      } else if (side === "sell" && current) {
        current.quantity = Math.max(0, current.quantity - quantity);
        current.as_of = date;
      }
    } catch { /* malformed events stay excluded */ }
  }
  return costs;
}

export type QuoteRow = { market: string; symbol: string; currency: string; price: number; provider: string; quoted_at: string };

export async function loadQuotes(userId: string) {
  await ensureValuationSchema();
  const stored = await env.DB.prepare(`SELECT market, symbol, currency, price, provider, quoted_at
    FROM market_quotes WHERE user_id = ?`).bind(userId).all<QuoteRow>();
  return new Map(stored.results.map((row) => [
    `${row.market}\0${normalizedCode(row.symbol)}`,
    { ...row, price: Number(row.price) },
  ]));
}
