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
  source_page?: number;
  source_line?: number;
  statement_coverage?: "verified";
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
  const result = `${match[3]}-${months[match[1]]}-${match[2]}`;
  const parsed = new Date(`${result}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0,10) !== result) throw new Error("Data-base do extrato Avenue inválida.");
  return result;
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

type StatementIssue = {code:string;page:number;line:number;excerpt:string};
export function analyzeAvenueStatement(pages:string[],owner:string):{positions:AvenuePosition[];issues:StatementIssue[];reference_date:string;coverage:{declared_total_minor:number|null;cash_minor:number|null;invested_minor:number;complete:boolean}} {
 const allText=pages.join("\n");
 if(!allText.includes("PORTFOLIO SUMMARY")||!allText.includes("TOTAL PRICED PORTFOLIO"))throw new Error("Este PDF não parece ser um extrato mensal da Avenue.");
 const referenceDate=statementDate(allText),account=statementAccount(allText),positions:AvenuePosition[]=[],issues:StatementIssue[]=[];
 const accounts=[...allText.matchAll(/AVENUE ACCOUNT NUMBER:\s*([A-Z0-9-]+)/gi)].map(m=>m[1].toUpperCase());
 if(new Set(accounts).size!==1)issues.push({code:accounts.length?'multiple_accounts':'account_missing',page:0,line:0,excerpt:''});
 let assetClass:AvenuePosition['asset_class']|null=null,pendingDescription='',declaredTotal:number|null=null,cash:number|null=null;
 const totals:Array<{value:number;page:number;line:number;kind:string}>=[];
 const amount=(line:string)=>{const m=/\$\s*([0-9][0-9,]*\.[0-9]{2})\b/.exec(line);if(!m||!/^\d{1,3}(?:,\d{3})*(?:\.\d{2})$|^\d+\.\d{2}$/.test(m[1]))return null;const n=usdMinor(m[1]);return Number.isSafeInteger(n)?n:null;};
 for(let pageIndex=0;pageIndex<pages.length;pageIndex++){
  if(!pages[pageIndex].trim())issues.push({code:'empty_page',page:pageIndex+1,line:0,excerpt:''});
  const lines=pages[pageIndex].split(/\r?\n/);
  for(let lineIndex=0;lineIndex<lines.length;lineIndex++){
   const line=lines[lineIndex].trim();if(!line)continue;
   if(/TOTAL PRICED PORTFOLIO/i.test(line)){const total=amount(line);if(total!==null){if(declaredTotal!==null&&declaredTotal!==total)issues.push({code:'conflicting_totals',page:pageIndex+1,line:lineIndex+1,excerpt:line.slice(0,200)});declaredTotal=total;}assetClass=null;pendingDescription='';continue;}
   if(/^Total Cash(?:\s|\()/i.test(line)){const value=amount(line);if(value!==null){if(cash!==null&&cash!==value)issues.push({code:'conflicting_cash_totals',page:pageIndex+1,line:lineIndex+1,excerpt:line.slice(0,200)});cash=value;}continue;}
   if(line==='EQUITIES / OPTIONS'){assetClass='international_equity';pendingDescription='';continue;}
   if(line==='FIXED INCOME'){assetClass='international_fixed_income';pendingDescription='';continue;}
   if(line==='MUTUAL FUND'){assetClass='money_market';pendingDescription='';continue;}
   const subtotal=/^Total (Equities|Fixed Income|Mutual Funds?)/i.exec(line);
   if(subtotal){const value=amount(line);if(value!==null)totals.push({value,page:pageIndex+1,line:lineIndex+1,kind:subtotal[1].toLowerCase()});assetClass=null;pendingDescription='';continue;}
   if(/^Mutual Fund \$/i.test(line)){assetClass=null;pendingDescription='';continue;}
   if(!assetClass){if(positionPattern.test(line))issues.push({code:'position_without_section',page:pageIndex+1,line:lineIndex+1,excerpt:line.slice(0,200)});continue;}
   if(/^(DESCRIPTION|SYMBOL\/|CUSIP|ACCOUNT|TYPE|MARKET|VALUE|LAST PERIOD|EST\.|ANNUAL|INCOME|% OF TOTAL|PORTFOLIO|PAGE |July |All investment|Excess cash|Total cost)/i.test(line))continue;
   const match=positionPattern.exec(line);
   if(match){
    const quantity=decimal(match[3]),unitPrice=decimal(match[4]),marketValueMinor=usdMinor(match[5]);
    if([match[3],match[4],match[5]].some(value=>!/^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/.test(value))||!Number.isFinite(quantity)||!Number.isFinite(unitPrice)||!Number.isSafeInteger(marketValueMinor)||quantity<=0||unitPrice<=0||marketValueMinor<0){issues.push({code:'invalid_position',page:pageIndex+1,line:lineIndex+1,excerpt:line.slice(0,200)});pendingDescription='';continue;}
    positions.push({kind:'position',source:'avenue',owner,asset_class:assetClass,product_name:cleanStatementDescription([pendingDescription,match[1].trim()].filter(Boolean).join(' '))||match[2],institution:'Avenue',account,instrument_code:match[2],quantity,unit_price:unitPrice,market_value_minor:marketValueMinor,currency:'USD',reference_date:referenceDate,source_page:pageIndex+1,source_line:lineIndex+1});pendingDescription='';
   }else if(/\b[A-Z0-9.]{1,10}\s+[A-Z]\s+\d|\$\s*[\d,.]+/.test(line)){
    issues.push({code:'unrecognized_position',page:pageIndex+1,line:lineIndex+1,excerpt:line.slice(0,200)});pendingDescription='';
   }else if(!/^(PORTFOLIO SUMMARY|Total Cash)/.test(line))pendingDescription=`${pendingDescription} ${line}`.trim();
  }
 }
 const invested=positions.reduce((sum,p)=>sum+p.market_value_minor,0);
 if(!positions.length)issues.push({code:'no_positions',page:0,line:0,excerpt:''});
 for(const total of totals){const kind=total.kind.startsWith('equit')?'international_equity':total.kind.startsWith('fixed')?'international_fixed_income':'money_market';const actual=positions.filter(p=>p.asset_class===kind).reduce((sum,p)=>sum+p.market_value_minor,0);if(actual!==total.value)issues.push({code:'subtotal_mismatch',page:total.page,line:total.line,excerpt:total.kind});}
 if(declaredTotal===null)issues.push({code:'portfolio_total_unavailable',page:0,line:0,excerpt:''});
 else if(invested+(cash??0)!==declaredTotal)issues.push({code:'portfolio_total_mismatch',page:0,line:0,excerpt:''});
 const complete=issues.length===0;
 return{positions:complete?positions.map(p=>({...p,statement_coverage:'verified' as const})):positions,issues,reference_date:referenceDate,coverage:{declared_total_minor:declaredTotal,cash_minor:cash,invested_minor:invested,complete}};
}
export function parseAvenueStatement(pages:string[],owner:string):AvenuePosition[]{
 const result=analyzeAvenueStatement(pages,owner);if(result.issues.length)throw new Error('AVENUE_STATEMENT_REVIEW_REQUIRED');return result.positions;
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
