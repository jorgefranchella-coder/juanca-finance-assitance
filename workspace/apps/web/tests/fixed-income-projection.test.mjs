import test from "node:test";
import assert from "node:assert/strict";
import { buildFixedIncomeMatrixYears, buildFixedIncomeProjectionItems, buildFixedIncomeSchedule, fixedIncomePeriodValue, fixedIncomeProjection } from "../lib/fixed-income-projection.ts";

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
    { owner: "Jorge", instrumentCode: "CDB1", productName: "CDB", institution: "BTG", issuer: "Banco X", assetClass: "fixed_income",
      quantity: 10, maturityDate: "2027-01-01", latestDate: "2026-10-19", currentUnitPrice: 1100,
      currentValueCents: 1_100_000, priceSource: "b3_mtm", isCurrent: true,
      observations: [{ date: "2026-10-19", unitPrice: 1100, source: "b3_mtm" }] },
    { owner: "Jorge", instrumentCode: "PREV", productName: "Previdência", institution: "Fundo", issuer: "Fundo Y", assetClass: "private_pension",
      quantity: 1, maturityDate: "2030-01-01", latestDate: "2026-10-21", currentUnitPrice: 105,
      currentValueCents: 10_500, priceSource: "pension_statement", isCurrent: true,
      observations: [{ date: "2026-10-21", unitPrice: 105, source: "pension_statement" }] },
    { owner: "Jorge", instrumentCode: "OLD", productName: "CDB vencido", institution: "BTG", issuer: "Banco X", assetClass: "fixed_income",
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

test("builds monthly and annual balances grouped by issuer and owner, with maturities separated", () => {
  const items = [
    { owner: "Jorge", issuer: "Banco A", quantity: 10, reference_date: "2026-01-15", maturity_date: "2026-03-15",
      current_unit_price: 100, annualizedReturn: 0.1, projected_value_cents: 110_000 },
    { owner: "Jorge", issuer: "Banco A", quantity: 5, reference_date: "2026-01-15", maturity_date: "2027-02-01",
      current_unit_price: 100, annualizedReturn: 0.1, projected_value_cents: 110_000 },
    { owner: "Julia", issuer: "Banco A", quantity: 2, reference_date: "2026-01-15", maturity_date: "2027-02-01",
      current_unit_price: 100, annualizedReturn: 0.1, projected_value_cents: 110_000 },
  ];
  const monthly = buildFixedIncomeSchedule(items, "monthly");
  assert.equal(monthly[0]?.date, "2026-01-31");
  assert.equal(monthly[0]?.groups.length, 2);
  const march = monthly.find((row) => row.date === "2026-03-31");
  assert.ok((march?.maturity_cents ?? 0) > 0);
  assert.equal(march?.groups.find((group) => group.owner === "Jorge")?.positions, 1);
  const annual = buildFixedIncomeSchedule(items, "annual");
  assert.equal(annual[0]?.date, "2026-12-31");
  assert.ok((annual[0]?.maturity_cents ?? 0) > 0);
  assert.equal(annual[0]?.groups.length, 2);
});

test("builds collapsible annual columns and monthly columns through each maturity", () => {
  const items = [
    { owner: "Jorge", issuer: "Banco A", quantity: 10, reference_date: "2026-01-15", maturity_date: "2026-03-15",
      current_unit_price: 100, annualizedReturn: 0.1, projected_value_cents: 110_000 },
    { owner: "Julia", issuer: "Banco B", quantity: 2, reference_date: "2026-01-15", maturity_date: "2027-02-01",
      current_unit_price: 100, annualizedReturn: 0.1, projected_value_cents: 110_000 },
  ];
  const years = buildFixedIncomeMatrixYears(items);
  assert.deepEqual(years.map((year) => year.year), ["2026", "2027"]);
  assert.equal(years[0]?.annual.date, "2026-12-31");
  assert.equal(years[0]?.months.find((month) => month.date === "2026-03-31")?.label, "mar.");
  assert.equal(years[1]?.months.at(-1)?.date, "2027-02-01");
  const maturity = fixedIncomePeriodValue(items[0], "2026-02-28", "2026-03-31");
  assert.ok(maturity.maturity_cents > 0);
  assert.equal(maturity.balance_cents, 0);
});

const temporalItem = (overrides = {}) => ({ owner: "Jorge", issuer: "Banco A", quantity: 10,
  reference_date: "2028-01-15", maturity_date: "2028-02-29", current_unit_price: 100,
  annualizedReturn: 0.1, projected_value_cents: 101_000, ...overrides });

test("different investor dates preserve earlier maturities and never backfill later holdings", () => {
  const early = temporalItem();
  const later = temporalItem({ owner: "Julia", reference_date: "2028-04-15", maturity_date: "2028-12-31" });
  const rows = buildFixedIncomeSchedule([early, later], "monthly");
  assert.equal(rows[0].date, "2028-01-31");
  const february = rows.find((row) => row.date === "2028-02-29");
  assert.ok(february.maturity_cents > 0);
  assert.equal(february.balance_cents, 0);
  assert.equal(february.partial, true);
  assert.equal(february.excluded_count, 1);
  const julia = february.groups.find((group) => group.owner === "Julia");
  assert.equal(julia.status, "outside_coverage");
  assert.equal(julia.balance_cents, null);
  const april = fixedIncomePeriodValue(later, "2028-03-31", "2028-04-30");
  assert.ok(april.balance_cents > 0);
  assert.equal(april.partial, true);
  assert.match(april.reason, /2028-04-15/);
});

test("leap-day and year-end maturities occur once and annual flows reconcile with months", () => {
  const items = [temporalItem(), temporalItem({ maturity_date: "2028-12-31" }),
    temporalItem({ maturity_date: "2029-06-17" })];
  const years = buildFixedIncomeMatrixYears(items);
  const monthly = buildFixedIncomeSchedule(items, "monthly");
  const annual = buildFixedIncomeSchedule(items, "annual");
  assert.equal(annual.at(-1).date, "2029-06-17");
  for (const year of years) {
    const months = monthly.filter((row) => row.date.startsWith(year.year));
    const row = annual.find((row) => row.date.startsWith(year.year));
    assert.equal(row.maturity_cents, months.reduce((sum, month) => sum + month.maturity_cents, 0));
    assert.equal(row.balance_cents, months.at(-1).balance_cents);
  }
  const feb = fixedIncomePeriodValue(items[0], "2028-01-31", "2028-02-29");
  assert.equal(feb.balance_cents, 0);
  assert.ok(feb.maturity_cents > 0);
  assert.equal(fixedIncomePeriodValue(items[0], "2028-02-29", "2028-03-31").status, "matured");
  const december = fixedIncomePeriodValue(items[1], "2028-11-30", "2028-12-31");
  assert.equal(december.balance_cents, 0);
  assert.ok(december.maturity_cents > 0);
});

test("insufficient rates stay visible, null is not zero, and source-date conflicts block values", () => {
  const missing = temporalItem({ annualizedReturn: null, projected_value_cents: null, reason: "Falta preço de compra." });
  const rows = buildFixedIncomeSchedule([missing], "monthly");
  assert.ok(rows.length > 0);
  assert.equal(rows[0].balance_cents, null);
  assert.equal(rows[0].maturity_cents, null);
  assert.equal(rows[0].excluded_count, 1);
  const cell = fixedIncomePeriodValue(missing, "2028-01-15", "2028-01-31");
  assert.equal(cell.status, "insufficient_data");
  assert.equal(cell.reason, missing.reason);
  const conflict = fixedIncomePeriodValue(temporalItem({ maturity_date: "2028-01-15" }), "2028-01-15", "2028-01-31");
  assert.equal(conflict.status, "conflict");
  assert.equal(conflict.balance_cents, null);
  assert.equal(fixedIncomePeriodValue(temporalItem(), "2028-02-30", "2028-03-31").status, "insufficient_data");
});

test("the reference-day balance is known while the preceding interval remains partial", () => {
  const item = temporalItem({ reference_date: "2028-01-31" });
  const cell = fixedIncomePeriodValue(item, "2028-01-01", "2028-01-31");
  assert.equal(cell.balance_cents, 100_000);
  assert.equal(cell.partial, true);
});
