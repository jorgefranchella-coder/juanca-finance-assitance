import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {pool,migrate} from '../../services/application/src/db.ts';
import {recordPositionIdentityResolution} from '../../services/application/src/acquisition-lots.ts';

const application=JSON.parse(await readFile(process.env.JUANCA_SHADOW_CONFIG??'/home/jorge/.local/share/juanca-shadow/application.json','utf8')) as {household_id:string};
const web=JSON.parse(await readFile(process.env.JUANCA_WEB_CREDENTIALS??'/home/jorge/.hermes/profiles/juanca/workspace/patrimonio-familiar-source/integration/credentials.json','utf8')) as {user_id:string};
if(!application.household_id||!web.user_id)throw new Error('MIGRATION_CONFIG_INVALID');
const db=pool();
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
try{
 await migrate(db);
 const c=await db.connect();let accountsCreated=0;
 let positions:{position_id:string;institution_id:string;assertion_id:string}[]=[];
 try{
  await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(736433)');
  const owner=await c.query("SELECT id FROM app.owners WHERE household_id=$1 AND display_name='Julia'",[application.household_id]);
  if(owner.rowCount!==1)throw new Error('JULIA_OWNER_NOT_UNIQUE');
  const membership=await c.query("SELECT 1 FROM app.memberships WHERE household_id=$1 AND actor_id=$2 AND role IN ('reviewer','owner','approver')",[application.household_id,web.user_id]);
  if(!membership.rowCount)throw new Error('REVIEWER_MEMBERSHIP_REQUIRED');
  const evidence=await c.query(`SELECT p.id AS position_id,p.institution_id,p.source_assertion_id AS assertion_id,a.interpretation_status
    FROM app.position_identities p JOIN app.source_assertions a ON a.household_id=p.household_id AND a.id=p.source_assertion_id
    WHERE p.household_id=$1 AND p.owner_id=$2 AND p.identity_status='provisional'
    ORDER BY p.institution_id,p.id`,[application.household_id,owner.rows[0].id]);
  if(!evidence.rowCount)throw new Error('JULIA_PROVISIONAL_POSITIONS_NOT_FOUND');
  if(evidence.rows.some(row=>row.interpretation_status!=='needs_review'))throw new Error('UNEXPECTED_POSITION_INTERPRETATION');
  positions=evidence.rows.map(row=>({position_id:String(row.position_id),institution_id:String(row.institution_id),assertion_id:String(row.assertion_id)}));
  const institutionIds=[...new Set(positions.map(row=>row.institution_id))];
  for(const institution of institutionIds){
   const existing=await c.query('SELECT id,identity_basis FROM app.custody_accounts WHERE household_id=$1 AND owner_id=$2 AND institution_id=$3 ORDER BY id',[application.household_id,owner.rows[0].id,institution]);
   if(existing.rows.length>1)throw new Error('MULTIPLE_JULIA_ACCOUNTS_REQUIRE_MANUAL_ASSIGNMENT');
   if(existing.rows.length===1){if(existing.rows[0].identity_basis!=='user_confirmed_unique')throw new Error('JULIA_ACCOUNT_IDENTITY_BASIS_CONFLICT');continue;}
   const id='custody-'+hash(JSON.stringify([application.household_id,owner.rows[0].id,institution])).slice(0,32);
   await c.query(`INSERT INTO app.custody_accounts(household_id,id,owner_id,institution_id,external_reference,identity_basis)
     VALUES($1,$2,$3,$4,NULL,'user_confirmed_unique')`,[application.household_id,id,owner.rows[0].id,institution]);
   accountsCreated++;
  }
  await c.query('COMMIT');
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
 let resolved=0;
 for(const position of positions){
  const account=await db.query('SELECT id FROM app.custody_accounts WHERE household_id=$1 AND owner_id=(SELECT owner_id FROM app.position_identities WHERE household_id=$1 AND id=$2) AND institution_id=$3',[application.household_id,position.position_id,position.institution_id]);
  if(account.rowCount!==1)throw new Error('JULIA_CUSTODY_ACCOUNT_NOT_UNIQUE');
  const requestKey=`julia-b3-account-${position.position_id}`;
  await recordPositionIdentityResolution(db,application.household_id,web.user_id,position.position_id,{request_key:requestKey,custody_account_id:account.rows[0].id,assertion_id:position.assertion_id,decision:'user_confirmed'});
  resolved++;
 }
 console.log(JSON.stringify({accounts_created:accountsCreated,positions_resolved:resolved,source_interpretation_preserved:'needs_review',portfolio_changed:false}));
}finally{await db.end();}
