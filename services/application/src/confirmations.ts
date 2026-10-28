import type pg from 'pg';
import { Conflict } from './commands.ts';

type ConfirmationInput={owner:string;category:string;title:string;source_key:string;context:Record<string,unknown>;evidence:string[];actions:Array<{key:string;label:string;description?:string;keeps_open?:boolean}>};
const stable=(value:any):any=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
function validateConfirmation(input:unknown):ConfirmationInput{
 if(!input||typeof input!=='object'||Array.isArray(input))throw new Conflict('VALIDATION',422);
 const v=input as Record<string,unknown>,owner=typeof v.owner==='string'?v.owner:'',category=typeof v.category==='string'?v.category.trim():'',title=typeof v.title==='string'?v.title.trim():'',source_key=typeof v.source_key==='string'?v.source_key.trim():'';
 const context=v.context,evidence=v.evidence,actions=v.actions;
 if(!['Jorge','Julia','Sin identificar'].includes(owner)||!category||category.length>60||!title||title.length>240||!source_key||source_key.length>240||/[\u0000-\u001f\u007f]/.test(source_key)||!context||typeof context!=='object'||Array.isArray(context)||JSON.stringify(context).length>8000||!Array.isArray(evidence)||evidence.length>50||evidence.some(x=>typeof x!=='string'||x.length>1000)||!Array.isArray(actions)||actions.length<2||actions.length>12)throw new Conflict('VALIDATION',422);
 const valid=actions.every(a=>a&&typeof a==='object'&&!Array.isArray(a)&&typeof a.key==='string'&&/^[a-z0-9_-]{1,80}$/.test(a.key)&&typeof a.label==='string'&&a.label.length>0&&a.label.length<=180&&(a.description===undefined||typeof a.description==='string'&&a.description.length<=600)&&(a.keeps_open===undefined||typeof a.keeps_open==='boolean'));
 if(!valid||new Set(actions.map(a=>a.key)).size!==actions.length)throw new Conflict('VALIDATION',422);
 return {owner,category,title,source_key,context:context as Record<string,unknown>,evidence:evidence as string[],actions:actions as ConfirmationInput['actions']};
}

