import { env } from "cloudflare:workers";
import { authenticatedUserId, ensureReviewDecisionsSchema } from "@/lib/reviews";
import { loadQuotes } from "@/lib/valuation";

import { loadPortfolioView } from "@/lib/portfolio-storage";

export const dynamic = "force-dynamic";

type StoredRecord = { payload: string; decision?: string | null };

const allocationLabels: Record<string, string> = {
  fixed_income: "Renda fixa bancária",
  treasury: "Tesouro Direto",
  equity: "Ações",
  bdr: "BDRs",
  etf: "ETFs",
  fund: "Fundos listados",
  other: "Outros ativos B3",
  international_equity: "Ações e ETFs internacionais",
  international_fixed_income: "Renda fixa internacional",
  money_market: "Fundo monetário em USD",
  cash: "Caixa em USD",
  private_pension: "Previdência privada",
};

const activityLabels: Record<string, string> = {
  redemptions: "Resgates",
  transfers: "Transferências",
  income: "Juros e rendimentos",
  buys: "Compras",
  sells: "Vendas",
  amortizations: "Amortizações",
};

function activityGroup(eventType: string): string | null {
  if (eventType === "maturity" || eventType === "early_redemption") return "redemptions";
  if (eventType === "transfer_in" || eventType === "transfer_out" || eventType === "custody_transfer") return "transfers";
  if (["jcp", "dividend", "interest", "income"].includes(eventType)) return "income";
  if (eventType === "buy") return "buys";
  if (eventType === "sell") return "sells";
  if (eventType === "amortization") return "amortizations";
  return null;
}

export async function GET(request: Request) {
  const userId = authenticatedUserId(request);
  if (!userId) return Response.json({ detail: "Autenticação necessária." }, { status: 401 });

  try {
    await ensureReviewDecisionsSchema();
    const view = await loadPortfolioView(userId);
    const movementsStored = await env.DB.prepare(`SELECT r.payload,d.decision
      FROM import_records r JOIN imports i ON i.id=r.import_id
      LEFT JOIN review_decisions d ON d.import_record_id=r.id AND d.user_id=i.user_id
      WHERE i.user_id=? AND i.status='processed' AND i.file_type='movements'
        AND i.id=(SELECT latest.id FROM imports latest WHERE latest.user_id=i.user_id
          AND latest.owner=i.owner AND latest.file_type='movements' AND latest.status='processed'
          ORDER BY latest.reference_date DESC,latest.created_at DESC,latest.rowid DESC LIMIT 1)`)
      .bind(userId).all<StoredRecord>();
    const owners: Record<string, number> = {};
    const classes: Record<string, number> = {};
    for (const item of view.positions) {
      owners[item.owner] = (owners[item.owner] ?? 0) + (item.market_value_cents ?? 0);
      classes[item.asset_class] = (classes[item.asset_class] ?? 0) + (item.market_value_cents ?? 0);
    }
    const quotes = await loadQuotes(userId);
    const quoteRows = Array.from(quotes.values());
    const usQuotes = quoteRows.filter(q => q.market === 'US');
    const avenue = view.positions.filter(p=>p.currency==='USD');
    const pension = view.positions.filter(p=>p.asset_class==='private_pension');
    const allocation = Object.entries(classes).map(([key,value_cents])=>({key,
      label: allocationLabels[key] ?? allocationLabels.other,value_cents,
      share: view.total_value_cents ? value_cents/view.total_value_cents*100 : 0,
    })).sort((a,b)=>b.value_cents-a.value_cents);
    const activity: Record<string, { count: number; value_cents: number }> = {};
    let firstMovementDate = "";
    let lastMovementDate = "";
    for (const row of movementsStored.results) {
      try {
        const item = JSON.parse(row.payload) as Record<string, unknown>;
        if (row.decision === "ignored" || row.decision === "position_adjustment") continue;
        const eventType = row.decision || String(item.event_type ?? "");
        const group = activityGroup(eventType);
        if (!group) continue;
        const value = Number(item.operation_value_cents ?? 0);
        activity[group] ??= { count: 0, value_cents: 0 };
        activity[group].count += 1;
        activity[group].value_cents += Number.isFinite(value) ? Math.abs(value) : 0;
        const date = String(item.occurred_on ?? "");
        if (date && (!firstMovementDate || date < firstMovementDate)) firstMovementDate = date;
        if (date > lastMovementDate) lastMovementDate = date;
      } catch {
        // Invalid source rows are excluded from activity rather than guessed.
      }
    }

    return Response.json({
      total_value_cents: view.total_value_cents,
      portfolio_version: view.portfolio_version, facts_revision: view.facts_revision,
      valuation_complete: view.valuation_complete, issues: view.issues, unvalued_count: view.unvalued_count,
      owners: Object.entries(owners).map(([owner, value_cents]) => ({ owner, value_cents })),
      allocation,
      reference_date: view.reference_date,
      activity: Object.entries(activity).map(([key, value]) => ({ key, label: activityLabels[key], ...value })),
      activity_period: { from: firstMovementDate, to: lastMovementDate },
      coverage: pension.length ? (avenue.length ? "b3_avenue_pension" : "b3_pension") : avenue.length ? "b3_avenue" : "b3_only",
      sources: {
        avenue_positions: avenue.length,
        pension_positions: pension.length,
        avenue_value_usd_minor: avenue.reduce((sum, item) => sum + item.market_value_minor, 0),
        ptax: view.ptax,
        us_quote_count: usQuotes.length,
        latest_us_quote: usQuotes.map((quote) => quote.quoted_at).sort().at(-1) ?? null,
        quote_status: avenue.length
          ? (quoteRows.length ? "market_quotes_with_fixed_income_mtm" : "document_prices_with_fixed_income_mtm")
          : "not_applicable",
      },
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return Response.json(
      { detail: "Não foi possível calcular os indicadores agora." },
      { status: 500, headers: { "Cache-Control": "private, no-store" } },
    );
  }
}
