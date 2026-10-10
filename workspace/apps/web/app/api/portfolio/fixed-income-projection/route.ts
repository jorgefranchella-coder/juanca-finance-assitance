import { env } from "cloudflare:workers";
import { authenticatedUserId } from "@/lib/reviews";
import { b3Valuation, normalizedCode } from "@/lib/valuation";
import { fixedIncomeProjection, type PriceObservation } from "@/lib/fixed-income-projection";

export const dynamic = "force-dynamic";

type Stored = { import_owner: string; import_date: string; payload: string };
type Cost = { owner: string; instrument_code: string; average_unit_cost: number; as_of: string };
type Group = {
  owner: string; instrumentCode: string; productName: string; institution: string; assetClass: string;
  quantity: number; maturityDate: string; latestDate: string; currentUnitPrice: number;
  currentValueCents: number; priceSource: string; observations: PriceObservation[];
};

export async function GET(request: Request) {
  const userId = authenticatedUserId(request);
  if (!userId) return Response.json({ detail: "Autenticação necessária." }, { status: 401 });
  try {
    const [stored, costs] = await Promise.all([
      env.DB.prepare(`SELECT i.owner AS import_owner, COALESCE(i.reference_date, '') AS import_date, r.payload
        FROM import_records r JOIN imports i ON i.id=r.import_id
        WHERE i.user_id=? AND i.status='processed' AND i.file_type IN ('positions', 'pension_statement')
          AND r.record_kind='position' ORDER BY i.reference_date, i.created_at, r.id LIMIT 12000`)
        .bind(userId).all<Stored>(),
      env.DB.prepare(`SELECT owner, instrument_code, average_unit_cost, as_of FROM cost_basis
        WHERE user_id=? ORDER BY as_of LIMIT 3000`).bind(userId).all<Cost>().catch(() => ({ results: [] as Cost[] })),
    ]);
    const ownerLatest = new Map<string, string>();
    const groups = new Map<string, Group>();
    for (const row of stored.results) {
      try {
        const item = JSON.parse(row.payload) as Record<string, unknown>;
        const assetClass = String(item.asset_class ?? "");
        if (!new Set(["fixed_income", "treasury", "international_fixed_income", "private_pension"]).has(assetClass)) continue;
        const owner = String(item.owner ?? row.import_owner);
        const code = normalizedCode(item.instrument_code || item.product_name);
        const date = String(item.reference_date ?? row.import_date);
        const quantity = Number(item.quantity ?? 0);
        const maturityDate = String(item.maturity_date ?? "");
        const valuation = b3Valuation(item);
        const derivedPrice = valuation.unit_price > 0 ? valuation.unit_price
          : quantity > 0 ? valuation.market_value_cents / 100 / quantity : 0;
        if (!owner || !code || !date || quantity <= 0 || derivedPrice <= 0) continue;
        if (date > (ownerLatest.get(owner) ?? "")) ownerLatest.set(owner, date);
        const key = `${owner}\0${code}`;
        const current = groups.get(key);
        const observation = { date, unitPrice: derivedPrice, source: valuation.price_source };
        if (!current) {
          groups.set(key, { owner, instrumentCode: code, productName: String(item.product_name ?? code),
            institution: String(item.institution ?? ""), assetClass, quantity, maturityDate, latestDate: date,
            currentUnitPrice: derivedPrice, currentValueCents: valuation.market_value_cents,
            priceSource: valuation.price_source, observations: [observation] });
        } else {
          current.observations.push(observation);
          if (date >= current.latestDate) {
            Object.assign(current, { quantity, maturityDate, latestDate: date, currentUnitPrice: derivedPrice,
              currentValueCents: valuation.market_value_cents, priceSource: valuation.price_source,
              productName: String(item.product_name ?? code), institution: String(item.institution ?? "") });
          }
        }
      } catch { /* invalid source rows stay excluded */ }
    }
    const costMap = new Map(costs.results.map((cost) => [`${cost.owner}\0${normalizedCode(cost.instrument_code)}`, cost]));
    const items = Array.from(groups.entries()).flatMap(([key, group]) => {
      if (group.latestDate !== ownerLatest.get(group.owner)) return [];
      const observations = [...group.observations];
      const cost = costMap.get(key);
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
    const covered = items.filter((item) => item.projected_value_cents !== null);
    const totalCurrent = items.reduce((sum, item) => sum + item.current_value_cents, 0);
    const coveredCurrent = covered.reduce((sum, item) => sum + item.current_value_cents, 0);
    const coveredProjected = covered.reduce((sum, item) => sum + (item.projected_value_cents ?? 0), 0);
    return Response.json({
      reference_date: Array.from(ownerLatest.values()).sort().at(-1) ?? "",
      summary: { total_current_cents: totalCurrent, covered_current_cents: coveredCurrent,
        covered_projected_cents: coveredProjected, projected_gain_cents: coveredProjected - coveredCurrent,
        coverage: totalCurrent ? coveredCurrent / totalCurrent : 0, projected_count: covered.length, total_count: items.length },
      items,
      methodology: "Rentabilidade efetiva anualizada entre a primeira e a última observação de preço; extrapolação composta até o vencimento.",
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return Response.json({ detail: "Não foi possível calcular a projeção de renda fixa agora." }, { status: 500 });
  }
}
