import { env } from 'cloudflare:workers';
import { buildPortfolioView, type SourceRow, type Quote, type Fx } from './portfolio-view';
import { loadCostBasis } from './valuation';

export async function factsRevision(userId: string) {
  return Number((await env.DB.prepare('SELECT revision FROM portfolio_revisions WHERE user_id=?').bind(userId).first<{ revision: number }>())?.revision ?? 0);
}

export async function loadPortfolioView(userId: string) {
  const snapshotSql = `SELECT r.id,r.import_id,i.file_type,i.owner,i.reference_date,r.payload
    FROM import_records r JOIN imports i ON i.id=r.import_id
    WHERE i.user_id=? AND i.status='processed' AND r.record_kind='position'
      AND i.file_type IN ('positions','avenue_statement','pension_statement')
      AND i.id=(SELECT latest.id FROM imports latest
        WHERE latest.user_id=i.user_id AND latest.owner=i.owner AND latest.file_type=i.file_type AND latest.status='processed'
        ORDER BY latest.reference_date DESC,latest.created_at DESC,latest.rowid DESC LIMIT 1)
    ORDER BY i.owner,i.file_type,r.id`;
  const rows = await env.DB.batch([
    env.DB.prepare(snapshotSql).bind(userId),
    env.DB.prepare(`SELECT r.id,r.import_id,i.file_type,i.owner,i.reference_date,r.payload
      FROM import_records r JOIN imports i ON i.id=r.import_id
      WHERE i.user_id=? AND i.status='processed' AND r.record_kind='trade'
        AND i.file_type IN ('chat_transaction','avenue_confirmation')
      ORDER BY json_extract(r.payload,'$.trade_date'),i.created_at,r.id`).bind(userId),
    env.DB.prepare('SELECT market,symbol,price,provider,quoted_at FROM market_quotes WHERE user_id=? ORDER BY market,symbol').bind(userId),
    env.DB.prepare(`SELECT rate,quoted_at AS date,provider FROM fx_observations
      WHERE user_id=? AND pair='USD/BRL' AND quoted_at<=date('now') ORDER BY quoted_at DESC,id DESC LIMIT 1`).bind(userId),
    env.DB.prepare('SELECT revision FROM portfolio_revisions WHERE user_id=?').bind(userId),
  ]);
  const fx = rows[3].results[0] as Exclude<Fx, null> | undefined;
  const view = buildPortfolioView(rows[0].results as SourceRow[], rows[1].results as SourceRow[], rows[2].results as Quote[], fx ?? null);
  const revision = Number((rows[4].results[0] as { revision?: number } | undefined)?.revision ?? 0);
  const digest = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(rows.map(r=>r.results))));
  const portfolioVersion = Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
  return { ...view, facts_revision: revision, portfolio_version: portfolioVersion, count: view.positions.length };
}

export async function enrichCosts(userId: string, view: Awaited<ReturnType<typeof loadPortfolioView>>) {
  const costs = await loadCostBasis(userId);
  const identityCount = new Map<string, number>();
  for (const item of view.positions) {
    const key = `${item.owner}\0${item.instrument_code}\0${item.currency}`;
    identityCount.set(key, (identityCount.get(key) ?? 0) + 1);
  }
  return view.positions.map(item => {
    const cost = costs.get(`${item.owner}\0${item.instrument_code}`);
    const unambiguous = identityCount.get(`${item.owner}\0${item.instrument_code}\0${item.currency}`) === 1;
    const applicableCost = unambiguous ? cost : undefined;
    const converted = applicableCost && (applicableCost.currency !== 'USD' || view.ptax)
      ? Math.round(applicableCost.average_unit_cost * item.quantity * 100 * (applicableCost.currency === 'USD' ? view.ptax!.rate : 1)) : null;
    return { ...item, average_unit_cost: applicableCost?.average_unit_cost ?? null, cost_currency: applicableCost?.currency ?? null,
      cost_basis_cents: converted, unrealized_pnl_cents: converted === null || item.market_value_cents === null ? null : item.market_value_cents-converted,
      cost_source: applicableCost?.source ?? null, cost_as_of: applicableCost?.as_of ?? null,
      cost_status: cost && !unambiguous ? 'ambiguous_position' : applicableCost ? 'available' : 'missing' };
  });
}
