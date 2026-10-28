const VERSION='manual-trade-v2';
type Side='buy'|'sell';
type Span={value:string;index:number;length:number};

function fold(value:string){return value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();}
function number(value:string):string|null {
 const raw=value.trim().replace(/\s/g,'');
 if(!/^[0-9.,]+$/.test(raw))return null;
 if(!raw.includes(',')&&/^\d{1,3}\.\d{3}$/.test(raw))return null;
 const normalized=raw.includes(',')?raw.replace(/\./g,'').replace(',','.'):raw;
 if((normalized.match(/\./g)?.length??0)>1||!/^[0-9]+(\.[0-9]+)?$/.test(normalized))return null;
 return normalized;
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
function detectQuantity(flat:string,instrument:string|null):string|null {
 const n='(\\d+(?:[.,]\\d+)?)';
 const patterns=[
  new RegExp(`\\b(?:qty|quantity|cantidad|quantidade)\\b\\s*(?:de|of|is|=|:)?\\s*${n}`,'i'),
  new RegExp(`${n}\\s*(?:de|of)?\\s*(?:acciones?|acoes?|shares?|units?|unidades?|quotas?|cotas?|titulos?)\\b`,'i'),
 ];
 for(const pattern of patterns){const match=pattern.exec(flat);if(match){const parsed=number(match[1]);if(parsed)return parsed;}}
 if(instrument){
  const index=flat.indexOf(instrument.toLowerCase());
  if(index>=0){
   const before=flat.slice(Math.max(0,index-80),index),after=flat.slice(index+instrument.length,index+instrument.length+80);
   const prior=new RegExp(`${n}\\s*(?:(?:de|of)\\s+)?$`,'i').exec(before);
   if(prior){const parsed=number(prior[1]);if(parsed)return parsed;}
   const later=new RegExp(`^\\s*(?:(?:x|:|-)\\s*)?${n}\\b`,'i').exec(after);
   if(later){const parsed=number(later[1]);if(parsed)return parsed;}
  }
 }
 return null;
}
function detectPrice(original:string,flat:string):{value:string|null;currency:string|null} {
 const matches:Span[]=[];const regex=/(?:R\$|BRL\s*\$?|US\$|USD\s*\$?|EUR\s*€?|€|\$)\s*([\d.,]+)/gi;
 for(const match of original.matchAll(regex)){
  const amount=number(match[1]);if(amount)matches.push({value:amount,index:match.index??0,length:match[0].length});
 }
 if(!matches.length)return{value:null,currency:null};
 const labeled=matches.find(item=>/\b(?:unit(?:ario|aria)?|preco|precio|price|at|por|cada|per)\s*[:=]?\s*$/i.test(fold(original.slice(Math.max(0,item.index-36),item.index))));
 const selected=labeled??matches[0],raw=original.slice(selected.index,selected.index+selected.length).trim().toUpperCase();
 const currency=/^(?:US\$|USD)/.test(raw)?'USD':/^(?:€|EUR)/.test(raw)?'EUR':raw.startsWith('$')?'USD':'BRL';
 return{value:selected.value,currency};
}
export function interpretManualTrade(text:string,occurredOn:string|null) {
 const original=text.normalize('NFC'),flat=fold(original),sideResult=detectSide(flat);
 const instrument=detectInstrument(original,flat),quantity=detectQuantity(flat,instrument),price=detectPrice(original,flat);
 const dateMatch=flat.match(/\b(\d{1,2}[/.\-]\d{1,2}[/.\-]\d{4}|\d{4}-\d{2}-\d{2})\b/);
 const tradeDate=dateMatch?isoDate(dateMatch[1]):occurredOn;
 const fields={side:sideResult.side,instrument_code:instrument,quantity,unit_price:price.value,currency:price.currency,trade_date:tradeDate,fees_minor:'0',fees_assumed_zero:true};
 const detected=sideResult.matches.length>0||!!instrument||!!price.value;
 const reviewReasons:string[]=[];
 if(!sideResult.side)reviewReasons.push(sideResult.conflict?'side_conflict':'side_unresolved');
 if(!instrument)reviewReasons.push('instrument_unresolved');
 if(!quantity)reviewReasons.push('quantity_unresolved');
 if(!price.value)reviewReasons.push('unit_price_unresolved');
 if(!tradeDate)reviewReasons.push('trade_date_unresolved');
 if(!price.currency)reviewReasons.push('currency_unresolved');
 return {parser_version:VERSION,status:!detected?'not_detected':reviewReasons.length?'needs_manual_review':'parsed_review',fields,review_reasons:reviewReasons};
}
