/** Pure consolidation used by dashboard, positions and approval validation. */
export type SourceRow = { id: number; import_id: string; file_type: string; owner: string; reference_date: string | null; payload: string };
export type Quote = { market: string; symbol: string; price: number; provider: string; quoted_at: string };
export type Fx = { rate: number; date: string; provider?: string } | null;
export type Position = {
  owner: string; account: string | null; asset_class: string; product_name: string;
  institution: string; instrument_code: string; quantity: number; currency: string;
  current_unit_price: number; market_value_minor: number; market_value_cents: number | null;
  maturity_date: string | null; base_reference_date: string; reference_date: string; source: string; price_as_of: string;
};
export type Issue = { code: string; owner?: string; instrument_code?: string; record_id?: number };
export const codeOf = (value: unknown) => String(value ?? '').trim().toUpperCase().replace(/^(BVMF|NASDAQ|NYSE|NYSEARCA):/, '');

function decimal(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim() || value.trim() === '-') return null;
  const raw = value.replace(/R\$/g, '').replace(/\s/g, '');
  const normalized = raw.includes(',') ? raw.replace(/\./g, '').replace(',', '.') : raw;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function documentValue(item: Record<string, unknown>) {
  const raw = item.raw as Record<string, unknown> | undefined;
  for (const [field, price, source] of [
    ['Valor Atualizado MTM', 'Preço Atualizado MTM', 'b3_mtm'],
    ['Valor Atualizado FECHAMENTO', 'Preço Atualizado FECHAMENTO', 'b3_close'],
    ['Valor Atualizado CURVA', 'Preço Atualizado CURVA', 'b3_curve'],
    ['Valor Atualizado', 'Preço de Fechamento', 'b3_position'],
  ]) {
    const amount = decimal(raw?.[field]);
    if (amount !== null) return { value: Math.round(amount * 100), price: decimal(raw?.[price]) ?? Number(item.unit_price ?? 0), source };
  }
  return { value: Number(item.market_value_cents ?? item.market_value_minor ?? 0), price: Number(item.unit_price ?? 0), source: String(item.source ?? 'document') };
}

