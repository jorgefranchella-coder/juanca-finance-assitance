import {createHash} from 'node:crypto';
import {pool,migrate} from '../../services/application/src/db.ts';

const household=JSON.parse(await (await import('node:fs/promises')).readFile(process.env.JUANCA_SHADOW_CONFIG??'/home/jorge/.local/share/juanca-shadow/application.json','utf8')).household_id as string;
if(!household)throw new Error('HOUSEHOLD_REQUIRED');
const db=pool();
try{
 await migrate(db);
 const c=await db.connect();
 try{
  await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(736432)');
  const rows=await c.query(`WITH latest AS (
    SELECT DISTINCT ON (owner_id) household_id,owner_id,id,effective_as_of
    FROM app.source_documents WHERE household_id=$1 AND source_system='B3' AND report_kind='position'
      AND effective_as_of IS NOT NULL AND status<>'superseded'
    ORDER BY owner_id,effective_as_of DESC,registered_at DESC,id DESC
  )
  SELECT a.id AS assertion_id,a.owner_id,a.institution_id,a.custody_account_id,a.instrument_code,a.interpretation_status,
    d.effective_as_of,d.id AS document_id
  FROM latest d JOIN app.source_assertions a ON a.household_id=d.household_id AND a.document_id=d.id
  WHERE a.assertion_kind='position' ORDER BY a.owner_id,a.institution_id,a.instrument_code,a.id`,[household]);
  if(!rows.rowCount)throw new Error('LATEST_B3_POSITIONS_NOT_FOUND');
  const actor='migration:018-position-identity-seed';
  await c.query("INSERT INTO app.actors(id,attribution) VALUES($1,'System migration seeded identities from latest B3 position evidence') ON CONFLICT(id) DO NOTHING",[actor]);
  await c.query("INSERT INTO app.memberships(household_id,actor_id,role) VALUES($1,$2,'migration') ON CONFLICT(household_id,actor_id) DO NOTHING",[household,actor]);
  let inserted=0,resolved=0,provisional=0;
  for(const row of rows.rows){
   if(!row.owner_id||!row.institution_id||!row.instrument_code||!row.assertion_id)throw new Error('INCOMPLETE_POSITION_ASSERTION');
   // B3 position values are reported in BRL; the source rows do not include a currency field.
   const status=row.custody_account_id&&row.interpretation_status==='observed'?'resolved':'provisional';
   const identityKey=status==='resolved'
    ?[household,row.owner_id,row.institution_id,row.custody_account_id,row.instrument_code,'BRL']
    :[household,row.owner_id,row.institution_id,'source-assertion',row.assertion_id,row.instrument_code,'BRL'];
   const digest=createHash('sha256').update(JSON.stringify(identityKey)).digest('hex').slice(0,32);
   const id=digest.slice(0,8)+'-'+digest.slice(8,12)+'-'+digest.slice(12,16)+'-'+digest.slice(16,20)+'-'+digest.slice(20);
   const result=await c.query(`INSERT INTO app.position_identities(household_id,id,owner_id,institution_id,custody_account_id,instrument_code,currency,identity_status,source_assertion_id)
     VALUES($1,$2,$3,$4,$5,$6,'BRL',$7,$8) ON CONFLICT(household_id,id) DO NOTHING`,[household,id,row.owner_id,row.institution_id,status==='resolved'?row.custody_account_id:null,row.instrument_code,status,row.assertion_id]);
   inserted+=result.rowCount??0;if(status==='resolved')resolved++;else provisional++;
  }
  await c.query("INSERT INTO app.audit_log(household_id,actor_id,action,resource_id,details) VALUES($1,$2,'b3_position_identities_seeded',$3,$4)",[household,actor,'018-position-identity-seed',{rows:rows.rowCount,inserted,resolved,provisional,source_documents:[...new Set(rows.rows.map(row=>row.document_id))],portfolio_changed:false,calculation_changed:false}]);
  await c.query('COMMIT');console.log(JSON.stringify({source_rows:rows.rowCount,inserted,resolved,provisional,portfolio_changed:false}));
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}finally{await db.end();}
