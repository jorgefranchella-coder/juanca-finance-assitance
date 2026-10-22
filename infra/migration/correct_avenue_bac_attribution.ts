import {randomUUID} from 'node:crypto';
import {pool,migrate} from '../../services/application/src/db.ts';

const db=pool();
try{
 await migrate(db);
 const c=await db.connect();
 try{
  await c.query('BEGIN');
  const source=await c.query(`SELECT a.household_id,a.id,a.owner_id AS source_owner_id,a.instrument_code,a.asserted_on,a.direction,
      j.id AS jorge_id,j.display_name AS jorge_name,ju.display_name AS source_owner_name,ca.id AS custody_account_id
    FROM app.source_assertions a
    JOIN app.owners ju ON ju.household_id=a.household_id AND ju.id=a.owner_id
    JOIN app.owners j ON j.household_id=a.household_id AND j.display_name='Jorge'
    JOIN app.custody_accounts ca ON ca.household_id=a.household_id AND ca.owner_id=j.id AND ca.institution_id='avenue-securities'
    JOIN app.source_documents d ON d.household_id=a.household_id AND d.id=a.document_id
    WHERE a.id='assertion-44d1f69c63077843e85f21d16fddc061'
      AND a.instrument_code='BAC' AND a.asserted_on='2026-08-28' AND a.direction='buy'
      AND ju.display_name='Julia' AND d.original_name='Doc_101579_CONFIRMATIONaccount=6AJ74139_6AJ74139_8292026_83714_AM_z8TMUAOa.pdf'
    FOR UPDATE OF a`);
  if(source.rowCount!==1||source.rows[0].custody_account_id!=='custody-3846030209e8f7a566d1989ea51d5d84')throw new Error('SOURCE_OR_TARGET_NOT_UNAMBIGUOUS');
  const row=source.rows[0],household=String(row.household_id),assertion=String(row.id),targetOwner=String(row.jorge_id),custody=String(row.custody_account_id),actor=`legacy-shared:${household}`;
  const current=await c.query(`SELECT id,revision,attributed_owner_id,custody_account_id FROM app.source_attribution_decisions
    WHERE household_id=$1 AND assertion_id=$2 ORDER BY revision DESC LIMIT 1 FOR UPDATE`,[household,assertion]);
  if(current.rowCount&&current.rows[0].attributed_owner_id===targetOwner&&current.rows[0].custody_account_id===custody){
   await c.query('COMMIT');console.log(JSON.stringify({replayed:true,assertion_id:assertion,source_owner:row.source_owner_name,attributed_owner:row.jorge_name,custody_account_id:custody,portfolio_published:false}));
  }else{
   const id=`attribution-${randomUUID().replaceAll('-','')}`,revision=Number(current.rows[0]?.revision??0)+1,supersedes=current.rows[0]?.id??null;
   const inserted=await c.query(`INSERT INTO app.source_attribution_decisions(household_id,id,assertion_id,revision,source_owner_id,attributed_owner_id,custody_account_id,decision,reason,evidence,actor_id,request_key,supersedes_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,'user_confirmed_attribution','user_confirmed_avenue_purchase_belongs_to_jorge',$8,$9,'correct-avenue-bac-attribution-2026-08-28',$10) RETURNING id`,
    [household,id,assertion,revision,row.source_owner_id,targetOwner,custody,{user_confirmation:'BAC purchase belongs to Jorge',account_alias:'6AJ-74139',source_document:'Doc_101579_CONFIRMATIONaccount=6AJ74139_6AJ74139_8292026_83714_AM_z8TMUAOa.pdf'},actor,supersedes]);
   await c.query(`INSERT INTO app.audit_log(household_id,actor_id,action,resource_id,details)
    VALUES($1,$2,'source_attribution_corrected',$3,$4)`,[household,actor,assertion,{decision_id:inserted.rows[0].id,source_owner:row.source_owner_name,attributed_owner:row.jorge_name,custody_account_id:custody,reason:'user_confirmed_avenue_purchase_belongs_to_jorge',raw_evidence_preserved:true,financial_facts_changed:false,portfolio_published:false}]);
   await c.query('UPDATE app.household_state SET facts_revision=facts_revision+1 WHERE household_id=$1',[household]);
   await c.query('COMMIT');console.log(JSON.stringify({replayed:false,decision_id:inserted.rows[0].id,assertion_id:assertion,source_owner:row.source_owner_name,attributed_owner:row.jorge_name,custody_account_id:custody,portfolio_published:false}));
  }
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}finally{await db.end();}
