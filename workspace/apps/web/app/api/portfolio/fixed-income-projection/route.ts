import { env } from "cloudflare:workers";
import { authenticatedUserId } from "@/lib/reviews";
import { b3Valuation, normalizedCode } from "@/lib/valuation";
import { buildFixedIncomeProjectionItems, type FixedIncomeGroup } from "@/lib/fixed-income-projection";

export const dynamic = "force-dynamic";

type Stored = { import_owner: string; import_date: string; is_latest_snapshot: number; payload: string };
type Cost = { owner: string; instrument_code: string; average_unit_cost: number; as_of: string; source: string };
type StoredMovement = { payload: string };
const accountKey = (value: unknown) => value == null || String(value).trim() === "" ? null : String(value).trim().toUpperCase();
export async function GET(request: Request) {
  const userId = authenticatedUserId(request);
  if (!userId) return Response.json({ detail: "Autenticação necessária." }, { status: 401 });
  try {
    const [stored, costs, movements] = await Promise.all([
      env.DB.prepare(`WITH latest_imports AS (
          SELECT i.id FROM imports i
          WHERE i.user_id=? AND i.status='processed' AND i.file_type IN ('positions', 'pension_statement')
            AND i.id=(SELECT latest.id FROM imports latest WHERE latest.user_id=i.user_id
              AND latest.owner=i.owner AND latest.file_type=i.file_type AND latest.status='processed'
              ORDER BY latest.reference_date DESC,latest.created_at DESC,latest.rowid DESC LIMIT 1)
        )
        SELECT i.owner AS import_owner, COALESCE(i.reference_date, '') AS import_date,
          CASE WHEN latest.id IS NULL THEN 0 ELSE 1 END AS is_latest_snapshot, r.payload
        FROM import_records r JOIN imports i ON i.id=r.import_id
        LEFT JOIN latest_imports latest ON latest.id=i.id
        WHERE i.user_id=? AND i.status='processed' AND i.file_type IN ('positions', 'pension_statement')
          AND r.record_kind='position' ORDER BY i.reference_date, i.created_at, r.id LIMIT 12000`)
        .bind(userId, userId).all<Stored>(),
      env.DB.prepare(`SELECT owner, instrument_code, average_unit_cost, as_of, source FROM cost_basis
        WHERE user_id=? ORDER BY as_of LIMIT 3000`).bind(userId).all<Cost>().catch(() => ({ results: [] as Cost[] })),
      env.DB.prepare(`SELECT r.payload FROM import_records r JOIN imports i ON i.id=r.import_id
        WHERE i.user_id=? AND i.status='processed' AND i.file_type='movements'
          AND r.record_kind='movement' ORDER BY i.created_at, r.id LIMIT 10000`)
        .bind(userId).all<StoredMovement>().catch(() => ({ results: [] as StoredMovement[] })),
    ]);
    const groups = new Map<string, FixedIncomeGroup>();
    for (const row of stored.results) {
      try {
        const item = JSON.parse(row.payload) as Record<string, unknown>;
        const assetClass = String(item.asset_class ?? "");
        if (!new Set(["fixed_income", "treasury", "international_fixed_income", "private_pension"]).has(assetClass)) continue;
        const owner = String(item.owner ?? row.import_owner);
        const code = normalizedCode(item.instrument_code || item.product_name);
        const raw = typeof item.raw === "object" && item.raw !== null ? item.raw as Record<string, unknown> : {};
        const issuer = String(item.issuer ?? raw["Emissor"] ?? raw["Emisor"] ?? "").trim();
        const date = String(item.reference_date ?? row.import_date);
        const quantity = Number(item.quantity ?? 0);
        const maturityDate = String(item.maturity_date ?? "");
        const valuation = b3Valuation(item);
        const derivedPrice = valuation.unit_price > 0 ? valuation.unit_price
          : quantity > 0 ? valuation.market_value_cents / 100 / quantity : 0;
        if (!owner || !code || !date || quantity <= 0 || derivedPrice <= 0) continue;
        const institution = String(item.institution ?? "").trim();
        const account = item.account == null || String(item.account).trim() === "" ? null : String(item.account).trim();
        // Keep parallel custody positions separate. When B3 omits Conta, institution
        // is the narrowest evidenced scope available; it is not a confirmed account ID.
        const key = JSON.stringify([owner, institution, account, code]);
        const current = groups.get(key);
        const isLatestSnapshot = row.is_latest_snapshot === 1;
        const observation = { date, unitPrice: derivedPrice, source: valuation.price_source };
        if (!current) {
          groups.set(key, { owner, account, instrumentCode: code, productName: String(item.product_name ?? code),
            institution, issuer, assetClass, quantity, maturityDate, latestDate: date,
            currentUnitPrice: derivedPrice, currentValueCents: valuation.market_value_cents,
            priceSource: valuation.price_source, observations: [observation], isCurrent: isLatestSnapshot });
        } else {
          current.observations.push(observation);
          if (date >= current.latestDate) {
            Object.assign(current, { quantity, maturityDate, latestDate: date, currentUnitPrice: derivedPrice,
              currentValueCents: valuation.market_value_cents, priceSource: valuation.price_source,
              productName: String(item.product_name ?? code), institution, account, isCurrent: isLatestSnapshot });
            current.issuer = issuer;
          }
        }
      } catch { /* invalid source rows stay excluded */ }
    }
    const movementHistory = new Map<string, { buys: Map<string, { quantity: number; total: number }>; unsafe: boolean }>();
    for (const row of movements.results) {
      try {
        const item = JSON.parse(row.payload) as Record<string, unknown>;
        const owner = String(item.owner ?? "");
        const institution = String(item.institution ?? "").trim();
        const raw = typeof item.raw === "object" && item.raw !== null ? item.raw as Record<string, unknown> : {};
        const account = accountKey(item.account ?? raw.Conta);
        const code = normalizedCode(item.instrument_code);
        const date = String(item.occurred_on ?? "");
        const eventType = String(item.event_type ?? "");
        const quantity = Number(item.quantity ?? 0);
        const unitPrice = Number(item.unit_price ?? 0);
        if (!owner || !institution || !code) continue;
        const key = JSON.stringify([owner, institution.toUpperCase(), account, code]);
        const history = movementHistory.get(key) ?? { buys: new Map(), unsafe: false };
        if (item.requires_review === true) history.unsafe = true;
        else if (eventType === "buy" && /^\d{4}-\d{2}-\d{2}$/.test(date) && quantity > 0 && unitPrice > 0) {
          const aggregate = history.buys.get(date) ?? { quantity: 0, total: 0 };
          aggregate.quantity += quantity;
          aggregate.total += quantity * unitPrice;
          history.buys.set(date, aggregate);
        } else if (eventType !== "interest" && eventType !== "income") history.unsafe = true;
        movementHistory.set(key, history);
      } catch { /* invalid movement rows stay excluded */ }
    }
    for (const group of groups.values()) {
      if (!group.isCurrent || !group.institution) continue;
      if (movements.results.length === 10000) continue;
      const history = movementHistory.get(JSON.stringify([group.owner, group.institution.toUpperCase(), accountKey(group.account), normalizedCode(group.instrumentCode)]));
      if (!history || history.unsafe || history.buys.size !== 1) continue;
      const [[date, aggregate]] = history.buys;
      const quantityTolerance = Math.max(0.000001, Math.abs(group.quantity) * 1e-8);
      if (!aggregate || Math.abs(aggregate.quantity - group.quantity) > quantityTolerance || date >= group.latestDate
        || group.observations.some((observation) => observation.date === date)) continue;
      group.observations.push({ date, unitPrice: aggregate.total / aggregate.quantity, source: "b3_movement" });
    }
    const items = buildFixedIncomeProjectionItems(groups.values(), costs.results);
    const covered = items.filter((item) => item.projected_value_cents !== null);
    const totalCurrent = items.reduce((sum, item) => sum + item.current_value_cents, 0);
    const coveredCurrent = covered.reduce((sum, item) => sum + item.current_value_cents, 0);
    const coveredProjected = covered.reduce((sum, item) => sum + (item.projected_value_cents ?? 0), 0);
    return Response.json({
      reference_date: items.map((item) => item.reference_date).sort().at(-1) ?? "",
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
