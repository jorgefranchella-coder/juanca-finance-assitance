export type AvenuePosition = {
  kind: "position";
  source: "avenue";
  owner: string;
  asset_class: "international_equity" | "international_fixed_income" | "money_market" | "cash";
  product_name: string;
  institution: "Avenue";
  account: string | null;
  instrument_code: string;
  quantity: number;
  unit_price: number;
  market_value_minor: number;
  currency: "USD";
  reference_date: string;
};

export type AvenueTrade = {
  kind: "trade";
  source: "avenue";
  owner: string;
  account: string | null;
  side: "buy" | "sell";
  trade_date: string;
  settlement_date: string;
  instrument_code: string;
  product_name: string;
  cusip: string | null;
  quantity: number;
  unit_price: number;
  principal_minor: number;
  fees_minor: number;
  currency: "USD";
};

function decimal(value: string): number {
  return Number(value.replace(/[$,]/g, ""));
}

function usdMinor(value: string): number {
  return Math.round(decimal(value) * 100);
}

function isoUsDate(value: string): string {
  const match = /^(\d{2})\/(\d{2})\/(\d{2}|\d{4})$/.exec(value);
  if (!match) throw new Error("Data Avenue não reconhecida.");
  const year = match[3].length === 2 ? `20${match[3]}` : match[3];
  return `${year}-${match[1]}-${match[2]}`;
}

const months: Record<string, string> = {
  January: "01", February: "02", March: "03", April: "04", May: "05", June: "06",
  July: "07", August: "08", September: "09", October: "10", November: "11", December: "12",
};

function statementDate(text: string): string {
  const match = /-\s+([A-Z][a-z]+)\s+(\d{2}),\s+(\d{4})/.exec(text);
  if (!match || !months[match[1]]) throw new Error("Data-base do extrato Avenue não encontrada.");
  return `${match[3]}-${months[match[1]]}-${match[2]}`;
}

function statementAccount(text: string): string | null {
  return /AVENUE ACCOUNT NUMBER:\s*([A-Z0-9-]+)/.exec(text)?.[1] ?? null;
}

function cleanStatementDescription(value: string): string {
  let cleaned = value.trim();
  if (/customer@avenue\.us/i.test(cleaned)) {
    cleaned = cleaned.split(/customer@avenue\.us/i).at(-1)?.trim() ?? cleaned;
    cleaned = cleaned.replace(/^[A-ZÀ-ÖØ-Ý ]{5,}(?=[A-Z][a-z])/, "");
  }
  return cleaned.trim();
}

const positionPattern = /^(.*?)\s*([A-Z0-9]{1,10})\s+C\s+([\d,.]+)\s+([\d,.]+)\s+\$?\s*([\d,.]+)(?:\s|$)/;

