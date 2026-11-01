import {fetchB3Di} from './b3-di.ts';
import {normalizeCalendar} from './calendar-storage.ts';

type DiImport=Awaited<ReturnType<typeof fetchB3Di>>;
const SOURCE='https://www.b3.com.br/data/files/20/57/01/AA/06A1F910ADC36BE9AC094EA8/OC%20041-2026-VNC%20ERRATA%20-%20CALENDARIO%20DE%20FERIADOS%20EM%202026_PT.pdf';
// Circular 041/2026-VNC, national closures; 24/31 December are deliberately not assumed closed for DI.
const CLOSED=new Set(['2026-01-01','2026-02-16','2026-02-17','2026-04-03','2026-04-21','2026-05-01','2026-06-04','2026-09-07','2026-10-12','2026-11-02','2026-11-20','2026-12-25']);
const valid=(s:string)=>/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s+'T00:00:00Z'))&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;
/** Historical calendar is confirmable only when B3's published DI files agree with independently specified closures. */
export async function verifyB3DiCalendar2026(input:{from:string;to:string;as_of:string},fetcher:(from:string,to:string)=>Promise<DiImport>=fetchB3Di){
 const {from,to,as_of}=input;
 if(!valid(from)||!valid(to)||!valid(as_of)||from<'2026-01-01'||to>'2026-12-31'||from>to||to>=as_of)throw new Error('INVALID_B3_2026_CALENDAR_INTERVAL');
 const data=await fetcher(from,to);
 if(data.provider!=='B3_DI_FTP'||data.requested_from!==from||data.requested_to!==to||!Array.isArray(data.observations)||!/^[a-f0-9]{64}$/.test(data.version))throw new Error('INVALID_B3_DI_SOURCE');
 const observations=new Set<string>();for(const row of data.observations){if(!valid(row.date)||row.date<from||row.date>to||row.indexer!=='CDI'||row.unit!=='annual_effective_252'||!/^\d{1,2}\.\d{2}$/.test(row.rate_pct)||observations.has(row.date))throw new Error('INVALID_B3_DI_SOURCE');observations.add(row.date);}
 const days:Array<{date:string;business_day:boolean}>=[],missing:string[]=[],unexpected:string[]=[];
 for(let n=Date.parse(from+'T00:00:00Z');n<=Date.parse(to+'T00:00:00Z');n+=86400000){const d=new Date(n),date=d.toISOString().slice(0,10),closed=d.getUTCDay()===0||d.getUTCDay()===6||CLOSED.has(date),published=observations.has(date);
  if(closed&&published)unexpected.push(date);else if(!closed&&!published)missing.push(date);else days.push({date,business_day:published});
 }
 if(missing.length||unexpected.length)return {status:'blocked' as const,reason:'calendar_index_disagreement',missing_rates:missing,unexpected_rates:unexpected};
 const calendar=normalizeCalendar({coverage_kind:'confirmed',calendar_code:'b3-di',source_uri:SOURCE,source_revision:`041/2026-VNC; DI FTP sha256=${data.version}`,coverage_start:from,coverage_end:to,days});
 return {status:'complete' as const,calendar,data};
}

/** Persist the verified calendar and rate batch in one transaction; replays are harmless. */
export async function storeVerifiedB3Di2026(db:import('pg').Pool,result:Extract<Awaited<ReturnType<typeof verifyB3DiCalendar2026>>,{status:'complete'}>){
 const {createHash,randomUUID}=await import('node:crypto'),calendar=result.calendar,data=result.data,digest=createHash('sha256').update(JSON.stringify(calendar)).digest('hex'),c=await db.connect();
 try{await c.query('BEGIN');const calendarId=randomUUID(),inserted=await c.query(`INSERT INTO market.calendar_imports(id,calendar_code,source_uri,source_revision,content_sha256,coverage_start,coverage_end,coverage_kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(calendar_code,content_sha256) DO NOTHING RETURNING id`,[calendarId,calendar.calendar_code,calendar.source_uri,calendar.source_revision,digest,calendar.coverage_start,calendar.coverage_end,calendar.coverage_kind]);
  if(inserted.rowCount)for(const day of calendar.days)await c.query('INSERT INTO market.calendar_days(import_id,civil_date,business_day) VALUES($1,$2,$3)',[calendarId,day.date,day.business_day]);
  let indexInserted=false;
  if(data.observations.length){const id=randomUUID(),index=await c.query(`INSERT INTO market.index_imports(id,provider,indexer,source_uri,content_sha256,requested_from,requested_to) VALUES($1,$2,'CDI',$3,$4,$5,$6) ON CONFLICT(provider,indexer,content_sha256,requested_from,requested_to) DO NOTHING RETURNING id`,[id,data.provider,data.source_uri,data.version,data.requested_from,data.requested_to]);indexInserted=Boolean(index.rowCount);if(indexInserted)for(const row of data.observations)await c.query('INSERT INTO market.index_observations(import_id,observed_on,rate_pct,unit) VALUES($1,$2,$3,$4)',[id,row.date,row.rate_pct,row.unit]);}
  await c.query('COMMIT');return {calendar_replayed:!inserted.rowCount,index_replayed:data.observations.length?!indexInserted:null,calendar_version:digest,observations:data.observations.length};
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
