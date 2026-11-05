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
  source_page?: number;
  source_line?: number;
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

const usNumber = "(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\\.[0-9]+)?";
const tradePattern = new RegExp(`^1\\s+([BS])\\s+(\\d{2}/\\d{2}/\\d{2})\\s+(\\d{2}/\\d{2}/\\d{2})\\s+(${usNumber})\\s+([A-Z0-9.]+)\\s+(${usNumber})\\s+(${usNumber})\\s+(${usNumber})\\s+(${usNumber})\\s+(${usNumber})(?=\\s|$)`);
type AvenueIssue = {code:string;page:number;line:number;excerpt:string};
export function analyzeAvenueConfirmations(pages:string[],owner:string):{trades:AvenueTrade[];issues:AvenueIssue[]} {
 const allText=pages.join("\n");
 if(!allText.includes("Account cleared by")||!allText.includes("Trade Date"))throw new Error("Este PDF não parece ser uma nota de corretagem da Avenue.");
 const references=[...allText.matchAll(/Account Number:\s*([A-Z0-9-]+)/gi)].map(m=>m[1].toUpperCase());
 const issues:AvenueIssue[]=[],trades:AvenueTrade[]=[];
 const unique=new Set(references);
 if(unique.size!==1)issues.push({code:unique.size?'multiple_accounts':'account_missing',page:0,line:0,excerpt:''});
 let priorAccount:string|null=null;
 for(let pageIndex=0;pageIndex<pages.length;pageIndex++){
  const lines=pages[pageIndex].split(/\r?\n/);let pageAccount:string|null=null;
  const continuation=/\b(?:continued from|continuation of) (?:the )?previous page\b/i.test(pages[pageIndex]);
  for(let index=0;index<lines.length;index++){
   const line=lines[index].trim(),accountMatch=/Account Number:\s*([A-Z0-9-]+)/i.exec(line);
   if(accountMatch)pageAccount=accountMatch[1].toUpperCase();
   if(!/^\d+\s+[BS]\s+/i.test(line))continue;
   const match=tradePattern.exec(line),account=pageAccount??(continuation?priorAccount:null);
   if(!account)issues.push({code:'account_context_missing',page:pageIndex+1,line:index+1,excerpt:line.slice(0,300)});
   if(!match){issues.push({code:'unrecognized_trade',page:pageIndex+1,line:index+1,excerpt:line.slice(0,300)});continue;}
   const detail=lines[index+1]?.trim()??"";
   try{for(const rawDate of [match[2],match[3]]){const value=isoUsDate(rawDate),parsed=new Date(`${value}T00:00:00Z`);if(Number.isNaN(parsed.valueOf())||parsed.toISOString().slice(0,10)!==value)throw new Error('INVALID_DATE');}if(!(decimal(match[4])>0)||!(decimal(match[6])>0)||![match[4],match[6],match[7],match[8],match[9],match[10]].every(v=>Number.isFinite(decimal(v))&&decimal(v)<Number.MAX_SAFE_INTEGER&&(v.split('.')[1]?.length??0)<=10))throw new Error('INVALID_NUMBER');trades.push({kind:'trade',source:'avenue',owner,account,side:match[1]==='B'?'buy':'sell',trade_date:isoUsDate(match[2]),settlement_date:isoUsDate(match[3]),quantity:decimal(match[4]),instrument_code:match[5],unit_price:decimal(match[6]),principal_minor:usdMinor(match[7]),fees_minor:usdMinor(match[8])+usdMinor(match[9])+usdMinor(match[10]),product_name:/^Desc:\s*(.*?)\s+Interest\/STTax:/.exec(detail)?.[1]?.trim()??match[5],cusip:/CUSIP:\s*([A-Z0-9]+)/.exec(detail)?.[1]??null,currency:'USD',source_page:pageIndex+1,source_line:index+1});}catch{issues.push({code:'invalid_trade',page:pageIndex+1,line:index+1,excerpt:line.slice(0,300)});}
  }
  if(pageAccount)priorAccount=pageAccount;
 }
 if(!trades.length&&!issues.length)issues.push({code:'no_trades',page:0,line:0,excerpt:''});
 return {trades,issues};
}
export function parseAvenueConfirmations(pages:string[],owner:string):AvenueTrade[] {
 const result=analyzeAvenueConfirmations(pages,owner);
 if(result.issues.length)throw new Error('AVENUE_CONFIRMATION_REVIEW_REQUIRED');
 return result.trades;
}
