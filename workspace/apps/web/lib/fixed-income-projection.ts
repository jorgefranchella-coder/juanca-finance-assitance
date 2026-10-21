export type PriceObservation = { date: string; unitPrice: number; source: string };
export type FixedIncomeGroup = {
  owner: string; account: string | null; instrumentCode: string; productName: string; institution: string; issuer: string; assetClass: string;
  quantity: number; maturityDate: string; latestDate: string; currentUnitPrice: number;
  currentValueCents: number; priceSource: string; observations: PriceObservation[]; isCurrent: boolean;
};
export type CostBasisPoint = { owner: string; instrument_code: string; average_unit_cost: number; as_of: string; source?: string };

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
  const currentGroups = Array.from(groups).filter((group) => group.isCurrent);
  const costCandidates = new Map<string, number>();
  for (const group of currentGroups) {
    const key = `${group.owner}\0${codeKey(group.instrumentCode)}`;
    costCandidates.set(key, (costCandidates.get(key) ?? 0) + 1);
  }
  const costMap = new Map(costs.map((cost) => [`${cost.owner}\0${codeKey(cost.instrument_code)}`, cost]));
  return currentGroups.flatMap((group) => {
    const observations = [...group.observations];
    const costKey = `${group.owner}\0${codeKey(group.instrumentCode)}`;
    const cost = costCandidates.get(costKey) === 1 ? costMap.get(costKey) : undefined;
    const ambiguousCost = costCandidates.get(costKey)! > 1 && costMap.has(costKey);
    if (cost && Number(cost.average_unit_cost) > 0 && cost.as_of < group.latestDate) {
      observations.push({ date: cost.as_of, unitPrice: Number(cost.average_unit_cost), source: cost.source || "cost_basis" });
    }
    const projection = fixedIncomeProjection(observations, group.maturityDate, group.latestDate);
    const projectedValueCents = projection.projectedUnitPrice === null
      ? null : Math.round(projection.projectedUnitPrice * group.quantity * 100);
    const observationSources = [...new Set(observations.map((item) => item.source))].sort();
    const hasMixedValuationMethods = group.observations.some((item) => item.source === "b3_mtm")
      && group.observations.some((item) => item.source === "b3_curve");
    const hasUnverifiedSheetSource = observationSources.some((source) => source.startsWith("google_sheet:"));
    return [{
      owner: group.owner, account: group.account, instrument_code: group.instrumentCode, product_name: group.productName,
      institution: group.institution, issuer: group.issuer || "Emissor não identificado",
      asset_class: group.assetClass, quantity: group.quantity,
      maturity_date: group.maturityDate, reference_date: group.latestDate,
      current_unit_price: group.currentUnitPrice, current_value_cents: group.currentValueCents,
      price_source: group.priceSource, projected_value_cents: projectedValueCents,
      projected_gain_cents: projectedValueCents === null ? null : projectedValueCents - group.currentValueCents,
      observation_sources: observationSources, has_mixed_valuation_methods: hasMixedValuationMethods,
      has_unverified_sheet_source: hasUnverifiedSheetSource,
      ...projection,
      reason: ambiguousCost ? "O custo legado não identifica a conta e foi excluído desta projeção; revisar a atribuição." : projection.reason,
    }];
  }).sort((left, right) => (left.maturity_date || "9999").localeCompare(right.maturity_date || "9999"));
}

export type ProjectionScheduleItem = {
  owner: string; issuer: string; quantity: number; reference_date: string; maturity_date: string;
  current_unit_price: number; annualizedReturn: number | null; projected_value_cents: number | null;
  reason?: string | null;
};
export type ProjectionPeriodValue = {
  balance_cents: number | null; maturity_cents: number | null;
  status: "projected" | "maturity" | "matured" | "insufficient_data" | "outside_coverage" | "conflict";
  partial: boolean; reason: string | null;
};
export type ProjectionPeriodSummary = ProjectionPeriodValue & { positions: number; excluded_count: number };
export type ProjectionScheduleRow = ProjectionPeriodSummary & {
  date: string;
  groups: Array<ProjectionPeriodSummary & { owner: string; issuer: string }>;
};

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

export type FixedIncomeMatrixColumn = { key: string; year: string; date: string; start: string; label: string };
export type FixedIncomeMatrixYear = { year: string; annual: FixedIncomeMatrixColumn; months: FixedIncomeMatrixColumn[] };

