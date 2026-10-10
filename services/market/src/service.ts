import {createServer} from 'node:http';
import {createHash,randomUUID,timingSafeEqual} from 'node:crypto';
import type pg from 'pg';
import {pool} from './db.ts';
import {config} from './config.ts';
import type {Quote} from './providers.ts';

export type RefreshInput={b3_symbols:string[];us_symbols:string[];include_fx:boolean};
function normalizedSymbols(value:unknown,pattern:RegExp):string[]{
 if(!Array.isArray(value)||value.length>100)throw new Error('INVALID_SYMBOLS');
 const out=[...new Set(value.map(x=>String(x).trim().toUpperCase()))];if(out.some(x=>!pattern.test(x)))throw new Error('INVALID_SYMBOLS');return out.sort();
}
export function validateRefresh(value:unknown):RefreshInput{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('INVALID_BODY');const v=value as Record<string,unknown>;
 if(Object.keys(v).some(k=>!['b3_symbols','us_symbols','include_fx'].includes(k))||typeof v.include_fx!=='boolean')throw new Error('INVALID_BODY');
 const result={b3_symbols:normalizedSymbols(v.b3_symbols,/^[A-Z]{4}\d{1,2}[A-Z]?$/),us_symbols:normalizedSymbols(v.us_symbols,/^[A-Z.]{1,10}$/),include_fx:v.include_fx};if(!result.b3_symbols.length&&!result.us_symbols.length&&!result.include_fx)throw new Error('EMPTY_REFRESH');return result;
}
function digest(value:unknown){return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
export async function enqueue(db:pg.Pool,requestKey:string,input:RefreshInput){
 if(!/^[A-Za-z0-9._:-]{8,128}$/.test(requestKey))throw new Error('INVALID_IDEMPOTENCY_KEY');const requestHash=digest(input),id=randomUUID();
 const result=await db.query(`INSERT INTO market.refresh_jobs(id,request_key,request_hash,symbols,include_fx,status)
  VALUES($1,$2,$3,$4,$5,'queued') ON CONFLICT(request_key) DO NOTHING RETURNING id,status`,[id,requestKey,requestHash,{b3_symbols:input.b3_symbols,us_symbols:input.us_symbols},input.include_fx]);
 if(result.rowCount)return{id:result.rows[0].id,status:result.rows[0].status,replayed:false};
 const old=await db.query('SELECT id,status,request_hash FROM market.refresh_jobs WHERE request_key=$1',[requestKey]);if(old.rows[0]?.request_hash!==requestHash)throw new Error('IDEMPOTENCY_MISMATCH');
 return{id:old.rows[0].id,status:old.rows[0].status,replayed:true};
}
export async function refreshOnce(db:pg.Pool,workerId:string,providers:{b3:(x:string[])=>Promise<Quote[]>;us:(x:string)=>Promise<Quote>;fx:()=>Promise<{pair:'USD/BRL';rate:string;provider:string;observed_at:string}>}){
 const claim=await db.query(`WITH candidate AS(SELECT id FROM market.refresh_jobs WHERE (status='queued' AND available_at<=now()) OR (status='running' AND lease_until<now()) ORDER BY available_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1)
  UPDATE market.refresh_jobs j SET status='running',attempts=j.attempts+1,lease_until=now()+interval '5 minutes',lease_token=$1::uuid,updated_at=now() FROM candidate WHERE j.id=candidate.id RETURNING j.*`,[workerId]);
 if(!claim.rowCount)return false;const job=claim.rows[0],symbols=job.symbols as {b3_symbols:string[];us_symbols:string[]};const b3:Quote[]=[],us:Quote[]=[],fxRows:{pair:'USD/BRL';rate:string;provider:string;observed_at:string}[]=[];const failures:string[]=[],failedB3:string[]=[],failedUs:string[]=[];let failedFx=false;
 const tasks:Promise<void>[]=[];if(symbols.b3_symbols.length)tasks.push(providers.b3(symbols.b3_symbols).then(q=>{b3.push(...q);failedB3.push(...symbols.b3_symbols.filter(s=>!q.some(v=>v.symbol===s)));if(failedB3.length)failures.push('b3_quotes_missing');}).catch(()=>{failures.push('b3_unavailable');failedB3.push(...symbols.b3_symbols);}));
 for(let i=0;i<symbols.us_symbols.length;i+=8)tasks.push(Promise.all(symbols.us_symbols.slice(i,i+8).map(async symbol=>{try{us.push(await providers.us(symbol));}catch{failures.push('us_quote_unavailable');failedUs.push(symbol);}})).then(()=>{}));
 if(job.include_fx)tasks.push(providers.fx().then(q=>{fxRows.push(q);}).catch(()=>{failures.push('fx_unavailable');failedFx=true;}));
 await Promise.all(tasks);const quotes=[...b3,...us],status=failures.length?(quotes.length||fxRows.length?'partial':'failed'):'succeeded';
 const c=await db.connect();try{
  await c.query('BEGIN');const locked=await c.query("SELECT id FROM market.refresh_jobs WHERE id=$1 AND lease_token=$2::uuid AND status='running' FOR UPDATE",[job.id,job.lease_token]);if(!locked.rowCount){await c.query('ROLLBACK');return true;}
  const runId=randomUUID();await c.query('INSERT INTO market.provider_runs(id,provider,started_at,finished_at,status,requested_count,received_count,error_code) VALUES($1,$2,$3,now(),$4,$5,$6,$7)',[runId,'refresh_bundle',job.updated_at,status,symbols.b3_symbols.length+symbols.us_symbols.length+(job.include_fx?1:0),quotes.length+fxRows.length,failures.join(',')||null]);
  for(const q of quotes){await c.query(`INSERT INTO market.quote_observations(market_code,symbol,currency,price,provider,observed_at,provider_run_id) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(provider_run_id,market_code,symbol) DO NOTHING`,[q.market_code,q.symbol,q.currency,q.price,q.provider,q.observed_at,runId]);}
  for(const f of fxRows)await c.query(`INSERT INTO market.fx_observations(pair,rate,provider,observed_at,provider_run_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(provider_run_id,pair) DO NOTHING`,[f.pair,f.rate,f.provider,f.observed_at,runId]);
  const payload={provider_run_id:runId,status,attempt:Number(job.attempts),requested_symbols:symbols,quotes,fx:fxRows,failures};
  await c.query('INSERT INTO market.outbox(event_id,event_type,payload) VALUES($1,$2,$3)',[randomUUID(),'market.observations.published',payload]);
  const pending={b3_symbols:[...new Set(failedB3)].sort(),us_symbols:[...new Set(failedUs)].sort()};const retryFx=failedFx;
  const retry=failures.length>0&&Number(job.attempts)<5&&(pending.b3_symbols.length>0||pending.us_symbols.length>0||retryFx);const nextStatus=retry?'queued':status;const delay=Math.min(300,2**Math.min(Number(job.attempts),8));
  const previous=job.result&&typeof job.result==='object'?job.result as {quotes?:Quote[];fx?:{pair:'USD/BRL';rate:string;provider:string;observed_at:string}[]}:{};
  const quoteMap=new Map<string,Quote>();for(const q of [...(previous.quotes??[]),...quotes])quoteMap.set(`${q.market_code}:${q.symbol}`,q);
  const fxMap=new Map<string,{pair:'USD/BRL';rate:string;provider:string;observed_at:string}>();for(const f of [...(previous.fx??[]),...fxRows])fxMap.set(f.pair,f);
  const jobResult={...payload,quotes:[...quoteMap.values()].sort((a,b)=>`${a.market_code}:${a.symbol}`.localeCompare(`${b.market_code}:${b.symbol}`)),fx:[...fxMap.values()],pending_symbols:retry?pending:{b3_symbols:[],us_symbols:[]},pending_fx:retry&&retryFx};
  await c.query("UPDATE market.refresh_jobs SET symbols=CASE WHEN $9 THEN $10::jsonb ELSE symbols END,include_fx=CASE WHEN $9 THEN $11 ELSE include_fx END,status=$3,provider_run_id=$4,result=$5,last_error=$6,available_at=CASE WHEN $7 THEN now()+($8::text||' seconds')::interval ELSE available_at END,lease_until=NULL,lease_token=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2::uuid",[job.id,job.lease_token,nextStatus,runId,jobResult,failures.join(',')||null,retry,delay,retry,JSON.stringify(pending),retryFx]);await c.query('COMMIT');
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 return true;
}
export async function createMarketServer(){
 const cfg=await config(),db=pool();const server=createServer(async(req,res)=>{
  const requestId=randomUUID();res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Request-Id',requestId);const reply=(status:number,value:unknown)=>{res.statusCode=status;res.end(JSON.stringify(value));};
  try{
   const url=new URL(req.url??'/','http://localhost');
   if(url.pathname==='/health/ready'&&req.method==='GET'){await db.query('SELECT 1');reply(200,{status:'ready',service:'market'});return;}
   const provided=createHash('sha256').update(req.headers.authorization??'').digest(),expected=createHash('sha256').update('Bearer '+cfg.token).digest();if(!timingSafeEqual(provided,expected)){reply(401,{code:'UNAUTHENTICATED',request_id:requestId});return;}
   if(url.pathname==='/v1/refresh'&&req.method==='POST'){
    if(req.headers['transfer-encoding']||String(req.headers['content-type']??'').split(';')[0]!=='application/json'){reply(415,{code:'INVALID_CONTENT_TYPE',request_id:requestId});return;}
    const chunks:Buffer[]=[];let size=0;for await(const part of req){size+=part.length;if(size>16000){reply(413,{code:'BODY_TOO_LARGE',request_id:requestId});return;}chunks.push(part);}
    let raw:unknown;try{raw=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{reply(422,{code:'INVALID_JSON',request_id:requestId});return;}
    const input=validateRefresh(raw),key=String(req.headers['idempotency-key']??'');const job=await enqueue(db,key,input);reply(202,{...job,request_id:requestId});return;
   }
   const jobMatch=url.pathname.match(/^\/v1\/jobs\/([0-9a-f-]{36})$/);if(jobMatch&&req.method==='GET'){
    const result=await db.query('SELECT id,status,attempts,provider_run_id,result,last_error,created_at,updated_at FROM market.refresh_jobs WHERE id=$1',[jobMatch[1]]);if(!result.rowCount){reply(404,{code:'NOT_FOUND',request_id:requestId});return;}reply(200,result.rows[0]);return;
   }
   if(url.pathname==='/v1/events'&&req.method==='GET'){
    const after=url.searchParams.get('after')??'0';if(!/^\d{1,18}$/.test(after)){reply(422,{code:'INVALID_CURSOR',request_id:requestId});return;}
    const result=await db.query('SELECT id,event_id,event_type,payload,created_at FROM market.outbox WHERE id>$1::bigint ORDER BY id LIMIT 100',[after]);reply(200,{events:result.rows,request_id:requestId});return;
   }
   if(url.pathname==='/v1/quotes'&&req.method==='GET'){
    const market=url.searchParams.get('market'),symbols=(url.searchParams.get('symbols')??'').split(',').map(x=>x.toUpperCase()).filter(Boolean);if(!['B3','US'].includes(market??'')||symbols.length<1||symbols.length>100||symbols.some(s=>! /^[A-Z0-9.]{1,12}$/.test(s))){reply(422,{code:'VALIDATION',request_id:requestId});return;}
    const result=await db.query(`SELECT DISTINCT ON(symbol) market_code,symbol,currency,price::text AS price,provider,observed_at,received_at FROM market.quote_observations WHERE market_code=$1 AND symbol=ANY($2::text[]) ORDER BY symbol,observed_at DESC,received_at DESC`,[market,symbols]);reply(200,{quotes:result.rows,observed_at:new Date().toISOString()});return;
   }
   if(url.pathname==='/v1/fx/USD-BRL'&&req.method==='GET'){
    const result=await db.query(`SELECT pair,rate::text AS rate,provider,observed_at,received_at FROM market.fx_observations WHERE pair='USD/BRL' ORDER BY observed_at DESC,received_at DESC LIMIT 1`);reply(200,{observation:result.rows[0]??null});return;
   }
   reply(404,{code:'NOT_FOUND',request_id:requestId});
  }catch(error){const code=error instanceof Error?error.message:'DEPENDENCY_UNAVAILABLE',status=code==='IDEMPOTENCY_MISMATCH'?409:['INVALID_BODY','INVALID_SYMBOLS','INVALID_IDEMPOTENCY_KEY','EMPTY_REFRESH'].includes(code)?422:503;reply(status,{code,request_id:requestId,retryable:status===503});}
 });server.requestTimeout=15000;server.headersTimeout=10000;server.listen(cfg.port,'127.0.0.1',()=>console.log('Juanca market API ready on loopback.'));return{server,db,cfg};
}
