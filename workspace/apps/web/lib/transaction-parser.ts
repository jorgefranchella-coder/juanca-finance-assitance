export type TransactionDraft = {
  owner: string; side: "buy" | "sell"; instrumentCode: string; quantity: number;
  unitPrice: number; currency: "BRL" | "USD"; tradeDate: string; feesMinor: number;
  source: string; confidence: number; evidence: string;
};

function decimal(value: string) {
  const compact = value.replace(/\s/g, "");
  const normalized = compact.includes(",") ? compact.replace(/\./g, "").replace(",", ".") : compact;
  return Number(normalized);
}

function isoDate(value: string) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return validDate(value) ? value : null;
  const local = /^(\d{2})[/.](\d{2})[/.](\d{4})$/.exec(value);
  const iso = local ? `${local[3]}-${local[2]}-${local[1]}` : '';
  return validDate(iso) ? iso : null;
}

function validDate(value: string) {
  const stamp = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(stamp.getTime()) && stamp.toISOString().slice(0,10) === value;
}

export function parseTransactionText(text: string, owner: string): TransactionDraft[] {
  const compact = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
  const operation = /\b(comprei|compramos|compra|comprado|compre|buy|vendi|vendemos|venda|vendido|vender|sell)\b\s+(?:de\s+)?([\d.,]+)\s+(?:(?:cotas?|a[cç][oõ]es|unidades?)\s+)?(?:d[eo]\s+)?([A-Z]{1,8}(?:\d{1,2})?(?:\.[A-Z])?)/i.exec(compact);
  if (!operation) return [];
  const side = /^(vendi|vendemos|venda|vendido|vender|sell)$/i.test(operation[1]) ? "sell" : "buy";
  const quantity = decimal(operation[2]);
  const instrumentCode = operation[3].toUpperCase();
  const tail = compact.slice((operation.index ?? 0) + operation[0].length);
  const priceMatch = /(?:\ba\s+|precio|pre[cç]o(?:\s+(?:unit[aá]rio|m[eé]dio))?\s*(?:de|:)?\s*)(R\$|US\$|USD|BRL|\$)?\s*([\d.,]+)/i.exec(tail);
  if (!priceMatch) return [];
  const unitPrice = decimal(priceMatch[2]);
  if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(unitPrice) || unitPrice <= 0) return [];
  const explicitCurrency = priceMatch[1]?.toUpperCase();
  const currency: "BRL" | "USD" = explicitCurrency?.includes("US") || explicitCurrency === "$" || explicitCurrency === "USD"
    ? "USD" : explicitCurrency === "R$" || explicitCurrency === "BRL" || /\d/.test(instrumentCode) ? "BRL" : "USD";
  const dateMatch = /\b(\d{4}-\d{2}-\d{2}|\d{2}[/.]\d{2}[/.]\d{4})\b/.exec(compact);
  const tradeDate = dateMatch ? isoDate(dateMatch[1]) : null;
  if (!tradeDate || !explicitCurrency) return [];
  const feeMatch = /(?:taxas?|tasas?|comisiones?|custos?|fees?)\s*(?:de|:)?\s*(?:R\$|US\$|USD|BRL|\$)?\s*([\d.,]+)/i.exec(compact);
  const fees = feeMatch ? decimal(feeMatch[1]) : 0;
  return [{ owner, side, instrumentCode, quantity, unitPrice, currency, tradeDate,
    feesMinor: Number.isFinite(fees) ? Math.round(fees * 100) : 0, source: "chat_text",
    confidence: dateMatch ? 0.94 : 0.86, evidence: compact.slice(0, 500) }];
}

export function missingTransactionFields(text: string) {
  const normalized = text.trim();
  const missing: string[] = [];
  if (!/\b(compra|comprei|compre|venda|vendi|vendido|buy|sell)\b/i.test(normalized)) missing.push("se foi compra ou venda");
  if (!/\b\d+(?:[.,]\d+)?\s+(?:cotas?\s+|a[cç][oõ]es\s+|unidades?\s+)?[A-Z]{1,8}(?:\d{1,2})?(?:\.[A-Z])?\b/i.test(normalized)) missing.push("quantidade e código do ativo");
  if (!/(?:\ba\s+|precio|pre[cç]o)[^\d]{0,15}\d/i.test(normalized)) missing.push("preço unitário");
  if (!/\b(?:\d{4}-\d{2}-\d{2}|\d{2}[/.]\d{2}[/.]\d{4})\b/.test(normalized)) missing.push("data da operação");
  if (!/(?:R\$|US\$|\bUSD\b|\bBRL\b|\$)/i.test(normalized)) missing.push("moeda");
  return missing;
}
