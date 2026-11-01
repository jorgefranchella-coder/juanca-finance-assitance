import {createHash} from 'node:crypto';

const DATASET='https://dadosabertos.bcb.gov.br/dataset/11-taxa-de-juros---selic';
const validDate=(s:string)=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(s))return false;const d=new Date(s+'T00:00:00Z');return Number.isFinite(d.valueOf())&&d.toISOString().slice(0,10)===s;};
const brazilianDate=(s:string)=>`${s.slice(8,10)}/${s.slice(5,7)}/${s.slice(0,4)}`;

/** BCB SGS series 11 is the realized Selic overnight rate in percent per day, not the target Selic rate. */
export async function fetchBcbSelicDaily(from:string,to:string,fetcher:typeof fetch=fetch){
 if(!validDate(from)||!validDate(to)||from>to||Date.parse(to+'T00:00:00Z')-Date.parse(from+'T00:00:00Z')>3652*86400000)throw new Error('INVALID_SGS_INTERVAL');
 const query=new URLSearchParams({formato:'json',dataInicial:brazilianDate(from),dataFinal:brazilianDate(to)});
 const url=`https://api.bcb.gov.br/dados/serie/bcdata.sgs.11/dados?${query}`;
 const response=await fetcher(url,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(12000)});
 if(!response.ok)throw new Error(`BCB_SGS_HTTP_${response.status}`);
 const raw=await response.text();if(raw.length>2_000_000)throw new Error('BCB_SGS_TOO_LARGE');
 let parsed:unknown;try{parsed=JSON.parse(raw);}catch{throw new Error('BCB_SGS_INVALID_PAYLOAD');}
 if(!Array.isArray(parsed)||parsed.length>4000)throw new Error('BCB_SGS_INVALID_PAYLOAD');
 const version=createHash('sha256').update(raw).digest('hex'),seen=new Set<string>();
 const observations=parsed.map((item:unknown)=>{
  if(!item||typeof item!=='object'||Array.isArray(item))throw new Error('BCB_SGS_INVALID_PAYLOAD');
  const row=item as Record<string,unknown>,match=/^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(row.data??'')),rate=String(row.valor??'').trim().replace(',','.');
  const date=match?`${match[3]}-${match[2]}-${match[1]}`:'';
  if(!validDate(date)||date<from||date>to||seen.has(date)||!/^\d{1,3}(?:\.\d{1,10})?$/.test(rate)||Number(rate)>=100)throw new Error('BCB_SGS_INVALID_PAYLOAD');
  seen.add(date);return {date,rate_pct:rate,unit:'daily_percent' as const,indexer:'SELIC' as const,source_uri:DATASET,version};
 }).sort((a,b)=>a.date.localeCompare(b.date));
 return {provider:'BCB_SGS_11' as const,source_uri:DATASET,requested_from:from,requested_to:to,version,observations};
}
