export type PriceObservation = { date: string; unitPrice: number; source: string };
export type FixedIncomeGroup = {
  owner: string; instrumentCode: string; productName: string; institution: string; assetClass: string;
  quantity: number; maturityDate: string; latestDate: string; currentUnitPrice: number;
  currentValueCents: number; priceSource: string; observations: PriceObservation[]; isCurrent: boolean;
};
export type CostBasisPoint = { owner: string; instrument_code: string; average_unit_cost: number; as_of: string };

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

/** Builds a projection for every instrument from that instrument's own latest snapshot. */
export function buildFixedIncomeProjectionItems(groups: Iterable<FixedIncomeGroup>, costs: CostBasisPoint[]) {
  const codeKey = (code: string) => code.trim().toUpperCase().replace(/^(BVMF|NASDAQ|NYSE|NYSEARCA):/, "");
  const costMap = new Map(costs.map((cost) => [`${cost.owner}\0${codeKey(cost.instrument_code)}`, cost]));
  return Array.from(groups).filter((group) => group.isCurrent).flatMap((group) => {
    const observations = [...group.observations];
    const cost = costMap.get(`${group.owner}\0${codeKey(group.instrumentCode)}`);
    if (cost && Number(cost.average_unit_cost) > 0 && cost.as_of < group.latestDate) {
      observations.push({ date: cost.as_of, unitPrice: Number(cost.average_unit_cost), source: "cost_basis" });
    }
    const projection = fixedIncomeProjection(observations, group.maturityDate, group.latestDate);
    const projectedValueCents = projection.projectedUnitPrice === null
      ? null : Math.round(projection.projectedUnitPrice * group.quantity * 100);
    return [{
      owner: group.owner, instrument_code: group.instrumentCode, product_name: group.productName,
      institution: group.institution, asset_class: group.assetClass, quantity: group.quantity,
      maturity_date: group.maturityDate, reference_date: group.latestDate,
      current_unit_price: group.currentUnitPrice, current_value_cents: group.currentValueCents,
      price_source: group.priceSource, projected_value_cents: projectedValueCents,
      projected_gain_cents: projectedValueCents === null ? null : projectedValueCents - group.currentValueCents,
      ...projection,
    }];
  }).sort((left, right) => (left.maturity_date || "9999").localeCompare(right.maturity_date || "9999"));
}
