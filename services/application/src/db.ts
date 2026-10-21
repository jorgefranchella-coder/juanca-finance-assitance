import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
pg.types.setTypeParser(1082,value=>value);
export function pool(user='juanca_app',database=process.env.JUANCA_DATABASE??'juanca_shadow') {
 return new pg.Pool({host:process.env.JUANCA_PG_SOCKET??'/home/jorge/.local/share/juanca-shadow/socket',port:55432,user,database,max:5,connectionTimeoutMillis:3000,idleTimeoutMillis:10000,options:'-c timezone=UTC -c statement_timeout=15000'});
}
export async function migrate(db:pg.Pool) {
 for(const id of ['001_application','002_account_identity','003_conversation','004_account_resolution','005_account_alias_resolution','006_trade_attribution_resolution','007_custody_evidence','008_source_interpretations','009_manual_intake','010_ingestion_bridge','011_market_observations','012_manual_trade_interpretations','013_manual_b3_review_decisions','014_manual_photo_trade_interpretations','015_b3_position_account_resolutions','016_b3_snapshot_review_decisions','017_position_acquisition_lots','018_position_source_assertions','019_unknown_acquisition_fees','020_user_confirmed_position_identity']){
  const file=new URL('../../../infra/postgres/'+id+'.sql',import.meta.url);
  const sql=await readFile(file,'utf8');const hash=createHash('sha256').update(sql).digest('hex');
  const c=await db.connect();
  try {
   await c.query('BEGIN');await c.query("SELECT pg_advisory_xact_lock(736428)");
   const exists=await c.query("SELECT to_regclass('app.schema_migrations') AS name");
   let applied=false;
   if(exists.rows[0].name){const previous=await c.query('SELECT sha256 FROM app.schema_migrations WHERE id=$1',[id]);if(previous.rowCount){if(previous.rows[0].sha256!==hash)throw new Error('MIGRATION_CHECKSUM');applied=true;}}
   if(!applied){await c.query(sql);await c.query('INSERT INTO app.schema_migrations(id,sha256) VALUES($1,$2)',[id,hash]);}
   await c.query('COMMIT');
  } catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 }
}
