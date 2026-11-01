import test from "node:test";
import assert from "node:assert/strict";
import { contractualPeriod, contractualSummary } from "../lib/fixed-income-contract-schedule.ts";

const item = { reference_date: "2026-01-10", maturity_date: "2026-03-31", contractual: { status: "complete", missing: [], calendar: [
  { date: "2026-01-31", balance_cents: 10000, cashflow_cents: 500, maturity_cents: 0 },
  { date: "2026-02-28", balance_cents: 10000, cashflow_cents: 0, maturity_cents: 0 },
  { date: "2026-03-31", balance_cents: 0, cashflow_cents: 10000, maturity_cents: 10000 },
] } };

test("monthly boundary cashflows are counted once and included in the annual total", () => {
  assert.equal(contractualPeriod(item, "2026-01-10", "2026-01-31").maturity_cents, 500);
  assert.equal(contractualPeriod(item, "2026-01-31", "2026-02-28").maturity_cents, null);
  assert.equal(contractualPeriod(item, "2026-01-10", "2026-12-31").maturity_cents, 10500);
});

test("issuer aggregation marks missing or shorter coverage as partial", () => {
  const missing = { ...item, contractual: { status: "incomplete", missing: ["condiciones"], calendar: [] } };
  const result = contractualSummary([item, missing], "2026-01-01", "2026-01-31");
  assert.equal(result.balance_cents, 10000); assert.equal(result.partial, true); assert.equal(result.excluded_count, 1);
});
