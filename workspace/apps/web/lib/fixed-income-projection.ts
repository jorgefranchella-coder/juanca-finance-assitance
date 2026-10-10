export type PriceObservation = { date: string; unitPrice: number; source: string };

export type ProjectionResult = {
  observationCount: number;
  firstDate: string;
  lastDate: string;
  elapsedDays: number;
  periodReturn: number | null;
  annualizedReturn: number | null;
  daysToMaturity: number;
  projectedUnitPrice: number | null;
  confidence: "high" | "medium" | "low" | "insufficient";
  reason: string | null;
};

function utcDay(value: string) {
  const parsed = Date.parse(`${value}T12:00:00Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

export function fixedIncomeProjection(
  observations: PriceObservation[], maturityDate: string, asOf: string,
): ProjectionResult {
  const unique = new Map<string, PriceObservation>();
  for (const item of observations) {
    if (utcDay(item.date) !== null && Number.isFinite(item.unitPrice) && item.unitPrice > 0) unique.set(item.date, item);
  }
  const sorted = Array.from(unique.values()).sort((left, right) => left.date.localeCompare(right.date));
  const first = sorted[0];
  const last = sorted.at(-1);
  const maturity = utcDay(maturityDate);
  const reference = utcDay(asOf);
  const daysToMaturity = maturity !== null && reference !== null ? Math.max(0, Math.round((maturity - reference) / 86_400_000)) : 0;
  if (!first || !last || sorted.length < 2) {
    return { observationCount: sorted.length, firstDate: first?.date ?? "", lastDate: last?.date ?? "",
      elapsedDays: 0, periodReturn: null, annualizedReturn: null, daysToMaturity,
      projectedUnitPrice: null, confidence: "insufficient", reason: "É necessária uma segunda observação de preço." };
  }
  const firstDay = utcDay(first.date)!;
  const lastDay = utcDay(last.date)!;
  const elapsedDays = Math.round((lastDay - firstDay) / 86_400_000);
  const periodReturn = last.unitPrice / first.unitPrice - 1;
  if (elapsedDays <= 0) {
    return { observationCount: sorted.length, firstDate: first.date, lastDate: last.date, elapsedDays,
      periodReturn, annualizedReturn: null, daysToMaturity, projectedUnitPrice: null,
      confidence: "insufficient", reason: "As observações precisam ter datas diferentes." };
  }
  if (!maturityDate || maturity === null) {
    return { observationCount: sorted.length, firstDate: first.date, lastDate: last.date, elapsedDays,
      periodReturn, annualizedReturn: null, daysToMaturity: 0, projectedUnitPrice: null,
      confidence: "insufficient", reason: "Data de vencimento não disponível." };
  }
  const annualizedReturn = Math.pow(last.unitPrice / first.unitPrice, 365.25 / elapsedDays) - 1;
  if (!Number.isFinite(annualizedReturn) || annualizedReturn <= -0.95 || annualizedReturn > 2) {
    return { observationCount: sorted.length, firstDate: first.date, lastDate: last.date, elapsedDays,
      periodReturn, annualizedReturn, daysToMaturity, projectedUnitPrice: null,
      confidence: "insufficient", reason: "A variação observada não é estável o suficiente para extrapolar." };
  }
  const projectedUnitPrice = last.unitPrice * Math.pow(1 + annualizedReturn, daysToMaturity / 365.25);
  const confidence = elapsedDays >= 180 && sorted.length >= 4 ? "high" : elapsedDays >= 90 && sorted.length >= 3 ? "medium" : "low";
  return { observationCount: sorted.length, firstDate: first.date, lastDate: last.date, elapsedDays,
    periodReturn, annualizedReturn, daysToMaturity, projectedUnitPrice, confidence, reason: null };
}
