import { env } from "cloudflare:workers";
import { authenticatedUserId } from "@/lib/reviews";
import { ensureValuationSchema, loadCostBasis, normalizedCode } from "@/lib/valuation";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const userId = authenticatedUserId(request);
  if (!userId) return Response.json({ detail: "Autenticação necessária." }, { status: 401 });
  const costs = await loadCostBasis(userId);
  return Response.json({ costs: Array.from(costs.values()) }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request) {
  const userId = authenticatedUserId(request);
  if (!userId) return Response.json({ detail: "Autenticação necessária." }, { status: 401 });
  try {
    const input = await request.json() as Record<string, unknown>;
    const owner = String(input.owner ?? "");
    const instrument = normalizedCode(input.instrument_code);
    const currency = String(input.currency ?? "").toUpperCase();
    const quantity = Number(input.quantity);
    const average = Number(input.average_unit_cost);
    const asOf = String(input.as_of ?? "");
    if (!["Jorge", "Julia"].includes(owner) || !instrument || !["BRL", "USD"].includes(currency)
      || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(average) || average < 0
      || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
      return Response.json({ detail: "Dados de custo inválidos." }, { status: 400 });
    }
    await ensureValuationSchema();
    await env.DB.prepare(`INSERT INTO cost_basis
      (user_id, owner, instrument_code, currency, quantity, average_unit_cost, as_of, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'manual')
      ON CONFLICT(user_id, owner, instrument_code, currency) DO UPDATE SET
        quantity = excluded.quantity, average_unit_cost = excluded.average_unit_cost,
        as_of = excluded.as_of, source = excluded.source, updated_at = CURRENT_TIMESTAMP`)
      .bind(userId, owner, instrument, currency, quantity, average, asOf).run();
    return Response.json({ saved: true });
  } catch {
    return Response.json({ detail: "Não foi possível salvar o custo de aquisição." }, { status: 422 });
  }
}
