import {readFile} from 'node:fs/promises';
import {pool} from '../../services/application/src/db.ts';

const appConfig=JSON.parse(await readFile(process.env.JUANCA_SHADOW_CONFIG??'/home/jorge/.local/share/juanca-shadow/application.json','utf8')) as {household_id:string};
const webConfig=JSON.parse(await readFile(process.env.JUANCA_WEB_CREDENTIALS??'/home/jorge/.hermes/profiles/juanca/workspace/patrimonio-familiar-source/integration/credentials.json','utf8')) as {user_id:string};
if(!appConfig.household_id||typeof webConfig.user_id!=='string'||!webConfig.user_id)throw new Error('REVIEWER_CONFIG_INVALID');
const db=pool();const c=await db.connect();
try{
 await c.query('BEGIN');
 await c.query("INSERT INTO app.actors(id,attribution) VALUES($1,'Authenticated Juanca web reviewer') ON CONFLICT(id) DO NOTHING",[webConfig.user_id]);
 await c.query("INSERT INTO app.memberships(household_id,actor_id,role) VALUES($1,$2,'reviewer') ON CONFLICT(household_id,actor_id) DO NOTHING",[appConfig.household_id,webConfig.user_id]);
 const membership=await c.query('SELECT role FROM app.memberships WHERE household_id=$1 AND actor_id=$2',[appConfig.household_id,webConfig.user_id]);
 if(membership.rows[0]?.role!=='reviewer')throw new Error('REVIEWER_ALREADY_HAS_DIFFERENT_ROLE');
 await c.query('COMMIT');console.log('Authenticated Juanca web reviewer ready.');
}catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();await db.end();}
