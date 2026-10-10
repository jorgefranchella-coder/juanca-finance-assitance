export type UsMarketQuote = {
  market: "US";
  symbol: string;
  currency: "USD";
  price: number;
  provider: "yahoo_public" | "nasdaq_public";
  quotedAt: string;
};

type YahooPayload = {
  chart?: {
    result?: Array<{
      meta?: {
        regularMarketPrice?: number | null;
        regularMarketTime?: number | null;
      };
    }> | null;
  };
};

type NasdaqPayload = {
  data?: {
    primaryData?: {
      lastSalePrice?: string | null;
      lastTradeTimestamp?: string | null;
    } | null;
  } | null;
};

function priceFromNasdaq(value: unknown) {
  const parsed = Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function quoteDate(value: unknown) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

function providerSymbol(symbol: string) {
  return symbol.replaceAll(".", "-");
}

export async function fetchNasdaqQuote(
  symbol: string,
  fetcher: typeof fetch = fetch,
): Promise<UsMarketQuote | null> {
  const encoded = encodeURIComponent(providerSymbol(symbol));
  for (const assetClass of ["stocks", "etf"]) {
    const response = await fetcher(`https://api.nasdaq.com/api/quote/${encoded}/info?assetclass=${assetClass}`, {
      signal: AbortSignal.timeout(5_000),
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (compatible; PatrimonioFamiliar/1.0)",
      },
    });
    if (!response.ok) continue;
    const body = await response.json() as NasdaqPayload;
    const price = priceFromNasdaq(body.data?.primaryData?.lastSalePrice);
    if (price === null) continue;
    return {
      market: "US",
      symbol,
      currency: "USD",
      price,
      provider: "nasdaq_public",
      quotedAt: quoteDate(body.data?.primaryData?.lastTradeTimestamp),
    };
  }
  return null;
}

export async function fetchYahooQuote(
  symbol: string,
  fetcher: typeof fetch = fetch,
): Promise<UsMarketQuote | null> {
  const encoded = encodeURIComponent(providerSymbol(symbol));
  const response = await fetcher(`https://query2.finance.yahoo.com/v8/finance/chart/${encoded}?range=5d&interval=1d`, {
    signal: AbortSignal.timeout(5_000),
    headers: {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (compatible; PatrimonioFamiliar/1.0)",
    },
  });
  if (!response.ok) return null;
  const body = await response.json() as YahooPayload;
  const meta = body.chart?.result?.[0]?.meta;
  const price = Number(meta?.regularMarketPrice);
  if (!Number.isFinite(price) || price <= 0) return null;
  const timestamp = Number(meta?.regularMarketTime);
  return {
    market: "US",
    symbol,
    currency: "USD",
    price,
    provider: "yahoo_public",
    quotedAt: Number.isFinite(timestamp) && timestamp > 0
      ? new Date(timestamp * 1_000).toISOString()
      : new Date().toISOString(),
  };
}

export async function fetchPublicUsQuote(symbol: string, fetcher: typeof fetch = fetch) {
  try {
    const yahoo = await fetchYahooQuote(symbol, fetcher);
    if (yahoo) return yahoo;
  } catch { /* fall through to the secondary source */ }
  return fetchNasdaqQuote(symbol, fetcher);
}

export async function fetchPublicUsQuotes(
  symbols: string[],
  fetcher: typeof fetch = fetch,
  concurrency = 8,
) {
  const quotes: UsMarketQuote[] = [];
  let failed = 0;
  for (let index = 0; index < symbols.length; index += concurrency) {
    const batch = symbols.slice(index, index + concurrency);
    const results = await Promise.all(batch.map(async (symbol) => {
      try {
        return await fetchPublicUsQuote(symbol, fetcher);
      } catch {
        return null;
      }
    }));
    results.forEach((quote) => quote ? quotes.push(quote) : failed += 1);
  }
  return { quotes, failed };
}
