import type pg from 'pg';
import {createHmac,timingSafeEqual} from 'node:crypto';
import {Conflict} from './commands.ts';
import type {Position} from './portfolio.ts';
export async function portfolio(db:pg.Pool,h:string,version?:string,effectiveAsOf?:string){
 if(version&&effectiveAsOf||effectiveAsOf&&(!/^\d{4}-\d{2}-\d{2}$/.test(effectiveAsOf)||Number.isNaN(Date.parse(`${effectiveAsOf}T00:00:00Z`))||new Date(`${effectiveAsOf}T00:00:00Z`).toISOString().slice(0,10)!==effectiveAsOf))throw new Conflict('VALIDATION',422);
 const r=version
  ?await db.query('SELECT v.* FROM app.portfolio_versions v WHERE v.household_id=$1 AND v.id=$2',[h,version])
  :effectiveAsOf
   ?await db.query('SELECT v.* FROM app.portfolio_versions v WHERE v.household_id=$1 AND v.effective_as_of<=$2::date ORDER BY v.effective_as_of DESC,v.published_at DESC,v.id DESC LIMIT 1',[h,effectiveAsOf])
   :await db.query('SELECT v.* FROM app.portfolio_versions v WHERE v.household_id=$1 AND v.id=(SELECT latest_version FROM app.household_state WHERE household_id=$1)',[h]);
 if(!r.rowCount)throw new Conflict('NOT_FOUND',404);const row=r.rows[0];
 return {...row.view,portfolio_version:row.id,facts_revision:row.facts_revision,market_revision:row.market_revision,calculation_version:row.calculation_version,effective_as_of:row.effective_as_of,known_at:row.known_at.toISOString(),published_at:row.published_at.toISOString(),mode:'shadow',authoritative:false};
}
type Cursor={household:string;version:string;owner:string|null;offset:number};
function encode(body:Cursor,key:string){const data=Buffer.from(JSON.stringify(body)).toString('base64url');return data+'.'+createHmac('sha256',key).update(data).digest('base64url');}
function decode(value:string,key:string):Cursor{
 try{const [body,signature,...rest]=value.split('.');if(rest.length||!body||!signature||value.length>2048)throw new Error();const expected=createHmac('sha256',key).update(body).digest();const provided=Buffer.from(signature,'base64url');if(provided.length!==expected.length||!timingSafeEqual(provided,expected))throw new Error();const c=JSON.parse(Buffer.from(body,'base64url').toString()) as Cursor;if(!Number.isSafeInteger(c.offset)||c.offset<0)throw new Error();return c;}catch{throw new Conflict('INVALID_CURSOR',422);}
}
export async function positionPage(db:pg.Pool,h:string,key:string,params:{version?:string;owner?:string;cursor?:string;limit?:number}){
 const limit=params.limit??100;if(!Number.isInteger(limit)||limit<1||limit>200)throw new Conflict('VALIDATION',422);
 const cursor=params.cursor?decode(params.cursor,key):null;
 if(cursor&&(cursor.household!==h||params.version&&cursor.version!==params.version||params.owner&&cursor.owner!==params.owner))throw new Conflict('CURSOR_SCOPE',422);
 const version=params.version??cursor?.version;const owner=params.owner??cursor?.owner??null;const view=await portfolio(db,h,version);
 const all=view.positions as Position[];const owners=await db.query('SELECT id,display_name FROM app.owners WHERE household_id=$1',[h]);
 const name=owner?owners.rows.find(r=>r.id===owner)?.display_name:null;if(owner&&!name)throw new Conflict('NOT_FOUND',404);
 const rows=owner?all.filter(p=>p.owner===name):all;const offset=cursor?.offset??0;
 return {portfolio_version:view.portfolio_version,facts_revision:view.facts_revision,effective_as_of:view.effective_as_of,valuation_as_of:view.valuation_as_of,valuation_cutoff_as_of:view.valuation_cutoff_as_of,known_at:view.known_at,published_at:view.published_at,calculation_version:view.calculation_version,market_revision:view.market_revision,positions:rows.slice(offset,offset+limit),count:rows.length,next_cursor:offset+limit<rows.length?encode({household:h,version:view.portfolio_version,owner,offset:offset+limit},key):null,mode:'shadow',authoritative:false};
}