export function buildFixedIncomeMatrixYears(items: ProjectionScheduleItem[]): FixedIncomeMatrixYear[] {
  const eligible = items.filter((item) => validDate(item.reference_date) && validDate(item.maturity_date)
    && item.reference_date < item.maturity_date);
  if (!eligible.length) return [];
  const firstReference = eligible.map((item) => item.reference_date).sort()[0];
  const maxMaturity = eligible.map((item) => item.maturity_date).sort().at(-1)!;
  const firstYear = Number(firstReference.slice(0, 4));
  const lastYear = Number(maxMaturity.slice(0, 4));
  const years: FixedIncomeMatrixYear[] = [];
  for (let year = firstYear; year <= lastYear; year++) {
    const annualBoundary = `${year}-12-31`;
    const annualDate = annualBoundary > maxMaturity ? maxMaturity : annualBoundary;
    const annualStart = year === firstYear ? firstReference : `${year - 1}-12-31`;
    const annual: FixedIncomeMatrixColumn = { key: `${year}-annual`, year: String(year), date: annualDate, start: annualStart, label: String(year) };
    const months: FixedIncomeMatrixColumn[] = [];
    const firstMonth = year === firstYear ? Number(firstReference.slice(5, 7)) : 1;
    for (let month = firstMonth; month <= 12; month++) {
      const monthEnd = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
      if (monthEnd > maxMaturity) {
        if (monthEnd.slice(0, 7) !== maxMaturity.slice(0, 7)) break;
      }
      const date = monthEnd > maxMaturity ? maxMaturity : monthEnd;
      const previousMonthEnd = month === 1 ? `${year - 1}-12-31` : new Date(Date.UTC(year, month - 1, 0)).toISOString().slice(0, 10);
      const start = year === firstYear && month === firstMonth ? firstReference : previousMonthEnd;
      if (date > start) months.push({ key: `${year}-${String(month).padStart(2, "0")}`, year: String(year), date, start,
        label: new Intl.DateTimeFormat("pt-BR", { month: "short", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`)) });
    }
    years.push({ year: String(year), annual, months });
  }
  return years;
}

export function fixedIncomePeriodValue(item: ProjectionScheduleItem, start: string, end: string): ProjectionPeriodValue {
  const missing = (status: ProjectionPeriodValue["status"], reason: string): ProjectionPeriodValue =>
    ({ balance_cents: null, maturity_cents: null, status, partial: true, reason });
  if (!validDate(start) || !validDate(end) || start >= end || !validDate(item.reference_date)) {
    return missing("insufficient_data", "Datas de referência ou período inválidas.");
  }
  if (end < item.reference_date) return missing("outside_coverage", `Sem cobertura antes de ${item.reference_date}.`);
  if (!validDate(item.maturity_date)) return missing("insufficient_data", "Data de vencimento não disponível.");
  if (item.maturity_date <= item.reference_date) return missing("conflict", "Vencimento anterior ou igual à posição de referência; revisar a fonte.");
  if (item.projected_value_cents === null || !Number.isSafeInteger(item.projected_value_cents)
      || item.annualizedReturn === null || !Number.isFinite(item.annualizedReturn) || item.annualizedReturn <= -0.95
      || item.annualizedReturn > 2 || !Number.isFinite(item.quantity) || item.quantity <= 0
      || !Number.isFinite(item.current_unit_price) || item.current_unit_price <= 0) {
    return missing("insufficient_data", item.reason || "Taxa histórica, quantidade ou preço insuficientes para projetar.");
  }
  if (item.maturity_date <= start) return { balance_cents: 0, maturity_cents: 0, status: "matured", partial: false, reason: null };
  const matures = item.maturity_date <= end;
  const projectionDate = matures ? item.maturity_date : end;
  const days = (Date.parse(`${projectionDate}T00:00:00Z`) - Date.parse(`${item.reference_date}T00:00:00Z`)) / 86_400_000;
  const value = Math.round(item.current_unit_price * item.quantity * Math.pow(1 + item.annualizedReturn, days / 365.25) * 100);
  if (!Number.isSafeInteger(value)) return missing("insufficient_data", "Projeção fora da precisão suportada.");
  const partial = item.reference_date > start;
  return { balance_cents: matures ? 0 : value, maturity_cents: matures ? value : 0,
    status: matures ? "maturity" : "projected", partial,
    reason: partial ? `Cobertura apenas a partir de ${item.reference_date}; fluxos anteriores desconhecidos.` : null };
}

/** Aggregates known amounts without presenting missing observations as zero. */
export function summarizeFixedIncomePeriod(items: ProjectionScheduleItem[], start: string, end: string): ProjectionPeriodSummary {
  const cells = items.map((item) => fixedIncomePeriodValue(item, start, end));
  const known = cells.filter((cell) => cell.balance_cents !== null && cell.maturity_cents !== null);
  const excluded_count = cells.length - known.length;
  const partial = cells.some((cell) => cell.partial);
  const balance = known.reduce((sum, cell) => sum + cell.balance_cents!, 0);
  const maturity = known.reduce((sum, cell) => sum + cell.maturity_cents!, 0);
  const safe = Number.isSafeInteger(balance) && Number.isSafeInteger(maturity);
  return { balance_cents: known.length && safe ? balance : null, maturity_cents: known.length && safe ? maturity : null,
    status: !safe ? "insufficient_data" : known.length ? (maturity > 0 ? "maturity" : known.every((cell) => cell.status === "matured") ? "matured" : "projected")
      : cells.every((cell) => cell.status === "outside_coverage") && cells.length ? "outside_coverage" : "insufficient_data",
    partial: partial || !safe,
    reason: !safe ? "Total fora da precisão suportada." : partial ? `${excluded_count} de ${items.length} títulos sem estimativa neste período; cobertura de datas também pode ser parcial.` : null,
    excluded_count, positions: known.filter((cell) => cell.status === "projected").length };
}

/** Both calendar views share the matrix calendar and the exact same period calculation. */
export function buildFixedIncomeSchedule(items: ProjectionScheduleItem[], granularity: "monthly" | "annual"): ProjectionScheduleRow[] {
  const periods = buildFixedIncomeMatrixYears(items).flatMap((year) => granularity === "monthly" ? year.months : [year.annual]);
  const grouped = new Map<string, { owner: string; issuer: string; items: ProjectionScheduleItem[] }>();
  for (const item of items) {
    const issuer = item.issuer || "Emissor não identificado";
    const key = JSON.stringify([item.owner, issuer]);
    const group = grouped.get(key) ?? { owner: item.owner, issuer, items: [] };
    group.items.push(item);
    grouped.set(key, group);
  }
  return periods.map(({ date, start }) => ({ date, ...summarizeFixedIncomePeriod(items, start, date),
    groups: Array.from(grouped.values()).map((group) => ({ owner: group.owner, issuer: group.issuer,
      ...summarizeFixedIncomePeriod(group.items, start, date) }))
      .sort((a, b) => a.owner.localeCompare(b.owner) || a.issuer.localeCompare(b.issuer)) }));
}
