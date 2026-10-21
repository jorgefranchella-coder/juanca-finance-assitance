export type PriceObservation = { date: string; unitPrice: number; source: string };
export type FixedIncomeGroup = {
  owner: string; instrumentCode: string; productName: string; institution: string; issuer: string; assetClass: string;
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
      institution: group.institution, issuer: group.issuer || "Emissor não identificado",
      asset_class: group.assetClass, quantity: group.quantity,
      maturity_date: group.maturityDate, reference_date: group.latestDate,
      current_unit_price: group.currentUnitPrice, current_value_cents: group.currentValueCents,
      price_source: group.priceSource, projected_value_cents: projectedValueCents,
      projected_gain_cents: projectedValueCents === null ? null : projectedValueCents - group.currentValueCents,
      ...projection,
    }];
  }).sort((left, right) => (left.maturity_date || "9999").localeCompare(right.maturity_date || "9999"));
}

export type ProjectionScheduleItem = {
  owner: string; issuer: string; quantity: number; reference_date: string; maturity_date: string;
  current_unit_price: number; annualizedReturn: number | null; projected_value_cents: number | null;
};
export type ProjectionScheduleRow = {
  date: string; balance_cents: number; maturity_cents: number; positions: number;
  groups: Array<{ owner: string; issuer: string; balance_cents: number; maturity_cents: number; positions: number }>;
};

export type FixedIncomeMatrixColumn = { key: string; year: string; date: string; start: string; label: string };
export type FixedIncomeMatrixYear = { year: string; annual: FixedIncomeMatrixColumn; months: FixedIncomeMatrixColumn[] };

