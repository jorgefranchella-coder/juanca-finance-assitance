import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import type pg from 'pg';
import {exact} from './money.ts';

type Quote={market_code:'B3'|'US';symbol:string;currency:'BRL'|'USD';price:string;provider:string;observed_at:string};
type Fx={pair:'USD/BRL';rate:string;provider:string;observed_at:string};
type MarketEvent={id:string;event_id:string;event_type:string;payload:{quotes?:Quote[];fx?:Fx[];status?:string}};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let config:Promise<{token:string;port:number}>|undefined;
async function marketConfig(){return config??=readFile(process.env.JUANCA_MARKET_CONFIG??'/home/jorge/.local/share/juanca-shadow/market.json','utf8').then(raw=>{const c=JSON.parse(raw) as {token:string;port:number};if(!c.token||c.token.length<32||!Number.isInteger(c.port))throw new Error('INVALID_MARKET_CONFIG');return c;});}
export async function marketEvents(after:string):Promise<MarketEvent[]>{if(!/^\d+$/.test(after))throw new Error('INVALID_MARKET_CURSOR');const cfg=await marketConfig(),response=await fetch(`http://127.0.0.1:${cfg.port}/v1/events?after=${after}`,{headers:{Authorization:'Bearer '+cfg.token},signal:AbortSignal.timeout(15000)});if(!response.ok)throw new Error('MARKET_FEED_UNAVAILABLE');const body=await response.json() as {events?:MarketEvent[]};if(!Array.isArray(body.events))throw new Error('MARKET_FEED_INVALID');return body.events;}
function timestamp(value:unknown){if(typeof value!=='string'||!Number.isFinite(Date.parse(value)))throw new Error('MARKET_TIMESTAMP_INVALID');return new Date(value).toISOString();}
function date(value:unknown){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new Error('MARKET_DATE_INVALID');return value;}
export async function receiveMarketEvent(db:pg.Pool,event:MarketEvent){
 if(!/^\d+$/.test(event.id)||!UUID.test(event.event_id)||event.event_type!=='market.observations.published'||!event.payload||!Array.isArray(event.payload.quotes)||!Array.isArray(event.payload.fx))throw new Error('MARKET_EVENT_INVALID');
 const id=BigInt(event.id),payloadHash=createHash('sha256').update(JSON.stringify(event.payload)).digest('hex'),c=await db.connect();try{await c.query('BEGIN');
  const state=await c.query("SELECT last_outbox_id FROM app.market_feed_state WHERE feed='market' FOR UPDATE");if(!state.rowCount)throw new Error('MARKET_FEED_STATE_MISSING');if(id<=BigInt(state.rows[0].last_outbox_id)){await c.query('COMMIT');return{replayed:true,quotes:0,fx:0};}
  await c.query('INSERT INTO app.market_inbox(event_id,outbox_id,event_type,payload_sha256) VALUES($1,$2,$3,$4)',[event.event_id,event.id,event.event_type,payloadHash]);
  for(const quote of event.payload.quotes){if(!['B3','US'].includes(quote.market_code)||!['BRL','USD'].includes(quote.currency)||typeof quote.symbol!=='string'||!/^[A-Z0-9.]{1,20}$/.test(quote.symbol)||typeof quote.provider!=='string'||!quote.provider)throw new Error('MARKET_QUOTE_INVALID');const price=exact(quote.price);if(!price.gt(0))throw new Error('MARKET_QUOTE_INVALID');await c.query('INSERT INTO app.market_quote_observations(event_id,market_code,symbol,provider,observed_at,currency,price) VALUES($1,$2,$3,$4,$5,$6,$7)',[event.event_id,quote.market_code,quote.symbol,quote.provider,timestamp(quote.observed_at),quote.currency,price.toFixed()]);}
  for(const fx of event.payload.fx){if(fx.pair!=='USD/BRL'||typeof fx.provider!=='string'||!fx.provider)throw new Error('MARKET_FX_INVALID');const rate=exact(fx.rate);if(!rate.gt(0))throw new Error('MARKET_FX_INVALID');await c.query('INSERT INTO app.market_fx_observations(event_id,pair,provider,observed_on,rate) VALUES($1,$2,$3,$4,$5)',[event.event_id,fx.pair,fx.provider,date(fx.observed_at),rate.toFixed()]);}
  await c.query("UPDATE app.market_feed_state SET last_outbox_id=$1,updated_at=now() WHERE feed='market'",[event.id]);await c.query('COMMIT');return{replayed:false,quotes:event.payload.quotes.length,fx:event.payload.fx.length};
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