export function buildPortfolioView(snapshots: SourceRow[], trades: SourceRow[], quotes: Quote[], fx: Fx) {
  const positions: Position[] = [];
  const issues: Issue[] = [];
  const baseDates = new Map<string, string>();
  const quoteMap = new Map(quotes.map(q => [`${q.market}\0${codeOf(q.symbol)}`, q]));
  const identity = (owner: string, currency: string) => `${owner}\0${currency}`;
  for (const row of snapshots) {
    try {
      const item = JSON.parse(row.payload) as Record<string, unknown>;
      const owner = String(item.owner ?? row.owner);
      const currency = String(item.currency ?? (row.file_type === 'avenue_statement' ? 'USD' : 'BRL'));
      const date = String(item.reference_date ?? row.reference_date ?? '');
      const code = codeOf(item.instrument_code || item.product_name);
      const quantity = Number(item.quantity);
      if (!code || !date || !Number.isFinite(quantity)) throw new Error('invalid position');
      const val = documentValue(item);
      const quote = quoteMap.get(`${currency === 'USD' ? 'US' : 'B3'}\0${code}`);
      const unitPrice = quote?.price ?? val.price;
      const minor = quote ? Math.round(unitPrice * quantity * 100) : currency === 'USD' ? Number(item.market_value_minor ?? 0) : val.value;
      if (!Number.isFinite(unitPrice) || !Number.isFinite(minor)) throw new Error('invalid value');
      positions.push({ owner, account: item.account ? String(item.account) : null,
        asset_class: String(item.asset_class ?? 'other'), product_name: String(item.product_name ?? code),
        institution: String(item.institution ?? ''), instrument_code: code, quantity, currency,
        current_unit_price: unitPrice, market_value_minor: minor,
        market_value_cents: currency === 'USD' ? fx ? Math.round((quote ? unitPrice * quantity * 100 : minor) * fx.rate) : null : minor,
        maturity_date: item.maturity_date ? String(item.maturity_date) : null,
        base_reference_date: date, reference_date: date, source: quote?.provider ?? (row.file_type === 'avenue_statement' ? 'avenue_statement' : val.source), price_as_of: quote?.quoted_at ?? date });
      // Pension and B3 snapshots do not share an event cutoff.
      if (row.file_type !== 'pension_statement') baseDates.set(identity(owner, currency), date);
    } catch { issues.push({ code: 'invalid_source_row', record_id: row.id }); }
  }
  for (const row of trades) {
    try {
      const trade = JSON.parse(row.payload) as Record<string, unknown>;
      const owner = String(trade.owner ?? row.owner);
      const currency = String(trade.currency ?? 'BRL');
      const code = codeOf(trade.instrument_code);
      const date = String(trade.trade_date ?? '');
      const quantity = Number(trade.quantity);
      const price = Number(trade.unit_price);
      const side = String(trade.side);
      if (!code || !date || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(price) || price <= 0 || !['buy','sell'].includes(side)) throw new Error('invalid trade');
      const base = baseDates.get(identity(owner, currency));
      if (base && date < base) continue;
      if (base && date === base) { issues.push({ code: 'same_day_trade', owner, instrument_code: code, record_id: row.id }); continue; }
      if (!base && currency === 'USD') { issues.push({ code: 'missing_base', owner, instrument_code: code, record_id: row.id }); continue; }
      const candidates = positions.filter(p => p.owner === owner && p.currency === currency && p.instrument_code === code);
      if (candidates.length > 1) { issues.push({ code: 'ambiguous_account', owner, instrument_code: code, record_id: row.id }); continue; }
      let position = candidates[0];
      if (!position && side === 'sell') { issues.push({ code: 'unknown_position', owner, instrument_code: code, record_id: row.id }); continue; }
      if (!position) {
        position = { owner, account: trade.account ? String(trade.account) : null, currency, instrument_code: code,
          asset_class: String(trade.asset_class ?? (currency === 'USD' ? 'international_equity' : 'equity')),
          product_name: String(trade.product_name ?? code), institution: String(trade.institution ?? 'Informado no chat'),
          quantity: 0, current_unit_price: price, market_value_minor: 0, market_value_cents: 0,
          maturity_date: null, base_reference_date: base ?? '', reference_date: date, price_as_of: date, source: 'transaction_chat' };
        positions.push(position);
      }
      position.quantity += side === 'sell' ? -quantity : quantity;
      position.reference_date = date;
      const quote = quoteMap.get(`${currency === 'USD' ? 'US' : 'B3'}\0${code}`);
      position.current_unit_price = quote?.price ?? price;
      position.price_as_of = quote?.quoted_at ?? date;
      position.source = quote?.provider ?? String(trade.source ?? 'transaction_chat');
      position.market_value_minor = Math.round(position.quantity * position.current_unit_price * 100);
      position.market_value_cents = currency === 'USD' ? fx ? Math.round((quote ? position.current_unit_price * position.quantity * 100 : position.market_value_minor) * fx.rate) : null : position.market_value_minor;
      if (position.quantity < -0.000001) {
        position.market_value_cents = null;
        issues.push({ code: 'negative_position', owner, instrument_code: code, record_id: row.id });
      }
      if (currency === 'USD') {
        const cash = positions.find(p => p.owner === owner && p.currency === 'USD' && p.instrument_code === 'USD_CASH');
        if (cash) {
          const principal = Number(trade.principal_minor ?? Math.round(quantity * price * 100));
          const fees = Number(trade.fees_minor ?? 0);
          cash.market_value_minor += side === 'sell' ? principal - fees : -(principal + fees);
          cash.quantity = cash.market_value_minor / 100;
          cash.market_value_cents = fx ? Math.round(cash.market_value_minor * fx.rate) : null;
          cash.reference_date = date;
        }
      }
    } catch { issues.push({ code: 'invalid_trade', record_id: row.id }); }
  }
  const visible = positions.filter(p => p.currency !== 'USD' || Math.abs(p.quantity) > 0.000001);
  for (const p of visible) if (p.market_value_cents === null && !issues.some(i => i.code === 'negative_position' && i.owner === p.owner && i.instrument_code === p.instrument_code)) {
    issues.push({ code: 'missing_fx', owner: p.owner, instrument_code: p.instrument_code });
  }
  return { positions: visible, total_value_cents: visible.reduce((sum,p) => sum + (p.market_value_cents ?? 0),0),
    valuation_complete: issues.length === 0, issues, unvalued_count: visible.filter(p => p.market_value_cents === null).length,
    reference_date: visible.map(p => p.reference_date).sort().at(-1) ?? '', ptax: fx };
}
