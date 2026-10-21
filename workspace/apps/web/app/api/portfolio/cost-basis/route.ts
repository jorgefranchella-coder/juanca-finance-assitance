import { env } from "cloudflare:workers";
import { authenticatedUserId } from "@/lib/reviews";
import { ensureValuationSchema, loadCostBasis, normalizedCode } from "@/lib/valuation";
import { loadPortfolioView } from "@/lib/portfolio-storage";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const userId = authenticatedUserId(request);
  if (!userId) return Response.json({ detail: "Autenticação necessária." }, { status: 401 });
  const costs = await loadCostBasis(userId);
  const url = new URL(request.url);
  const owner = url.searchParams.get("owner");
  const instrument = normalizedCode(url.searchParams.get("instrument_code"));
  const history = owner && instrument ? await env.DB.prepare(`SELECT request_id, owner, instrument_code,
    currency, quantity, average_unit_cost, as_of, source, institution, account, recorded_at
    FROM cost_basis_history WHERE user_id=? AND owner=? AND instrument_code=?
    ORDER BY id DESC LIMIT 50`).bind(userId, owner, instrument).all() : { results: [] };
  return Response.json({ costs: Array.from(costs.values()), history: history.results }, { headers: { "Cache-Control": "private, no-store" } });
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
    const requestId = String(input.request_id ?? "");
    const institution = String(input.institution ?? "").trim() || null;
    const account = String(input.account ?? "").trim() || null;
    if (!["Jorge", "Julia"].includes(owner) || !instrument || !["BRL", "USD"].includes(currency)
      || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(average) || average < 0
      || !/^\d{4}-\d{2}-\d{2}$/.test(asOf) || !/^[0-9a-f-]{36}$/i.test(requestId)) {
      return Response.json({ detail: "Dados de custo inválidos." }, { status: 400 });
    }
    const portfolio = await loadPortfolioView(userId);
    const matchingPositions = portfolio.positions.filter((position) => position.owner === owner
      && normalizedCode(position.instrument_code) === instrument && position.currency === currency);
    if (matchingPositions.length > 1) {
      return Response.json({ detail: "Este ativo aparece en más de una posición. Primero hay que identificar la cuenta para no mezclar costos." }, { status: 409 });
    }
    await ensureValuationSchema();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO cost_basis_history
        (user_id, request_id, owner, instrument_code, currency, quantity, average_unit_cost, as_of, source, institution, account)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?) ON CONFLICT(user_id, request_id) DO NOTHING`)
        .bind(userId, requestId, owner, instrument, currency, quantity, average, asOf, institution, account),
      env.DB.prepare(`INSERT INTO cost_basis
      (user_id, owner, instrument_code, currency, quantity, average_unit_cost, as_of, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'manual')
      ON CONFLICT(user_id, owner, instrument_code, currency) DO UPDATE SET
        quantity = excluded.quantity, average_unit_cost = excluded.average_unit_cost,
        as_of = excluded.as_of, source = excluded.source, updated_at = CURRENT_TIMESTAMP`)
      .bind(userId, owner, instrument, currency, quantity, average, asOf),
    ]);
    return Response.json({ saved: true, request_id: requestId });
  } catch {
    return Response.json({ detail: "Não foi possível salvar o custo de aquisição." }, { status: 422 });
  }
}