export async function createConfirmation(db:pg.Pool,household:string,actor:string,input:unknown){
 if(!actor)throw new Conflict('FORBIDDEN',403);const item=validateConfirmation(input),c=await db.connect();
 try{
  await c.query('BEGIN');
  const member=await c.query('SELECT 1 FROM app.memberships WHERE household_id=$1 AND actor_id=$2',[household,actor]);if(!member.rowCount)throw new Conflict('FORBIDDEN',403);
  const id=crypto.randomUUID();
  const inserted=await c.query(`INSERT INTO app.confirmation_items(household_id,id,source_key,owner,category,title,context,evidence,actions,status,created_at,updated_at)
   VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,'open',now(),now()) ON CONFLICT(household_id,source_key) DO NOTHING RETURNING id,status`,[household,id,item.source_key,item.owner,item.category,item.title,JSON.stringify(item.context),JSON.stringify(item.evidence),JSON.stringify(item.actions)]);
  if(inserted.rowCount){await c.query(`INSERT INTO app.audit_log(household_id,actor_id,action,resource_id,details) VALUES($1,$2,'confirmation_created',$3,$4)`,[household,actor,id,{source_key:item.source_key,category:item.category}]);await c.query('COMMIT');return {saved:true,duplicate:false,id,status:'open'};}
  const existing=await c.query('SELECT id,status,owner,category,title,context,evidence,actions FROM app.confirmation_items WHERE household_id=$1 AND source_key=$2',[household,item.source_key]);
  if(!existing.rowCount)throw new Conflict('CONFIRMATION_RETRY',409);const row=existing.rows[0];
  const same=row.owner===item.owner&&row.category===item.category&&row.title===item.title&&JSON.stringify(stable(row.context))===JSON.stringify(stable(item.context))&&JSON.stringify(stable(row.evidence))===JSON.stringify(stable(item.evidence))&&JSON.stringify(stable(row.actions))===JSON.stringify(stable(item.actions));
  if(!same)throw new Conflict('IDEMPOTENCY_MISMATCH',409);
  await c.query('COMMIT');return {saved:true,duplicate:true,id:row.id,status:row.status};
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}

export async function listConfirmations(db:pg.Pool,household:string,status?:string){
 if(status&&!['open','resolved'].includes(status))throw new Conflict('VALIDATION',422);
 const r=await db.query(`SELECT i.id,i.owner,i.category,i.title,i.context,i.evidence,i.actions,i.source_key,i.status,i.created_at,i.updated_at,
   COALESCE(jsonb_agg(jsonb_build_object('action_key',d.action_key,'note',d.note,'decided_at',d.created_at) ORDER BY d.ordinal)
     FILTER(WHERE d.ordinal IS NOT NULL),'[]'::jsonb) AS decisions
   FROM app.confirmation_items i LEFT JOIN app.confirmation_decisions d ON d.household_id=i.household_id AND d.item_id=i.id
   WHERE i.household_id=$1 AND ($2::text IS NULL OR i.status=$2)
   GROUP BY i.household_id,i.id ORDER BY CASE i.status WHEN 'open' THEN 0 ELSE 1 END,i.created_at DESC LIMIT 200`,[household,status??null]);
 const items=r.rows.map((x:any)=>({...x,decision:x.decisions.at(-1)??null}));
 return {items,open_count:items.filter((x:any)=>x.status==='open').length};
}

export async function recordConfirmationDecision(db:pg.Pool,household:string,actor:string,id:string,input:unknown){
 if(!actor||!id||!/^[A-Za-z0-9._:-]{1,240}$/.test(id))throw new Conflict('VALIDATION',422);
 const body=input&&typeof input==='object'?input as Record<string,unknown>:{};
 const actionKey=typeof body.action_key==='string'?body.action_key.trim():'';
 const note=typeof body.note==='string'?body.note.trim().slice(0,1000):'';
 if(!/^[a-z0-9_-]{1,80}$/.test(actionKey))throw new Conflict('VALIDATION',422);
 const c=await db.connect();
 try{
  await c.query('BEGIN');
  const membership=await c.query('SELECT 1 FROM app.memberships WHERE household_id=$1 AND actor_id=$2',[household,actor]);
  if(!membership.rowCount)throw new Conflict('FORBIDDEN',403);
  const r=await c.query('SELECT actions,status FROM app.confirmation_items WHERE household_id=$1 AND id=$2 FOR UPDATE',[household,id]);
  if(!r.rowCount)throw new Conflict('NOT_FOUND',404);
  const item=r.rows[0];if(item.status!=='open')throw new Conflict('ALREADY_RESOLVED',409);
  if(!Array.isArray(item.actions))throw new Conflict('INVALID_ITEM',409);
  const action=item.actions.find((a:any)=>a&&a.key===actionKey);
  if(!action)throw new Conflict('INVALID_ACTION',422);
  const ordinal=await c.query('SELECT COALESCE(MAX(ordinal),0)+1 AS n FROM app.confirmation_decisions WHERE household_id=$1 AND item_id=$2',[household,id]);
  const now=new Date();const next=action.keeps_open===true?'open':'resolved';
  await c.query('INSERT INTO app.confirmation_decisions(household_id,item_id,ordinal,action_key,note,created_at) VALUES($1,$2,$3,$4,$5,$6)',[household,id,ordinal.rows[0].n,actionKey,note||null,now]);
  await c.query('UPDATE app.confirmation_items SET status=$3,updated_at=$4 WHERE household_id=$1 AND id=$2',[household,id,next,now]);
  await c.query(`INSERT INTO app.audit_log(household_id,actor_id,action,resource_id,details) VALUES($1,$2,'confirmation_decided',$3,$4)`,[household,actor,id,{action_key:actionKey,status:next}]);
  await c.query('COMMIT');return {saved:true,id,action_key:actionKey,status:next};
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}

export async function completeQuoteRefreshFollowUp(db:pg.Pool,household:string,actor:string,id:string){
 if(!actor||!id||!/^[A-Za-z0-9._:-]{1,240}$/.test(id))throw new Conflict('VALIDATION',422);
 const c=await db.connect();
 try{
  await c.query('BEGIN');
  const member=await c.query('SELECT 1 FROM app.memberships WHERE household_id=$1 AND actor_id=$2',[household,actor]);if(!member.rowCount)throw new Conflict('FORBIDDEN',403);
  const itemResult=await c.query('SELECT id,source_key,status,context FROM app.confirmation_items WHERE household_id=$1 AND id=$2 FOR UPDATE',[household,id]);
  const item=itemResult.rows[0];if(!item)throw new Conflict('NOT_FOUND',404);
  if(item.status==='resolved'){await c.query('COMMIT');return{saved:true,id,status:'resolved',duplicate:true};}
  if(item.source_key!=='cutover-delta-20261021-jorge-market-quotes')throw new Conflict('INVALID_FOLLOW_UP',422);
  const decision=await c.query('SELECT action_key FROM app.confirmation_decisions WHERE household_id=$1 AND item_id=$2 ORDER BY ordinal DESC LIMIT 1',[household,id]);
  if(decision.rows[0]?.action_key!=='refresh_postgresql_quotes')throw new Conflict('FOLLOW_UP_NOT_REQUESTED',409);
  const target=String(item.context?.fecha_cotizacion_d1??''),required=Number(item.context?.posiciones_con_diferencia_de_valor_y_cantidad_igual);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(target)||!Number.isSafeInteger(required)||required<1)throw new Conflict('INVALID_FOLLOW_UP',422);
  const latest=await c.query('SELECT v.view FROM app.portfolio_versions v JOIN app.household_state s ON s.household_id=v.household_id AND s.latest_version=v.id WHERE v.household_id=$1',[household]);
  const positions=latest.rows[0]?.view?.positions;
  if(!Array.isArray(positions))throw new Conflict('PORTFOLIO_UNAVAILABLE',409);
  const refreshed=positions.filter((position:any)=>position.owner==='Jorge'&&position.currency==='USD'&&typeof position.price_as_of==='string'&&position.price_as_of.slice(0,10)>=target).length;
  if(refreshed<required)throw new Conflict('QUOTE_REFRESH_INCOMPLETE',409);
  await c.query("UPDATE app.confirmation_items SET status='resolved',updated_at=now() WHERE household_id=$1 AND id=$2",[household,id]);
  await c.query("INSERT INTO app.audit_log(household_id,actor_id,action,resource_id,details) VALUES($1,$2,'confirmation_follow_up_completed',$3,$4)",[household,actor,id,{previous_decision:'refresh_postgresql_quotes',target_date:target,required_positions:required,refreshed_positions:refreshed}]);
  await c.query('COMMIT');return{saved:true,id,status:'resolved',refreshed_positions:refreshed,required_positions:required};
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
