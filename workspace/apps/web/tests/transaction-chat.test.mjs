import test from "node:test";
import assert from "node:assert/strict";
import { missingTransactionFields, parseTransactionText } from "../lib/transaction-parser.ts";

test("interprets a Brazilian stock purchase from conversational text", () => {
  const drafts = parseTransactionText("Comprei 20 PETR4 a R$ 32,50 em 16/08/2026", "Jorge");
  assert.equal(drafts.length, 1);
  assert.deepEqual({
    side: drafts[0].side, code: drafts[0].instrumentCode, quantity: drafts[0].quantity,
    price: drafts[0].unitPrice, currency: drafts[0].currency, date: drafts[0].tradeDate,
  }, { side: "buy", code: "PETR4", quantity: 20, price: 32.5, currency: "BRL", date: "2026-08-16" });
});

test("interprets a US sale and fees", () => {
  const drafts = parseTransactionText("Vendi 5 AAPL a US$ 225,40 em 2026-08-16, taxas 1,25", "Julia");
  assert.equal(drafts[0].side, "sell");
  assert.equal(drafts[0].currency, "USD");
  assert.equal(drafts[0].feesMinor, 125);
});

test("explains which transaction fields are missing", () => {
  assert.deepEqual(missingTransactionFields("Comprei PETR4"), ["quantidade e código do ativo", "preço unitário", "data da operação", "moeda"]);
});
