import test from "node:test";
import assert from "node:assert/strict";
import { fixedIncomeProjection } from "../lib/fixed-income-projection.ts";

test("annualizes observed price growth and compounds it to maturity", () => {
  const result = fixedIncomeProjection([
    { date: "2025-01-01", unitPrice: 1000, source: "curve" },
    { date: "2026-01-01", unitPrice: 1100, source: "curve" },
  ], "2027-01-01", "2026-01-01");
  assert.ok(result.annualizedReturn !== null && Math.abs(result.annualizedReturn - 0.1) < 0.001);
  assert.ok(result.projectedUnitPrice !== null && Math.abs(result.projectedUnitPrice - 1210) < 1);
});

test("requires two observations but projects short histories with low confidence", () => {
  const single = fixedIncomeProjection([{ date: "2026-01-01", unitPrice: 1000, source: "curve" }], "2027-01-01", "2026-01-01");
  assert.equal(single.projectedUnitPrice, null);
  const short = fixedIncomeProjection([
    { date: "2026-01-01", unitPrice: 1000, source: "curve" },
    { date: "2026-01-15", unitPrice: 1005, source: "curve" },
  ], "2027-01-01", "2026-01-15");
  assert.ok(short.projectedUnitPrice !== null);
  assert.ok(short.annualizedReturn !== null);
  assert.equal(short.confidence, "low");
  assert.equal(short.reason, null);
});
