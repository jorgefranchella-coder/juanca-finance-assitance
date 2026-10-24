import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {pool} from '../../services/application/src/db.ts';

type Decision={legacy_id:number;legacy_user_id:string;action_key:string;note:string|null;created_at:string};
type Item={id:string;legacy_user_id:string;owner:string;category:string;title:string;context:Record<string,unknown>;evidence:string[];actions:Array<{key:string;label:string}>;source_key:string;status:'open'|'resolved';created_at:string;updated_at:string;decisions:Decision[]};
const source=process.argv.find(x=>x.startsWith('--source='))?.slice(9);
const apply=process.argv.includes('--apply');
if(!source)throw new Error('Usage: transfer_confirmations.ts --source=/private/path/to/d1.sqlite [--apply]');
const exported=spawnSync('python3',[new URL('./export_confirmations.py',import.meta.url).pathname,source],{encoding:'utf8',maxBuffer:20*1024*1024});
if(exported.status!==0)throw new Error('D1_CONFIRMATION_EXPORT_FAILED');
const envelope=JSON.parse(exported.stdout) as {sha256:string;payload:{format:string;items:Item[]}};
if(envelope.payload.format!=='juanca-confirmation-transfer-v1'||!/^[0-9a-f]{64}$/.test(envelope.sha256)||!Array.isArray(envelope.payload.items))throw new Error('INVALID_CONFIRMATION_EXPORT');
const items=envelope.payload.items;
const users=[...new Set(items.map(i=>i.legacy_user_id))];if(users.length>1)throw new Error('MULTIPLE_LEGACY_USERS_REQUIRE_SEPARATE_TRANSFER');
for(const i of items){if(!i.id||!i.legacy_user_id||!i.source_key||!['open','resolved'].includes(i.status)||!['Jorge','Julia','Sin identificar'].includes(i.owner)||!Array.isArray(i.actions)||!Array.isArray(i.decisions))throw new Error('INVALID_LEGACY_CONFIRMATION');}
const config=JSON.parse(await readFile(process.env.JUANCA_SHADOW_CONFIG??'/home/jorge/.local/share/juanca-shadow/application.json','utf8')) as {household_id:string};
const db=pool();const household=config.household_id;const sourceKey=`legacy-d1-confirmations:${users[0]??'empty'}`;
const stable=(x:any):any=>Array.isArray(x)?x.map(stable):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,stable(x[k])])):x;
const sameJson=(a:unknown,b:unknown)=>JSON.stringify(stable(a))===JSON.stringify(stable(b));
const timestamp=(value:string|Date)=>new Date(value instanceof Date?value:value.replace(' ','T')+'Z').toISOString();
const c=await db.connect();
try{
 await c.query('BEGIN');
 const existingTransfer=await c.query('SELECT export_sha256,item_count,decision_count FROM app.confirmation_transfers WHERE household_id=$1 AND source_key=$2 FOR UPDATE',[household,sourceKey]);
 const existingItems=await c.query('SELECT id,source_key,owner,category,title,context,evidence,actions,status,created_at,updated_at,legacy_user_id FROM app.confirmation_items WHERE household_id=$1',[household]);
 const existingById=new Map(existingItems.rows.map((r:any)=>[r.id,r]));
 let decisions=0;
 for(const i of items){
  const found=existingById.get(i.id) as any;
  if(!found){if(existingById.size)throw new Error('PARTIAL_OR_COLLIDING_CONFIRMATION_DATA');if(apply){
   await c.query(`INSERT INTO app.confirmation_items(household_id,id,source_key,owner,category,title,context,evidence,actions,status,created_at,updated_at,legacy_user_id)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[household,i.id,i.source_key,i.owner,i.category,i.title,JSON.stringify(i.context),JSON.stringify(i.evidence),JSON.stringify(i.actions),i.status,i.created_at,i.updated_at,i.legacy_user_id]);}
  }else{
   const same=found.source_key===i.source_key&&found.owner===i.owner&&found.category===i.category&&found.title===i.title&&sameJson(found.context,i.context)&&sameJson(found.evidence,i.evidence)&&sameJson(found.actions,i.actions)&&timestamp(found.created_at)===timestamp(i.created_at)&&found.legacy_user_id===i.legacy_user_id;
   if(!same)throw new Error('EXISTING_CONFIRMATION_DIFFERS_FROM_D1');
  }
  const prior=await c.query('SELECT ordinal,action_key,note,created_at,legacy_user_id FROM app.confirmation_decisions WHERE household_id=$1 AND item_id=$2 ORDER BY ordinal',[household,i.id]);
  if((prior.rowCount??0)>i.decisions.length)throw new Error('POSTGRES_HAS_EXTRA_DECISIONS');
  for(let n=0;n<i.decisions.length;n++){
   const d=i.decisions[n];const old=prior.rows[n];if(old){if(old.action_key!==d.action_key||old.note!==d.note||old.legacy_user_id!==d.legacy_user_id||timestamp(old.created_at)!==timestamp(d.created_at))throw new Error('DECISION_HISTORY_DIFFERS_FROM_D1');}
   else if(apply)await c.query('INSERT INTO app.confirmation_decisions(household_id,item_id,ordinal,action_key,note,created_at,legacy_user_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[household,i.id,n+1,d.action_key,d.note,d.created_at,d.legacy_user_id]);
  }
  decisions+=i.decisions.length;
  if(found&&apply)await c.query('UPDATE app.confirmation_items SET status=$3,updated_at=$4 WHERE household_id=$1 AND id=$2',[household,i.id,i.status,i.updated_at]);
 }
 if(!apply){await c.query('ROLLBACK');console.log(JSON.stringify({mode:'preflight',items:items.length,decisions,sha256:envelope.sha256,already_transferred:(existingTransfer.rowCount??0)>0}));}
 else{
  await c.query(`INSERT INTO app.confirmation_transfers(household_id,source_key,export_sha256,item_count,decision_count)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(household_id,source_key) DO UPDATE SET export_sha256=EXCLUDED.export_sha256,item_count=EXCLUDED.item_count,decision_count=EXCLUDED.decision_count,transferred_at=now()`,[household,sourceKey,envelope.sha256,items.length,decisions]);
  await c.query('COMMIT');console.log(JSON.stringify({mode:'applied',items:items.length,decisions,sha256:envelope.sha256}));
 }
}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();await db.end();}