export function buildFixedIncomeMatrixYears(items: ProjectionScheduleItem[]): FixedIncomeMatrixYear[] {
  const eligible = items.filter((item) => item.projected_value_cents !== null && item.annualizedReturn !== null
    && item.maturity_date && item.reference_date && item.reference_date < item.maturity_date);
  if (!eligible.length) return [];
  const latestReference = eligible.map((item) => item.reference_date).sort().at(-1)!;
  const maxMaturity = eligible.map((item) => item.maturity_date).sort().at(-1)!;
  const firstYear = Number(latestReference.slice(0, 4));
  const lastYear = Number(maxMaturity.slice(0, 4));
  const years: FixedIncomeMatrixYear[] = [];
  for (let year = firstYear; year <= lastYear; year++) {
    const annualBoundary = `${year}-12-31`;
    const annualDate = annualBoundary > maxMaturity ? maxMaturity : annualBoundary;
    const annualStart = year === firstYear ? latestReference : `${year - 1}-12-31`;
    const annual: FixedIncomeMatrixColumn = { key: `${year}-annual`, year: String(year), date: annualDate, start: annualStart, label: String(year) };
    const months: FixedIncomeMatrixColumn[] = [];
    const firstMonth = year === firstYear ? Number(latestReference.slice(5, 7)) : 1;
    for (let month = firstMonth; month <= 12; month++) {
      const monthEnd = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
      if (monthEnd > maxMaturity) {
        if (monthEnd.slice(0, 7) !== maxMaturity.slice(0, 7)) break;
      }
      const date = monthEnd > maxMaturity ? maxMaturity : monthEnd;
      const previousMonthEnd = month === 1 ? `${year - 1}-12-31` : new Date(Date.UTC(year, month - 1, 0)).toISOString().slice(0, 10);
      const start = year === firstYear && month === firstMonth ? latestReference : previousMonthEnd;
      if (date > start) months.push({ key: `${year}-${String(month).padStart(2, "0")}`, year: String(year), date, start,
        label: new Intl.DateTimeFormat("pt-BR", { month: "short", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`)) });
    }
    years.push({ year: String(year), annual, months });
  }
  return years;
}

export function fixedIncomePeriodValue(item: ProjectionScheduleItem, start: string, end: string) {
  if (item.projected_value_cents === null || item.annualizedReturn === null || !item.maturity_date || item.maturity_date <= start) {
    return { balance_cents: 0, maturity_cents: 0 };
  }
  const projectedAt = (date: string) => {
    const days = Math.max(0, (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${item.reference_date}T00:00:00Z`)) / 86_400_000);
    return Math.round(item.current_unit_price * item.quantity * Math.pow(1 + item.annualizedReturn!, days / 365.25) * 100);
  };
  const maturity_cents = item.maturity_date <= end ? projectedAt(item.maturity_date) : 0;
  const balance_cents = item.maturity_date > end && item.reference_date < end ? projectedAt(end) : 0;
  return { balance_cents, maturity_cents };
}

/** Values active holdings at month/year end and reports maturities separately in their period. */
export function buildFixedIncomeSchedule(items: ProjectionScheduleItem[], granularity: "monthly" | "annual"): ProjectionScheduleRow[] {
  const eligible = items.filter((item) => item.projected_value_cents !== null && item.annualizedReturn !== null
    && item.maturity_date && item.reference_date && item.quantity > 0 && item.current_unit_price > 0);
  if (!eligible.length) return [];
  const latestReference = eligible.map((item) => item.reference_date).sort().at(-1)!;
  const maxMaturity = eligible.map((item) => item.maturity_date).sort().at(-1)!;
  const cursor = new Date(`${latestReference}T00:00:00Z`);
  const periods: Array<{ date: string; start: string }> = [];
  let periodStart = latestReference;
  for (let i = 0; i < 360; i++) {
    let end: Date;
    if (granularity === "monthly") end = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + i + 1, 0));
    else end = new Date(Date.UTC(cursor.getUTCFullYear() + i + 1, 0, 0));
    let endDate = end.toISOString().slice(0, 10);
    if (endDate > maxMaturity) {
      const sameBucket = granularity === "monthly" ? endDate.slice(0, 7) === maxMaturity.slice(0, 7)
        : endDate.slice(0, 4) === maxMaturity.slice(0, 4);
      if (!sameBucket) break;
      endDate = maxMaturity;
    }
    periods.push({ date: endDate, start: periodStart });
    periodStart = endDate;
  }
  return periods.map(({ date, start }) => {
    const grouped = new Map<string, ProjectionScheduleRow["groups"][number]>();
    for (const item of eligible) {
      const maturity = item.maturity_date;
      const rate = item.annualizedReturn!;
      const key = `${item.owner}\0${item.issuer || "Emissor não identificado"}`;
      const group = grouped.get(key) ?? { owner: item.owner, issuer: item.issuer || "Emissor não identificado",
        balance_cents: 0, maturity_cents: 0, positions: 0 };
      const maturityInPeriod = maturity > start && maturity <= date;
      if (maturityInPeriod) {
        const days = Math.max(0, (Date.parse(`${maturity}T00:00:00Z`) - Date.parse(`${item.reference_date}T00:00:00Z`)) / 86_400_000);
        const value = Math.round(item.current_unit_price * item.quantity * Math.pow(1 + rate, days / 365.25) * 100);
        group.maturity_cents += value;
      }
      if (maturity >= date && item.reference_date < date) {
        const days = (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${item.reference_date}T00:00:00Z`)) / 86_400_000;
        group.balance_cents += Math.round(item.current_unit_price * item.quantity * Math.pow(1 + rate, days / 365.25) * 100);
        group.positions++;
      }
      grouped.set(key, group);
    }
    const groups = Array.from(grouped.values()).filter((group) => group.balance_cents || group.maturity_cents)
      .sort((a, b) => a.owner.localeCompare(b.owner) || a.issuer.localeCompare(b.issuer));
    return { date, balance_cents: groups.reduce((sum, group) => sum + group.balance_cents, 0),
      maturity_cents: groups.reduce((sum, group) => sum + group.maturity_cents, 0),
      positions: groups.reduce((sum, group) => sum + group.positions, 0), groups };
  });
}
