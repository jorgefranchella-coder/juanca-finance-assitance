import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pool} from '../../services/market/src/db.ts';
const db=pool();try{for(const id of ['005_market','006_market_run_identity']){
 const sql=await readFile(new URL('../postgres/'+id+'.sql',import.meta.url),'utf8'),sha256=createHash('sha256').update(sql).digest('hex');
 await db.query('BEGIN');try{await db.query("SELECT pg_advisory_xact_lock(736430)");const exists=await db.query("SELECT to_regclass('market.schema_migrations') AS name");let applied=false;if(exists.rows[0].name){const prior=await db.query('SELECT sha256 FROM market.schema_migrations WHERE id=$1',[id]);if(prior.rowCount){if(prior.rows[0].sha256!==sha256)throw new Error('MIGRATION_CHECKSUM');applied=true;}}
 if(!applied){await db.query(sql);await db.query('INSERT INTO market.schema_migrations(id,sha256) VALUES($1,$2)',[id,sha256]);}await db.query('COMMIT');console.log(JSON.stringify({migration:id,replayed:applied}));
 }catch(e){await db.query('ROLLBACK');throw e;}
}}finally{await db.end();}
