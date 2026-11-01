import {randomUUID} from 'node:crypto';
import type pg from 'pg';
import type {fetchBcbSelicDaily} from './bcb-selic.ts';

type SelicImport=Awaited<ReturnType<typeof fetchBcbSelicDaily>>;

/** Preserve a fetched response as a revision; retries of the same response and interval are idempotent. */
export async function storeSelicImport(db:pg.Pool,input:SelicImport){
 const c=await db.connect();try{
  await c.query('BEGIN');const id=randomUUID();
  const inserted=await c.query(`INSERT INTO market.index_imports(id,provider,indexer,source_uri,content_sha256,requested_from,requested_to)
   VALUES($1,$2,'SELIC',$3,$4,$5,$6) ON CONFLICT(provider,indexer,content_sha256,requested_from,requested_to) DO NOTHING RETURNING id`,
   [id,input.provider,input.source_uri,input.version,input.requested_from,input.requested_to]);
  if(!inserted.rowCount){const old=await c.query("SELECT id FROM market.index_imports WHERE provider=$1 AND indexer='SELIC' AND content_sha256=$2 AND requested_from=$3 AND requested_to=$4",[input.provider,input.version,input.requested_from,input.requested_to]);await c.query('COMMIT');return {import_id:old.rows[0].id,replayed:true,observations:input.observations.length};}
  for(const row of input.observations)await c.query('INSERT INTO market.index_observations(import_id,observed_on,rate_pct,unit) VALUES($1,$2,$3,$4)',[id,row.date,row.rate_pct,row.unit]);
  await c.query('COMMIT');return {import_id:id,replayed:false,observations:input.observations.length};
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}

/** Latest received revision for each date. Missing dates are left missing for the caller to assess against a calendar. */
export async function listSelicObservations(db:pg.Pool,from:string,to:string){
 const valid=(value:string)=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const d=new Date(value+'T00:00:00Z');return Number.isFinite(d.valueOf())&&d.toISOString().slice(0,10)===value;};
 if(!valid(from)||!valid(to)||from>to||Date.parse(to+'T00:00:00Z')-Date.parse(from+'T00:00:00Z')>3652*86400000)throw new Error('INVALID_SGS_INTERVAL');
 const rows=await db.query(`SELECT DISTINCT ON(o.observed_on) o.observed_on::text AS date,o.rate_pct::text AS rate_pct,o.unit,
  i.indexer,i.provider,i.source_uri,i.content_sha256 AS version,i.received_at
  FROM market.index_observations o JOIN market.index_imports i ON i.id=o.import_id
  WHERE i.indexer='SELIC' AND o.observed_on BETWEEN $1::date AND $2::date
  ORDER BY o.observed_on,i.received_at DESC,i.id DESC`,[from,to]);
 return {indexer:'SELIC' as const,from,to,observations:rows.rows,coverage:'not_assessed_without_calendar' as const};
}
