import {randomUUID} from 'node:crypto';
import type pg from 'pg';
import {accountId,summaryHash} from './migration.ts';
import {exact,integer,minor} from './money.ts';

/** Prepare reviewed drafts from specific immutable Avenue trade evidence. */
export async function prepareAvenueTradeProposals(db:pg.Pool,household:string,documentId:string){
 const c=await db.connect();
 try{
  await c.query('BEGIN');
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[household+':avenue-trade-review']);
  const found=await c.query(`SELECT a.id,a.owner_id,a.custody_account_id,a.instrument_code,a.asserted_on::text,a.quantity::text,a.raw_row,o.display_name,d.content_sha256
   FROM app.source_assertions a JOIN app.source_documents d ON d.household_id=a.household_id AND d.id=a.document_id
   JOIN app.owners o ON o.household_id=a.household_id AND o.id=a.owner_id
   WHERE a.household_id=$1 AND d.id=$2 AND d.source_system='Avenue' AND d.report_kind='movement' AND a.assertion_kind='movement' ORDER BY a.source_row`,[household,documentId]);
  if(!found.rowCount)throw new Error('AVENUE_TRADE_DOCUMENT_NOT_FOUND');
  let created=0,existing=0;const blocked:string[]=[];
  const markBlocked=async(row:Record<string,any>,reason:string)=>{
   blocked.push(row.id);
   const sourceKey='avenue-trade-review:'+row.id;
   await c.query(`INSERT INTO app.confirmation_items(household_id,id,source_key,owner,category,title,context,evidence,actions,status,created_at,updated_at)
    VALUES($1,$2,$3,$4,'Avenue',$5,$6::jsonb,$7::jsonb,$8::jsonb,'open',now(),now()) ON CONFLICT(household_id,source_key) DO NOTHING`,[household,randomUUID(),sourceKey,['Jorge','Julia'].includes(row.display_name)?row.display_name:'Sin identificar',`Revisar operación Avenue · ${row.instrument_code}`,JSON.stringify({motivo:reason,fecha:row.asserted_on,cantidad:row.quantity,documento:documentId}),JSON.stringify([`Registro ${row.id}`]),JSON.stringify([{key:'investigar',label:'Necesito revisar este movimiento',keeps_open:true},{key:'no_registrar',label:'No registrar este movimiento'}])]);
  };
  for(const row of found.rows){
   const prior=await c.query('SELECT proposal_id FROM app.avenue_trade_proposal_links WHERE household_id=$1 AND assertion_id=$2',[household,row.id]);if(prior.rowCount){existing++;continue;}
   const raw=row.raw_row,account=accountId(JSON.stringify([row.display_name,`custody:${row.custody_account_id}`]));
   const accountRow=await c.query("SELECT 1 FROM app.accounts WHERE household_id=$1 AND id=$2 AND owner_id=$3 AND identity_status='known'",[household,account,row.owner_id]);
   const price=exact(String(raw.unit_price??'0')),quantity=exact(String(row.quantity)),fees=integer(String(raw.fees_minor??'0'));
   if(!accountRow.rowCount||!['buy','sell'].includes(raw.side)||raw.currency!=='USD'||!row.custody_account_id||!/^\d{4}-\d\d-\d\d$/.test(String(row.asserted_on))||price.lte(0)||quantity.lte(0)||raw.instrument_code!==row.instrument_code||raw.trade_date!==row.asserted_on||!/^\d{4}-\d\d-\d\d$/.test(String(raw.settlement_date??''))||String(minor(price.mul(quantity).mul(100)))!==String(raw.principal_minor)){await markBlocked(row,'La cuenta o los datos del comprobante requieren revisión');continue;}
   // An identical economic record elsewhere requires explicit reconciliation.
   const duplicates=await c.query(`SELECT 1 FROM app.source_assertions x JOIN app.source_documents d ON d.household_id=x.household_id AND d.id=x.document_id WHERE x.household_id=$1 AND x.id<>$2 AND x.owner_id=$3 AND x.custody_account_id=$4 AND x.instrument_code=$5 AND x.asserted_on=$6 AND x.quantity=$7 AND x.raw_row->>'side'=$8 AND x.raw_row->>'unit_price'=$9 AND d.source_system='Avenue' LIMIT 1`,[household,row.id,row.owner_id,row.custody_account_id,row.instrument_code,row.asserted_on,row.quantity,raw.side,String(raw.unit_price)]);
   const event=await c.query('SELECT 1 FROM app.events WHERE household_id=$1 AND account_id=$2 AND instrument_code=$3 AND effective_date=$4 AND side=$5 AND quantity=$6 AND unit_price=$7 AND currency=$8 AND application_status=\'applied\' LIMIT 1',[household,account,row.instrument_code,row.asserted_on,raw.side,row.quantity,price.toFixed(),raw.currency]);
   if(duplicates.rowCount||event.rowCount){await markBlocked(row,'Existe una operación similar que podría estar duplicada');continue;}
   const p={owner_id:row.owner_id,account_id:account,instrument_code:row.instrument_code,currency:raw.currency,side:raw.side,quantity:quantity.toFixed(),unit_price:price.toFixed(),fees_minor:fees,effective_date:row.asserted_on};
   const id=randomUUID();await c.query(`INSERT INTO app.proposals(household_id,id,owner_id,account_id,instrument_code,currency,side,quantity,unit_price,fees_minor,effective_date,summary_hash,status,source_message_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending',$13)`,[household,id,p.owner_id,p.account_id,p.instrument_code,p.currency,p.side,p.quantity,p.unit_price,p.fees_minor,p.effective_date,summaryHash(p),'avenue-assertion:'+row.id]);
   await c.query('INSERT INTO app.avenue_trade_proposal_links(household_id,assertion_id,proposal_id) VALUES($1,$2,$3)',[household,row.id,id]);created++;
  }
  await c.query('COMMIT');return{created,existing,blocked};
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