export function parseAvenueStatement(pages: string[], owner: string): AvenuePosition[] {
  const allText = pages.join("\n");
  if (!allText.includes("PORTFOLIO SUMMARY") || !allText.includes("TOTAL PRICED PORTFOLIO")) {
    throw new Error("Este PDF não parece ser um extrato mensal da Avenue.");
  }
  const referenceDate = statementDate(pages[0] ?? allText);
  const account = statementAccount(allText);
  const positions: AvenuePosition[] = [];
  let assetClass: AvenuePosition["asset_class"] | null = null;
  let pendingDescription = "";

  for (const page of pages.slice(1, 3)) {
    for (const originalLine of page.split("\n")) {
      const line = originalLine.trim();
      if (!line) continue;
      if (line === "EQUITIES / OPTIONS") { assetClass = "international_equity"; pendingDescription = ""; continue; }
      if (line === "FIXED INCOME") { assetClass = "international_fixed_income"; pendingDescription = ""; continue; }
      if (line === "MUTUAL FUND") { assetClass = "money_market"; pendingDescription = ""; continue; }
      if (line.startsWith("Total Equities")) { assetClass = "international_fixed_income"; pendingDescription = ""; continue; }
      if (line.startsWith("Total Fixed Income")) { assetClass = null; pendingDescription = ""; continue; }
      if (line.startsWith("Mutual Fund $") || line.startsWith("TOTAL PRICED")) { assetClass = null; pendingDescription = ""; continue; }
      if (!assetClass || /^(DESCRIPTION|SYMBOL\/|CUSIP|ACCOUNT|TYPE|MARKET|VALUE|LAST PERIOD|EST\.|ANNUAL|INCOME|% OF TOTAL|PORTFOLIO|PAGE |July |All investment|Excess cash|Total cost)/.test(line)) continue;

      const match = positionPattern.exec(line);
      if (match) {
        const inlineDescription = match[1].trim();
        const instrumentCode = match[2];
        const quantity = decimal(match[3]);
        const unitPrice = decimal(match[4]);
        const marketValueMinor = usdMinor(match[5]);
        if (!Number.isFinite(quantity) || !Number.isFinite(unitPrice) || !Number.isFinite(marketValueMinor)) continue;
        positions.push({
          kind: "position",
          source: "avenue",
          owner,
          asset_class: assetClass,
          product_name: cleanStatementDescription([pendingDescription, inlineDescription].filter(Boolean).join(" ")) || instrumentCode,
          institution: "Avenue",
          account,
          instrument_code: instrumentCode,
          quantity,
          unit_price: unitPrice,
          market_value_minor: marketValueMinor,
          currency: "USD",
          reference_date: referenceDate,
        });
        pendingDescription = "";
      } else if (!/^(PORTFOLIO SUMMARY|Total Cash)/.test(line)) {
        pendingDescription = `${pendingDescription} ${line}`.trim();
      }
    }
  }

  if (positions.length < 2) throw new Error("Nenhuma posição reconhecida no extrato Avenue.");
  return positions;
}

const tradePattern = /^1\s+([BS])\s+(\d{2}\/\d{2}\/\d{2})\s+(\d{2}\/\d{2}\/\d{2})\s+([\d.]+)\s+([A-Z0-9.]+)\s+([\d,.]+)\s+([\d,.]+)\s+([\d,.]+)\s+([\d,.]+)\s+([\d,.]+)/;

export function parseAvenueConfirmations(pages: string[], owner: string): AvenueTrade[] {
  const allText = pages.join("\n");
  if (!allText.includes("Account cleared by") || !allText.includes("Trade Date")) {
    throw new Error("Este PDF não parece ser uma nota de corretagem da Avenue.");
  }
  const account = /Account Number:\s*([A-Z0-9-]+)/.exec(allText)?.[1] ?? null;
  const lines = allText.split("\n").map((line) => line.trim()).filter(Boolean);
  const trades: AvenueTrade[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = tradePattern.exec(lines[index]);
    if (!match) continue;
    const detail = lines[index + 1] ?? "";
    const description = /^Desc:\s*(.*?)\s+Interest\/STTax:/.exec(detail)?.[1]?.trim() ?? match[5];
    const cusip = /CUSIP:\s*([A-Z0-9]+)/.exec(detail)?.[1] ?? null;
    const commission = usdMinor(match[8]);
    const transactionFee = usdMinor(match[9]);
    const additionalFees = usdMinor(match[10]);
    trades.push({
      kind: "trade",
      source: "avenue",
      owner,
      account,
      side: match[1] === "B" ? "buy" : "sell",
      trade_date: isoUsDate(match[2]),
      settlement_date: isoUsDate(match[3]),
      quantity: decimal(match[4]),
      instrument_code: match[5],
      unit_price: decimal(match[6]),
      principal_minor: usdMinor(match[7]),
      fees_minor: commission + transactionFee + additionalFees,
      product_name: description,
      cusip,
      currency: "USD",
    });
  }
  if (!trades.length) throw new Error("Nenhuma operação reconhecida na nota Avenue.");
  return trades;
}
