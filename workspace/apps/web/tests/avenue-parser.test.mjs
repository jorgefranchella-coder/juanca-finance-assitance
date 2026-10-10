import assert from "node:assert/strict";
import test from "node:test";

import { parseAvenueConfirmations, parseAvenueStatement } from "../lib/avenue.ts";

test("parses an Avenue statement with positions and cash", () => {
  const pages = [
    "PORTFOLIO SUMMARY July 01, 2026 - July 31, 2026 AVENUE ACCOUNT NUMBER: 123 TOTAL PRICED PORTFOLIO Total Cash (Net Portfolio Balance) $ 23.69",
    "EQUITIES / OPTIONS\nMicrosoft Corporation\nMSFT C 5 464.72 $ 2,323.60\nNVIDIA Corp\nNVDA C 22 200.75 $ 4,416.50\nTotal Equities",
  ];
  const positions = parseAvenueStatement(pages, "Jorge");
  assert.equal(positions.length, 3);
  assert.equal(positions[0].instrument_code, "MSFT");
  assert.equal(positions[2].market_value_minor, 2369);
  assert.equal(positions[0].reference_date, "2026-07-31");
});

test("parses Avenue confirmation trades", () => {
  const pages = [`Account cleared by Apex\nTrade Date Account Number: 6AJ-74139\n1 S 08/11/26 08/12/26 2.68602 MELI 1,912.3700 5,136.66 0.00 0.00 0.00\nDesc: MERCADOLIBRE INC Interest/STTax: 0.00 CUSIP: 58733R102`];
  const trades = parseAvenueConfirmations(pages, "Jorge");
  assert.equal(trades.length, 1);
  assert.equal(trades[0].side, "sell");
  assert.equal(trades[0].principal_minor, 513666);
  assert.equal(trades[0].trade_date, "2026-08-11");
});
