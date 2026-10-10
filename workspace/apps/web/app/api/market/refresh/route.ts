import { env } from "cloudflare:workers";
import { authenticatedUserId } from "@/lib/reviews";
import { loadAvenuePortfolio, fetchLatestPtax } from "@/lib/avenue-portfolio";
import { ensureValuationSchema, normalizedCode } from "@/lib/valuation";
import { downloadLatestCotahist } from "@/lib/cotahist";
import { fetchPublicUsQuotes } from "@/lib/us-market";

export const dynamic = "force-dynamic";

type Stored = { payload: string };
type Quote = { market: "B3" | "US"; symbol: string; currency: "BRL" | "USD"; price: number; provider: string; quotedAt: string };

async function pendingUsSymbols(userId: string, symbols: string[], automatic: boolean) {
  if (!automatic) return symbols;
  const stored = await env.DB.prepare(`SELECT symbol, updated_at FROM market_quotes
    WHERE user_id=? AND market='US'`).bind(userId).all<{ symbol: string; updated_at: string }>();
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  const fresh = new Set(stored.results
    .filter((row) => Date.parse(row.updated_at) >= cutoff)
    .map((row) => normalizedCode(row.symbol)));
  return symbols.filter((symbol) => !fresh.has(symbol));
}

export async function POST(request: Request) {
  const userId = authenticatedUserId(request);
  if (!userId) return Response.json({ detail: "Autenticação necessária." }, { status: 401 });
  const body = await request.json().catch(() => ({})) as { automatic?: boolean };
  const automatic = body.automatic === true;
  await ensureValuationSchema();
  const stored = await env.DB.prepare(`SELECT r.payload FROM import_records r JOIN imports i ON i.id=r.import_id
    WHERE i.user_id=? AND i.status='processed' AND i.file_type='positions' AND r.record_kind='position'
      AND i.id=(SELECT latest.id FROM imports latest WHERE latest.user_id=i.user_id AND latest.owner=i.owner
        AND latest.file_type='positions' AND latest.status='processed'
        ORDER BY latest.reference_date DESC, latest.created_at DESC, latest.rowid DESC LIMIT 1) LIMIT 1000`).bind(userId).all<Stored>();
  const b3 = new Set<string>();
  for (const row of stored.results) {
    try {
      const item = JSON.parse(row.payload) as Record<string, unknown>;
      if (["equity", "bdr", "etf", "fund"].includes(String(item.asset_class))) {
        const code = normalizedCode(item.instrument_code);
        if (/^[A-Z]{4}\d{1,2}[A-Z]?$/.test(code)) b3.add(code);
      }
    } catch { /* invalid rows stay excluded */ }
  }
  const avenue = await loadAvenuePortfolio(userId);
  const us = Array.from(new Set(avenue.positions
    .filter((item) => item.asset_class === "international_equity")
    .map((item) => normalizedCode(item.instrument_code))
    .filter((code) => /^[A-Z.]{1,10}$/.test(code))));
  const errors: string[] = [];
  const quotes: Quote[] = [];
  const usPending = await pendingUsSymbols(userId, us, automatic);
  let b3Date: string | null = null;
  let usFailed = 0;
  let fxUpdated = 0;
  const tasks: Promise<void>[] = [
    fetchLatestPtax().then(async (ptax) => {
      if (!ptax || !Number.isFinite(ptax.rate) || ptax.rate<=0) { errors.push('ptax_unavailable'); return; }
      const result = await env.DB.prepare(`INSERT INTO fx_observations(user_id,pair,rate,quoted_at,provider)
        VALUES (?,'USD/BRL',?,?,'BCB_PTAX') ON CONFLICT(user_id,pair,quoted_at,provider)
        DO UPDATE SET rate=excluded.rate WHERE rate<>excluded.rate`)
        .bind(userId,ptax.rate,ptax.date).run();
      fxUpdated = result.meta.changes;
    }).catch(()=>{errors.push('ptax_unavailable');}),
    fetchPublicUsQuotes(usPending).then((result) => {
      quotes.push(...result.quotes);
      usFailed = result.failed;
      if (result.failed) errors.push("nasdaq_partial");
    }).catch(() => {errors.push("nasdaq_public");}),
  ];
  if (!automatic) {
    tasks.push(downloadLatestCotahist(Array.from(b3))
      .then((result) => { b3Date = result.date; quotes.push(...result.quotes); })
      .catch(() => {errors.push("b3_cotahist");}));
  }
  await Promise.all(tasks);
  if (quotes.length) {
    await env.DB.batch(quotes.map((quote) => env.DB.prepare(`INSERT INTO market_quotes
      (user_id, market, symbol, currency, price, provider, quoted_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, market, symbol) DO UPDATE SET currency=excluded.currency, price=excluded.price,
        provider=excluded.provider, quoted_at=excluded.quoted_at, updated_at=CURRENT_TIMESTAMP
        WHERE excluded.quoted_at>=market_quotes.quoted_at`)
      .bind(userId, quote.market, quote.symbol, quote.currency, quote.price, quote.provider, quote.quotedAt)));
  }
  return Response.json({
    updated: quotes.length + fxUpdated,
    fx_updated: fxUpdated,
    requested: { b3: automatic ? 0 : b3.size, us: usPending.length, us_total: us.length },
    sources: { b3_date: b3Date, us_provider: "public_no_key", automatic },
    configured: { b3: true, us: true, requires_api_key: false },
    us_failed: usFailed,
    errors,
  });
}
