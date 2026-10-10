const VERSION='manual-trade-v1';
function number(value:string):string|null {
 const raw=value.trim().replace(/\s/g,'');
 if(!/^[0-9.,]+$/.test(raw))return null;
 if(!raw.includes(',')&&/^\d{1,3}\.\d{3}$/.test(raw))return null;
 const normalized=raw.includes(',')?raw.replace(/\./g,'').replace(',','.'):raw;
 if((normalized.match(/\./g)?.length??0)>1||!/^\d+(\.\d+)?$/.test(normalized))return null;
 return normalized;
}
function isoDate(value:string):string|null {
 if(/^\d{4}-\d{2}-\d{2}$/.test(value))return value;
 const match=value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
 if(!match)return null;
 const result=`${match[3]}-${match[2]}-${match[1]}`;
 const parsed=new Date(`${result}T00:00:00Z`);
 return !Number.isNaN(parsed.valueOf())&&parsed.toISOString().slice(0,10)===result?result:null;
}
export function interpretManualTrade(text:string,occurredOn:string|null) {
 const normalized=text.normalize('NFC');
 const sideMatch=normalized.match(/\b(comprei|compramos|compra|comprar|buy|bought|vendi|vendemos|venda|vender|sell|sold)\b/i);
 const side=sideMatch?(/^(comprei|compramos|compra|comprar|buy|bought)$/i.test(sideMatch[1])?'buy':'sell'):null;
 const tickerMatch=normalized.match(/\b([A-Z]{3,6}\d{0,2}|[A-Z]{1,6}\d{1,5})\b/);
 const quantityMatch=sideMatch&&tickerMatch?normalized.slice(sideMatch.index!+sideMatch[0].length,tickerMatch.index).match(/(?:^|\s)(\d[\d.,]*)\s*$/):null;
 const priceMatch=normalized.match(/(?:R\$|BRL\s*\$?|US\$|USD\s*\$?)\s*([\d.]+(?:,\d+)?|\d+,\d+)/i);
 const dateMatch=normalized.match(/\b(\d{2}\/\d{2}\/\d{4}|\d{4}-\d{2}-\d{2})\b/);
 const quantity=quantityMatch?number(quantityMatch[1]):null;
 const unitPrice=priceMatch?number(priceMatch[1]):null;
 const tradeDate=dateMatch?isoDate(dateMatch[1]):occurredOn;
 const currency=priceMatch?/^(R\$|BRL)/i.test(priceMatch[0].trim())?'BRL':'USD':null;
 const fields={side,instrument_code:tickerMatch?.[1]??null,quantity,unit_price:unitPrice,currency,trade_date:tradeDate};
 const detected=!!sideMatch||!!tickerMatch||!!priceMatch;
 const reviewReasons:string[]=[];
 if(!side)reviewReasons.push('side_unresolved');
 if(!fields.instrument_code)reviewReasons.push('instrument_unresolved');
 if(!quantity)reviewReasons.push('quantity_unresolved');
 if(!unitPrice)reviewReasons.push('unit_price_unresolved');
 if(!tradeDate)reviewReasons.push('trade_date_unresolved');
 if(!currency)reviewReasons.push('currency_unresolved');
 return {parser_version:VERSION,status:!detected?'not_detected':reviewReasons.length?'needs_manual_review':'parsed_review',fields,review_reasons:reviewReasons};
}
