import {createHash,randomUUID} from 'node:crypto';
import type pg from 'pg';

export type CalendarInput={calendar_code:string;source_uri:string;source_revision:string;coverage_start:string;coverage_end:string;days:Array<{date:string;business_day:boolean}>};
const validDate=(value:string)=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const date=new Date(value+'T00:00:00Z');return Number.isFinite(date.valueOf())&&date.toISOString().slice(0,10)===value;};
const next=(value:string)=>new Date(Date.parse(value+'T00:00:00Z')+86400000).toISOString().slice(0,10);
export function normalizeCalendar(value:unknown):CalendarInput{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('INVALID_CALENDAR');const input=value as Record<string,unknown>;
 if(Object.keys(input).some(k=>!['calendar_code','source_uri','source_revision','coverage_start','coverage_end','days'].includes(k)))throw new Error('INVALID_CALENDAR');
 const code=String(input.calendar_code??''),uri=String(input.source_uri??''),revision=String(input.source_revision??''),start=String(input.coverage_start??''),end=String(input.coverage_end??'');
 if(!/^[a-z0-9_-]{1,60}$/.test(code)||!/^https:\/\//.test(uri)||uri.length>500||!revision.trim()||revision.length>240||!validDate(start)||!validDate(end)||start>end||end>'9998-12-31'||Date.parse(end+'T00:00:00Z')-Date.parse(start+'T00:00:00Z')>18300*86400000||!Array.isArray(input.days)||input.days.length>20000)throw new Error('INVALID_CALENDAR');
 const map=new Map<string,boolean>();for(const raw of input.days){if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('INVALID_CALENDAR');const row=raw as Record<string,unknown>,date=String(row.date??'');if(Object.keys(row).some(k=>!['date','business_day'].includes(k))||!validDate(date)||date<start||date>end||typeof row.business_day!=='boolean'||map.has(date))throw new Error('INVALID_CALENDAR');map.set(date,row.business_day);}
 const days:CalendarInput['days']=[];for(let date=start;date<=end;date=next(date)){if(!map.has(date))throw new Error('CALENDAR_DATES_MISSING');days.push({date,business_day:map.get(date)!});}
 return {calendar_code:code,source_uri:uri,source_revision:revision.trim(),coverage_start:start,coverage_end:end,days};
}
export async function storeCalendar(db:pg.Pool,raw:unknown){
 const input=normalizeCalendar(raw),digest=createHash('sha256').update(JSON.stringify(input)).digest('hex'),c=await db.connect();try{await c.query('BEGIN');const id=randomUUID();
  const inserted=await c.query(`INSERT INTO market.calendar_imports(id,calendar_code,source_uri,source_revision,content_sha256,coverage_start,coverage_end) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(calendar_code,content_sha256) DO NOTHING RETURNING id`,[id,input.calendar_code,input.source_uri,input.source_revision,digest,input.coverage_start,input.coverage_end]);
  if(!inserted.rowCount){const old=await c.query('SELECT id FROM market.calendar_imports WHERE calendar_code=$1 AND content_sha256=$2',[input.calendar_code,digest]);await c.query('COMMIT');return {calendar_id:old.rows[0].id,version:digest,replayed:true,days:input.days.length};}
  for(const day of input.days)await c.query('INSERT INTO market.calendar_days(import_id,civil_date,business_day) VALUES($1,$2,$3)',[id,day.date,day.business_day]);
  await c.query('COMMIT');return {calendar_id:id,version:digest,replayed:false,days:input.days.length};
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
export async function listCalendar(db:pg.Pool,code:string,from:string,to:string){
 if(!/^[a-z0-9_-]{1,60}$/.test(code)||!validDate(from)||!validDate(to)||from>to||to>'9998-12-31'||Date.parse(to+'T00:00:00Z')-Date.parse(from+'T00:00:00Z')>18300*86400000)throw new Error('INVALID_CALENDAR_INTERVAL');
 const selected=await db.query(`SELECT id,source_uri,source_revision,content_sha256,coverage_start::text,coverage_end::text FROM market.calendar_imports WHERE calendar_code=$1 AND coverage_start<=$2::date AND coverage_end>=$3::date ORDER BY received_at DESC,id DESC LIMIT 1`,[code,from,to]);
 if(!selected.rowCount)return {calendar:null,coverage:'missing' as const};const item=selected.rows[0];
 const days=await db.query('SELECT civil_date::text AS date,business_day FROM market.calendar_days WHERE import_id=$1 AND civil_date BETWEEN $2::date AND $3::date ORDER BY civil_date',[item.id,from,to]);
 return {calendar:{calendar_code:code,source_uri:item.source_uri,source_revision:item.source_revision,version:item.content_sha256,coverage_start:from,coverage_end:to,days:days.rows},coverage:'declared' as const};
}
