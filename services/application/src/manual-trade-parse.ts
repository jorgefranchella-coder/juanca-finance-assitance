import {Decimal} from 'decimal.js';

export const MANUAL_TRADE_PARSER_VERSION='manual-trade-v7-multiple-operations';
const VERSION=MANUAL_TRADE_PARSER_VERSION;
const ExactDecimal=Decimal.clone({precision:60});
type Side='buy'|'sell';
type Span={value:string;index:number;length:number};

function fold(value:string){return value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();}
function number(value:string):string|null {
 const raw=value.trim();
 if(!/^\d+(?:[.,]\d+)*$/.test(raw))return null;
 const comma=raw.includes(','),dot=raw.includes('.');
 if(comma&&dot){
  const decimal=raw.lastIndexOf(',')>raw.lastIndexOf('.')?',':'.',group=decimal===','?'.':',';
  const parts=raw.split(decimal);if(parts.length!==2||!/^\d+$/.test(parts[1]))return null;
  const groups=parts[0].split(group);if(!/^\d{1,3}$/.test(groups[0])||groups.slice(1).some(g=>!/^\d{3}$/.test(g)))return null;
  return groups.join('')+'.'+parts[1];
 }
 if(!comma&&!dot)return raw;
 const separator=comma?',':'.',parts=raw.split(separator);
 // A single group of three digits can be either a decimal or a thousands group.
 if(parts.length===2){if(parts[1].length===3)return null;return parts.join('.');}
 // Multiple separators are accepted only with proper groups; the last group still
 // makes this ambiguous between a grouped integer and a decimal with grouping.
 return null;
}
function isoDate(value:string):string|null {
 if(/^\d{4}-\d{2}-\d{2}$/.test(value)){
  const parsed=new Date(`${value}T00:00:00Z`);return !Number.isNaN(parsed.valueOf())&&parsed.toISOString().slice(0,10)===value?value:null;
 }
 const match=value.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/);if(!match)return null;
 const first=Number(match[1]),second=Number(match[2]),year=match[3];
 // Day-first is the family default; when one component exceeds 12 the order is unambiguous.
 const month=first>12?second:second>12?first:second,day=first>12?first:second>12?second:first;
 const result=`${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
 const parsed=new Date(`${result}T00:00:00Z`);return !Number.isNaN(parsed.valueOf())&&parsed.toISOString().slice(0,10)===result?result:null;
}
function detectSide(text:string):{side:Side|null;conflict:boolean;matches:Span[]} {
 const regex=/\b(comprei|compramos|compre|compra|comprar|comprado|adquiri|adquirimos|buy|bought|purchase|purchased|vendi|vendemos|venda|vender|vendeu|vendido|vendida|venta|vende|vendio|sell|sold|selling|sale)\b/g;
 const matches:Span[]=[];for(const match of text.matchAll(regex))matches.push({value:match[0],index:match.index??0,length:match[0].length});
 const sides=new Set(matches.map(match=>/^(comprei|compramos|compre|compra|comprar|comprado|adquiri|adquirimos|buy|bought|purchase|purchased)$/.test(match.value)?'buy':'sell'));
 return{side:sides.size===1?[...sides][0]:null,conflict:sides.size>1,matches};
}
const NON_TICKERS=new Set(['VENDA','VENDER','VENDE','VENDI','VENDEMOS','VENDEU','VENDIDO','VENDIDA','VENTA','SELL','SOLD','SELLING','SALE','BUY','BOUGHT','PURCHASE','PURCHASED','COMPRA','COMPRAR','COMPRE','COMPREI','COMPRAMOS','ADQUIRI','ADQUIRIMOS','ORDER','LIMIT','LIMITED','MARKET','EXECUTED','EXECUTADA','EXECUTADO','BRL','USD','EUR','RMB','QTY','QUANTITY','CANTIDAD','QUANTIDADE','SHARES','SHARE','ACCIONES','ACCION','ACOES','UNIDADES','UNIDADE','UNITS','UNIT','TOTAL','PRICE','PRECIO','PRECO','PREÇO','VALOR','DATE','DATA','FECHA','JORGE','JULIA']);
function detectInstrument(original:string,flat:string):string|null {
 const label=/\b(?:ticker|symbol|simbolo|ativo|asset|instrumento|instrument|codigo|code)\s*[:#=-]?\s*([A-Z][A-Z0-9]{1,9})/i.exec(original);
 if(label&&!NON_TICKERS.has(label[1].toUpperCase()))return label[1].toUpperCase();
 const values:Span[]=[];for(const match of original.matchAll(/\b[A-Z][A-Z0-9]{1,9}\b/g)){
  const value=match[0];if(value!==value.toUpperCase()||NON_TICKERS.has(value))continue;
  if(/^(?:R|US|BRL|USD|EUR)$/.test(value))continue;
  values.push({value,index:match.index??0,length:value.length});
 }
 if(!values.length)return null;
 // Tickers containing digits are less likely to be ordinary uppercase words such as VENDA.
 const selected=values.find(item=>/\d/.test(item.value))??values.find(item=>item.value.length>=3);
 if(selected)return selected.value;
 const lowerTicker=/\b([A-Z]{1,6}\d{1,5})\b/i.exec(flat);return lowerTicker?.[1]?.toUpperCase()??null;
}
function detectQuantity(flat:string,instrument:string|null):{value:string|null;invalid:boolean} {
 const n='(\\d[\\d.,]*)';
 const patterns=[
  new RegExp(`\\b(?:qty|quantity|cantidad|quantidade)\\b\\s*(?:de|of|is|=|:)?\\s*${n}`,'i'),
  new RegExp(`${n}\\s*(?:de|of)?\\s*(?:acciones?|acoes?|shares?|units?|unidades?|quotas?|cotas?|titulos?)\\b`,'i'),
 ];
 for(const pattern of patterns){const match=pattern.exec(flat);if(match){const parsed=number(match[1]);return {value:parsed,invalid:parsed===null};}}
 if(instrument){
  const index=flat.indexOf(instrument.toLowerCase());
  if(index>=0){
   const before=flat.slice(Math.max(0,index-80),index),after=flat.slice(index+instrument.length,index+instrument.length+80);
   const prior=new RegExp(`${n}\\s*(?:(?:de|of)\\s+)?$`,'i').exec(before);
   if(prior){const parsed=number(prior[1]);return {value:parsed,invalid:parsed===null};}
   const later=new RegExp(`^\\s*(?:(?:x|:|-)\\s*)?${n}\\b`,'i').exec(after);
   if(later){const parsed=number(later[1]);return {value:parsed,invalid:parsed===null};}
  }
 }
 return {value:null,invalid:false};
}
type AmountRole='unit_price'|'gross_total'|'net_total'|'total_unknown'|'fee'|'unknown';
type AmountCandidate={role:AmountRole;raw:string;value:string|null;currency:string;index:number;length:number};
function detectAmounts(original:string,quantity:string|null,side:Side|null) {
 const candidates:AmountCandidate[]=[];
 const regex=/(?:R\$|BRL\s*\$?|US\$|USD\s*\$?|EUR\s*€?|€|\$)\s*([\d.,]+)/gi;
 for(const match of original.matchAll(regex)){
  const index=match.index??0,raw=match[0].trim().toUpperCase();
  const currency=/^(?:US\$|USD)/.test(raw)?'USD':/^(?:€|EUR)/.test(raw)?'EUR':raw.startsWith('$')?'USD':'BRL';
  const prefix=fold(original.slice(Math.max(0,index-70),index)).split(/[;\n\r]/).pop()??'';
  let role:AmountRole='unknown';
  if(/\b(?:total\s+(?:liquido|liquida|neto|neta|net)|(?:net|neto|neto da operacao|liquido)\s+(?:total|amount|valor)|(?:net|liquid)\s+(?:proceeds|amount))\s*[:=]?\s*$/.test(prefix))role='net_total';
  else if(/\b(?:(?:total|valor)\s+(?:bruto|bruta|gross)|(?:gross|bruto)\s+(?:total|amount|valor)|principal)\s*[:=]?\s*$/.test(prefix))role='gross_total';
  else if(/\b(?:comissao|comision|corretagem|taxa|custos?|encargos?|fees?|commission|charges?|brokerage)\s*[:=]?\s*$/.test(prefix))role='fee';
  else if(/\b(?:total|valor total|total amount|amount total)\s*[:=]?\s*$/.test(prefix))role='total_unknown';
  else if(/\b(?:unit(?:ario|aria)?|preco(?:\s+unitario)?|precio(?:\s+unitario)?|price(?:\s+per\s+share)?|unit price|at|a|por|cada|per)\s*[:=]?\s*$/.test(prefix))role='unit_price';
  candidates.push({role,raw:match[0],value:number(match[1]),currency,index,length:match[0].length});
 }
 const prices=candidates.filter(item=>item.role==='unit_price');
 const chosen=prices.length===1?prices[0]:null;
 const fees=candidates.filter(item=>item.role==='fee');
 const hasFeeLabel=/\b(?:comissao|comision|corretagem|taxa|custos?|encargos?|fees?|commission|charges?|brokerage)\b/.test(fold(original));
 const reasons:string[]=[];
 if(prices.length>1)reasons.push('multiple_unit_prices_require_review');
 if(candidates.some(c=>c.role==='total_unknown'||c.role==='unknown'))reasons.push('amount_role_requires_review');
 if(candidates.some(item=>item.value===null))reasons.push('numeric_format_ambiguous_or_invalid');
 const currency=chosen?.currency??(new Set(candidates.map(c=>c.currency)).size===1?candidates[0]?.currency:null)??null;
 if(currency&&candidates.some(c=>c.currency!==currency))reasons.push('amount_currency_mismatch');
 let feesMinor:string|null='0';
 if(hasFeeLabel&&!fees.length){feesMinor=null;reasons.push('fees_require_review');}
 if(fees.length){
  if(fees.some(f=>!f.value||f.currency!==currency)){feesMinor=null;reasons.push('fees_require_review');}
  else {const cents=fees.reduce((sum,f)=>sum.add(new ExactDecimal(f.value!).mul(100)),new ExactDecimal(0));if(!cents.isInteger()){feesMinor=null;reasons.push('fees_require_review');}else feesMinor=cents.toFixed(0);}
 }
 const principal=quantity&&chosen?.value?new ExactDecimal(quantity).mul(chosen.value):null;
 if(principal&&currency){
  for(const item of candidates.filter(c=>c.value&&c.currency===currency&&(c.role==='gross_total'||c.role==='net_total'))){
   let expected:Decimal|null=principal;
   if(item.role==='net_total')expected=fees.length>0&&feesMinor!==null&&side?principal.add(new ExactDecimal(feesMinor).div(100).mul(side==='buy'?1:-1)):null;
   if(expected&&!expected.toDecimalPlaces(2,Decimal.ROUND_HALF_UP).eq(new ExactDecimal(item.value!).toDecimalPlaces(2,Decimal.ROUND_HALF_UP)))reasons.push('declared_amount_mismatch');
   if(!expected)reasons.push('net_total_requires_review');
  }
 }
 return {value:chosen?.value??null,currency,invalid:chosen?.value===null,reasons:[...new Set(reasons)],fees_minor:feesMinor,fees_assumed_zero:!hasFeeLabel,candidates};
}
// Keep exact source spans for separately described trades and OCR table rows.
function tradeCandidates(original:string):Span[] {
 const clauses:Span[]=[];
 for(const match of original.matchAll(/[^;\r\n]+/g)){
  const value=match[0],base=match.index??0,flat=fold(value),verbs=detectSide(flat).matches;
  // Split repeated trade verbs only if each segment contains its own ticker.
  const segments=verbs.length>1?verbs.map((v,i)=>({index:v.index,value:value.slice(v.index,verbs[i+1]?.index??value.length)})).filter(part=>detectInstrument(part.value,fold(part.value))):[];
  if(segments.length>1){for(const part of segments)clauses.push({value:part.value,index:base+part.index,length:part.value.length});continue;}
  // One action may describe several securities without repeating the verb.
  // Require a quantity adjacent to each ticker so an informational mention alone
  // does not turn a single trade into multiple operations.
  const quantified:Span[]=[];
  for(const ticker of value.matchAll(/\b[A-Z][A-Z0-9]{1,9}\b/g)){
   const code=ticker[0],index=ticker.index??0;if(NON_TICKERS.has(code))continue;
   const before=value.slice(Math.max(0,index-45),index),after=value.slice(index+code.length,index+code.length+45);
   const left=/(\d[\d.,]*)\s*(?:(?:de|of)\s+)?(?:(?:acoes?|acciones?|shares?|units?|unidades?)\s+)?$/i.exec(before);
   const right=/^\s*(?:(?:qty|quantity|cantidad|quantidade)\s*[:=]?\s*|[:x]\s*)?(\d[\d.,]*)\b/i.exec(after);
   if(left||right){const start=left?index-left[0].length:index;const end=right?index+code.length+right[0].length:index+code.length;quantified.push({value:value.slice(start,end),index:base+start,length:end-start});}
  }
  if(quantified.length>1){clauses.push(...quantified);continue;}
  const hasTicker=/\b[A-Z]{2,6}\d{0,5}\b/.test(value);
  const rowTicker=/\b([A-Z]{2,6}\d{0,5})\s+\d+(?:[.,]\d+)?\b/.exec(value);
  const tableRow=hasTicker&&!!rowTicker&&!NON_TICKERS.has(rowTicker[1])&&/(?:R\$|US\$|USD|BRL|EUR|€|\$)\s*[\d.,]+/i.test(value);
  if((verbs.length>0&&detectInstrument(value,flat))||tableRow)clauses.push({value,index:base,length:value.length});
 }
 return clauses.length>1?clauses:[];
}
export function interpretManualTrade(text:string,occurredOn:string|null) {
 const original=text.normalize('NFC'),flat=fold(original),sideResult=detectSide(flat);
 const instrument=detectInstrument(original,flat),quantity=detectQuantity(flat,instrument),price=detectAmounts(original,quantity.value,sideResult.side);
 const dateMatch=flat.match(/\b(\d{1,2}[/.\-]\d{1,2}[/.\-]\d{4}|\d{4}-\d{2}-\d{2})\b/);
 const tradeDate=dateMatch?isoDate(dateMatch[1]):occurredOn;
 const candidates=tradeCandidates(original),multiple=candidates.length>1;
 const fields={side:multiple?null:sideResult.side,instrument_code:multiple?null:instrument,quantity:multiple?null:quantity.value,unit_price:multiple?null:price.value,currency:multiple?null:price.currency,trade_date:multiple?null:tradeDate,fees_minor:price.fees_minor,fees_assumed_zero:price.fees_assumed_zero,...(price.candidates.some(c=>c.role!=='unit_price')||price.candidates.length>1?{amount_candidates:price.candidates}:{}),...(multiple?{source_candidates:candidates}:{})};
 const detected=sideResult.matches.length>0||!!instrument||!!price.value;
 const reviewReasons:string[]=[];
 if(multiple)reviewReasons.push('multiple_operations_require_separate_evidence');
 if(!sideResult.side)reviewReasons.push(sideResult.conflict?'side_conflict':'side_unresolved');
 if(!instrument)reviewReasons.push('instrument_unresolved');
 if(!quantity.value)reviewReasons.push('quantity_unresolved');
 if(quantity.invalid||price.invalid)reviewReasons.push('numeric_format_ambiguous_or_invalid');
 reviewReasons.push(...price.reasons.filter(reason=>!reviewReasons.includes(reason)));
 if(!price.value)reviewReasons.push('unit_price_unresolved');
 if(!tradeDate)reviewReasons.push('trade_date_unresolved');
 if(!price.currency)reviewReasons.push('currency_unresolved');
 // A broker's order request is evidence of intent, not proof that the trade executed.
 const orderRequest=/\b(?:compra|venda|venta) limitada\b|\bordem limitada\b|\bdata de solicitacao\b|\blimit order\b/.test(flat);
 const executionConfirmed=/\b(?:executad[ao]|ejecutad[ao]|executed|filled|preenchid[ao]|comprei|vendi|bought|sold)\b/.test(flat);
 if(orderRequest&&!executionConfirmed)reviewReasons.push('execution_unconfirmed');
 return {parser_version:VERSION,...(multiple?{candidates}:{}),status:!detected?'not_detected':reviewReasons.length?'needs_manual_review':'parsed_review',fields,review_reasons:reviewReasons};
}
