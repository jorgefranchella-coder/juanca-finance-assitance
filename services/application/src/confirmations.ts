import type pg from 'pg';
import { Conflict } from './commands.ts';

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
