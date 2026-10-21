import test from "node:test";
import assert from "node:assert/strict";
import { buildFixedIncomeProjectionItems, fixedIncomeProjection } from "../lib/fixed-income-projection.ts";

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

test("projects each asset from its own latest snapshot and includes its acquisition price", () => {
  const groups = [
    { owner: "Jorge", instrumentCode: "CDB1", productName: "CDB", institution: "BTG", assetClass: "fixed_income",
      quantity: 10, maturityDate: "2027-01-01", latestDate: "2026-10-19", currentUnitPrice: 1100,
      currentValueCents: 1_100_000, priceSource: "b3_mtm", isCurrent: true,
      observations: [{ date: "2026-10-19", unitPrice: 1100, source: "b3_mtm" }] },
    { owner: "Jorge", instrumentCode: "PREV", productName: "Previdência", institution: "Fundo", assetClass: "private_pension",
      quantity: 1, maturityDate: "2030-01-01", latestDate: "2026-10-21", currentUnitPrice: 105,
      currentValueCents: 10_500, priceSource: "pension_statement", isCurrent: true,
      observations: [{ date: "2026-10-21", unitPrice: 105, source: "pension_statement" }] },
    { owner: "Jorge", instrumentCode: "OLD", productName: "CDB vencido", institution: "BTG", assetClass: "fixed_income",
      quantity: 10, maturityDate: "2025-01-01", latestDate: "2025-01-01", currentUnitPrice: 1000,
      currentValueCents: 1_000_000, priceSource: "b3_mtm", isCurrent: false,
      observations: [{ date: "2025-01-01", unitPrice: 1000, source: "b3_mtm" }] },
  ];
  const items = buildFixedIncomeProjectionItems(groups, [
    { owner: "Jorge", instrument_code: "CDB1", average_unit_cost: 1000, as_of: "2025-10-19" },
  ]);
  assert.equal(items.length, 2);
  const cdb = items.find((item) => item.instrument_code === "CDB1");
  assert.equal(cdb?.firstDate, "2025-10-19");
  assert.equal(cdb?.lastDate, "2026-10-19");
  assert.equal(cdb?.observationCount, 2);
  assert.ok(items.some((item) => item.instrument_code === "PREV" && item.reference_date === "2026-10-21"));
});
