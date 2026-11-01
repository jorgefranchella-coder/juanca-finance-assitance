import type { ProjectionPeriodValue } from "./fixed-income-projection.ts";

export type ContractScheduleItem = {
  reference_date: string; maturity_date: string;
  contractual?: { status: "complete" | "incomplete"; missing: string[];
    calendar: Array<{ date: string; balance_cents: number; cashflow_cents: number; maturity_cents: number }> };
};

export function contractualPeriod(item: ContractScheduleItem, start: string, end: string): ProjectionPeriodValue {
  const contract = item.contractual;
  if (!contract || contract.status !== "complete") return { balance_cents: null, maturity_cents: null, status: "insufficient_data", partial: true, reason: contract?.missing.join(", ") || "Sin condiciones contractuales vinculadas a esta cuenta." };
  if (end < item.reference_date) return { balance_cents: null, maturity_cents: null, status: "outside_coverage", partial: true, reason: `Cobertura desde ${item.reference_date}.` };
  const values = contract.calendar.filter((entry) => entry.date > start && entry.date <= end);
  const latest = contract.calendar.filter((entry) => entry.date <= end && entry.date <= item.maturity_date).at(-1);
  if (!latest) return { balance_cents: null, maturity_cents: null, status: "outside_coverage", partial: true, reason: null };
  const cashflows = values.reduce((sum, entry) => sum + entry.cashflow_cents, 0), maturing = values.some((entry) => entry.maturity_cents > 0);
  if (!Number.isSafeInteger(cashflows)) return { balance_cents: null, maturity_cents: null, status: "insufficient_data", partial: true, reason: "Flujos fuera de la precisión admitida." };
  const matured = end > item.maturity_date, partial = item.reference_date > start;
  return { balance_cents: matured ? 0 : latest.balance_cents, maturity_cents: cashflows || null, status: matured ? "matured" : maturing ? "maturity" : "projected", partial, reason: partial ? `Cobertura desde ${item.reference_date}.` : null };
}

export function contractualSummary(items: ContractScheduleItem[], start: string, end: string) {
  const values = items.map((item) => contractualPeriod(item, start, end)), covered = values.filter((value) => value.balance_cents !== null);
  const cashflows = values.reduce((sum, value) => sum + (value.maturity_cents ?? 0), 0);
  const balance = covered.reduce((sum, value) => sum + (value.balance_cents ?? 0), 0);
  const safe = Number.isSafeInteger(balance) && Number.isSafeInteger(cashflows);
  const partial = values.some((value) => value.partial) || !safe;
  return { balance_cents: covered.length && safe ? balance : null, maturity_cents: safe ? cashflows || null : null,
    status: !safe ? "insufficient_data" as const : covered.length && covered.every((value) => value.status === "matured") ? "matured" as const : covered.length ? "projected" as const : "insufficient_data" as const,
    partial, reason: !safe ? "Total fuera de la precisión admitida." : partial ? "Hay títulos o períodos sin cobertura completa." : null, positions: covered.length, excluded_count: items.length - covered.length };
}
