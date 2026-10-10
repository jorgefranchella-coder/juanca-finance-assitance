import test from "node:test";
import assert from "node:assert/strict";
import { fetchNasdaqQuote, fetchPublicUsQuotes, fetchPublicUsQuote, fetchYahooQuote } from "../lib/us-market.ts";

function response(body, ok = true) {
  return { ok, json: async () => body };
}

test("reads a US stock price and trade date from Nasdaq", async () => {
  const quote = await fetchNasdaqQuote("MSFT", async () => response({
    data: { primaryData: { lastSalePrice: "$493.78", lastTradeTimestamp: "Sep 17, 2026" } },
  }));
  assert.equal(quote?.symbol, "MSFT");
  assert.equal(quote?.price, 493.78);
  assert.equal(quote?.provider, "nasdaq_public");
  assert.match(quote?.quotedAt ?? "", /^2026-09-17T/);
});

test("falls back from stocks to ETFs", async () => {
  const requested = [];
  const quote = await fetchNasdaqQuote("SLV", async (url) => {
    requested.push(String(url));
    if (String(url).includes("assetclass=stocks")) return response({}, false);
    return response({ data: { primaryData: { lastSalePrice: "$59.93", lastTradeTimestamp: "Sep 17, 2026" } } });
  });
  assert.equal(requested.length, 2);
  assert.equal(quote?.price, 59.93);
});

test("reads a quote from Yahoo without an API key", async () => {
  const quote = await fetchYahooQuote("MSFT", async () => response({
    chart: { result: [{ meta: { regularMarketPrice: 493.78, regularMarketTime: 1789761602 } }] },
  }));
  assert.equal(quote?.price, 493.78);
  assert.equal(quote?.provider, "yahoo_public");
});

test("uses Nasdaq when Yahoo is unavailable", async () => {
  const quote = await fetchPublicUsQuote("SLV", async (url) => {
    if (String(url).includes("query2.finance.yahoo.com")) return response({}, false);
    if (String(url).includes("assetclass=stocks")) return response({}, false);
    return response({ data: { primaryData: { lastSalePrice: "$59.93", lastTradeTimestamp: "Sep 17, 2026" } } });
  });
  assert.equal(quote?.price, 59.93);
  assert.equal(quote?.provider, "nasdaq_public");
});

test("keeps successful quotes when one symbol is unavailable", async () => {
  const result = await fetchPublicUsQuotes(["MSFT", "UNKNOWN"], async (url) => {
    if (String(url).includes("UNKNOWN")) return response({}, false);
    if (String(url).includes("query2.finance.yahoo.com")) {
      return response({ chart: { result: [{ meta: { regularMarketPrice: 100, regularMarketTime: 1789761602 } }] } });
    }
    return response({}, false);
  }, 2);
  assert.equal(result.quotes.length, 1);
  assert.equal(result.failed, 1);
});
