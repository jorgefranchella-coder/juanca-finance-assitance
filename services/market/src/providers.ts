import {inflateRawSync} from 'node:zlib';
export type Quote={market_code:'B3'|'US';symbol:string;currency:'BRL'|'USD';price:string;provider:string;observed_at:string};
export type Fx={pair:'USD/BRL';rate:string;provider:'BCB_PTAX';observed_at:string};
function decimal(value:unknown){const text=String(value??'').trim().replace(/[$,\s]/g,'');if(!/^(?:0|[1-9]\d*)(?:\.\d{1,10})?$/.test(text))return null;return text;}
function b3Price(raw:string){const cents=raw.trim();if(!/^\d{1,13}$/.test(cents))return null;const n=BigInt(cents);return `${n/100n}.${String(n%100n).padStart(2,'0')}`;}
export function parseCotahist(text:string,requested:Iterable<string>,date:string):Quote[]{
 const symbols=new Set(Array.from(requested,s=>s.trim().toUpperCase()));const selected=new Map<string,{quote:Quote;marketType:string}>();
 for(const line of text.split(/\r?\n/)){
  if(line.length<121||line.slice(0,2)!=='01')continue;
  const symbol=line.slice(12,24).trim().toUpperCase();if(!symbols.has(symbol))continue;
  const rowDate=line.slice(2,10),marketType=line.slice(24,27),price=b3Price(line.slice(108,121));if(rowDate!==date||!price)continue;
  const current=selected.get(symbol);if(!current||(current.marketType!=='010'&&marketType==='010'))selected.set(symbol,{marketType,quote:{market_code:'B3',symbol,currency:'BRL',price,provider:'b3_cotahist',observed_at:`${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}T18:00:00-03:00`}});
 }
 return [...selected.values()].map(x=>x.quote);
}
export function zipText(zip:Uint8Array){
 const view=new DataView(zip.buffer,zip.byteOffset,zip.byteLength);const decoder=new TextDecoder('windows-1252');let total=0;const entries:string[]=[];
 let eocd=-1;for(let p=Math.max(0,zip.length-65557);p+22<=zip.length;p++)if(view.getUint32(p,true)===0x06054b50)eocd=p;
 if(eocd<0)throw new Error('ZIP_DIRECTORY_MISSING');const count=view.getUint16(eocd+10,true),directorySize=view.getUint32(eocd+12,true);let p=view.getUint32(eocd+16,true);if(p+directorySize>zip.length)throw new Error('ZIP_DIRECTORY_INVALID');
 for(let index=0;index<count&&p+46<=zip.length;index++){
  if(view.getUint32(p,true)!==0x02014b50)throw new Error('ZIP_DIRECTORY_INVALID');
  const flags=view.getUint16(p+8,true),method=view.getUint16(p+10,true),compressed=view.getUint32(p+20,true),uncompressed=view.getUint32(p+24,true),nameLength=view.getUint16(p+28,true),extraLength=view.getUint16(p+30,true),commentLength=view.getUint16(p+32,true),offset=view.getUint32(p+42,true);
  const name=decoder.decode(zip.subarray(p+46,p+46+nameLength));p+=46+nameLength+extraLength+commentLength;
  if(!name.toUpperCase().endsWith('.TXT'))continue;
  if(compressed>64_000_000||uncompressed>100_000_000)throw new Error('ZIP_SIZE_LIMIT');
  const localName=view.getUint16(offset+26,true),localExtra=view.getUint16(offset+28,true),start=offset+30+localName+localExtra;let bytes:Buffer;
  if(start+compressed>zip.length)throw new Error('ZIP_ENTRY_INVALID');
  if(flags&1)throw new Error('ZIP_ENCRYPTED');
  if(method===8)bytes=inflateRawSync(zip.subarray(start,start+compressed),{maxOutputLength:100_000_000});else if(method===0)bytes=Buffer.from(zip.subarray(start,start+compressed));else throw new Error('ZIP_METHOD_UNSUPPORTED');
  if(bytes.length!==uncompressed)throw new Error('ZIP_ENTRY_INVALID');
  total+=bytes.length;if(total>100_000_000)throw new Error('ZIP_SIZE_LIMIT');entries.push(bytes.toString('latin1'));
 }
 if(!entries.length)throw new Error('COTAHIST_TXT_MISSING');return entries.join('\n');
}
function businessDates(now=new Date(),count=7){const fmt=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'});const [y,m,d]=fmt.format(now).split('-').map(Number);const out:string[]=[];for(let off=0;out.length<count&&off<14;off++){const c=new Date(Date.UTC(y,m-1,d-off,12));if(c.getUTCDay()===0||c.getUTCDay()===6)continue;out.push(`${String(c.getUTCDate()).padStart(2,'0')}${String(c.getUTCMonth()+1).padStart(2,'0')}${c.getUTCFullYear()}`);}return out;}
export function archiveDateToTradingDate(value:string){if(!/^\d{8}$/.test(value))throw new Error('INVALID_ARCHIVE_DATE');return value.slice(4,8)+value.slice(2,4)+value.slice(0,2);}
export async function b3Quotes(symbols:string[],now=new Date()):Promise<Quote[]>{
 if(!symbols.length)return[];
 for(const date of businessDates(now)){
  const r=await fetch(`https://bvmf.bmfbovespa.com.br/InstDados/SerHist/COTAHIST_D${date}.ZIP`,{signal:AbortSignal.timeout(15000)});if(r.status===404)continue;if(!r.ok)throw new Error(`B3_HTTP_${r.status}`);
  const text=zipText(new Uint8Array(await r.arrayBuffer()));const quotes=parseCotahist(text,symbols,archiveDateToTradingDate(date));if(quotes.length)return quotes;
 }
 throw new Error('B3_UNAVAILABLE');
}
export async function ptax():Promise<Fx>{
 const now=new Date(),start=new Date(now.getTime()-14*86400000),fmt=(d:Date)=>`${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}-${d.getUTCFullYear()}`;
 const base='https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoDolarPeriodo(dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)';
 const url=`${base}?@dataInicial='${fmt(start)}'&@dataFinalCotacao='${fmt(now)}'&%24top=100&%24orderby=dataHoraCotacao%20desc&%24format=json`;
 const response=await fetch(url,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(12000)});if(!response.ok)throw new Error(`BCB_HTTP_${response.status}`);
 const data=await response.json() as {value?:{cotacaoVenda?:unknown;dataHoraCotacao?:string}[]};const row=data.value?.find(v=>decimal(v.cotacaoVenda));const rate=decimal(row?.cotacaoVenda);if(!row||!rate)throw new Error('BCB_NO_RATE');
 return{pair:'USD/BRL',rate,provider:'BCB_PTAX',observed_at:String(row.dataHoraCotacao??'').slice(0,10)};
}
export async function nasdaqQuote(symbol:string):Promise<Quote>{
 const safe=encodeURIComponent(symbol.replaceAll('.','-'));
 for(const assetclass of ['stocks','etf']){
  const r=await fetch(`https://api.nasdaq.com/api/quote/${safe}/info?assetclass=${assetclass}`,{signal:AbortSignal.timeout(8000),headers:{Accept:'application/json','User-Agent':'Mozilla/5.0 (compatible; JuancaMarket/1.0)'}});if(!r.ok)continue;
  const body=await r.json() as {data?:{primaryData?:{lastSalePrice?:unknown;lastTradeTimestamp?:string}}};const value=decimal(body.data?.primaryData?.lastSalePrice);if(!value)continue;
  const parsed=Date.parse(String(body.data?.primaryData?.lastTradeTimestamp??''));return{market_code:'US',symbol,currency:'USD',price:value,provider:'nasdaq_public',observed_at:Number.isFinite(parsed)?new Date(parsed).toISOString():new Date().toISOString()};
 }
 throw new Error('NASDAQ_QUOTE_UNAVAILABLE');
}
export async function usQuotes(symbols:string[],concurrency=8):Promise<{quotes:Quote[];failed:string[]}>{
 const quotes:Quote[]=[],failed:string[]=[];for(let i=0;i<symbols.length;i+=concurrency){const batch=await Promise.all(symbols.slice(i,i+concurrency).map(async symbol=>{try{return await nasdaqQuote(symbol);}catch{return null;}}));batch.forEach((quote,index)=>quote?quotes.push(quote):failed.push(symbols[i+index]));}return{quotes,failed};
}
