import {fetchB3Di} from './b3-di.ts';
import {normalizeCalendar} from './calendar-storage.ts';

type DiImport=Awaited<ReturnType<typeof fetchB3Di>>;
export const SOURCE_2026='https://www.b3.com.br/data/files/20/57/01/AA/06A1F910ADC36BE9AC094EA8/OC%20041-2026-VNC%20ERRATA%20-%20CALENDARIO%20DE%20FERIADOS%20EM%202026_PT.pdf';
// Circular 041/2026-VNC, national closures; 24/31 December are deliberately not assumed closed for DI.
export const CLOSED_2026=new Set(['2026-01-01','2026-02-16','2026-02-17','2026-04-03','2026-04-21','2026-05-01','2026-06-04','2026-09-07','2026-10-12','2026-11-02','2026-11-20','2026-12-25']);
const valid=(s:string)=>/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s+'T00:00:00Z'))&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;
export type CalendarDefinition={year:number;source_uri:string;source_revision:string;closed:ReadonlySet<string>};
export const CONFIRMED_CALENDARS:Readonly<Record<number,CalendarDefinition>>={2026:{year:2026,source_uri:SOURCE_2026,source_revision:'041/2026-VNC',closed:CLOSED_2026}};

/** Historical calendar is confirmable only when B3's published DI files agree with independently specified closures. */
export async function verifyB3DiCalendar2026(input:{from:string;to:string;as_of:string},fetcher:(from:string,to:string)=>Promise<DiImport>=fetchB3Di){
 if(!valid(input.from)||!valid(input.to)||!valid(input.as_of)||input.from<'2026-01-01'||input.to>'2026-12-31'||input.from>input.to||input.to>=input.as_of)throw new Error('INVALID_B3_2026_CALENDAR_INTERVAL');
 return verifyYear(input,CONFIRMED_CALENDARS[2026],fetcher);
}
async function verifyYear(input:{from:string;to:string;as_of:string},definition:CalendarDefinition,fetcher:(from:string,to:string)=>Promise<DiImport>){
 const {from,to}=input;
 const data=await fetcher(from,to);
 if(data.provider!=='B3_DI_FTP'||data.requested_from!==from||data.requested_to!==to||!Array.isArray(data.observations)||!/^[a-f0-9]{64}$/.test(data.version))throw new Error('INVALID_B3_DI_SOURCE');
 const observations=new Set<string>();for(const row of data.observations){if(!valid(row.date)||row.date<from||row.date>to||row.indexer!=='CDI'||row.unit!=='annual_effective_252'||!/^\d{1,2}\.\d{2}$/.test(row.rate_pct)||observations.has(row.date))throw new Error('INVALID_B3_DI_SOURCE');observations.add(row.date);}
 const days:Array<{date:string;business_day:boolean}>=[],missing:string[]=[],unexpected:string[]=[];
 for(let n=Date.parse(from+'T00:00:00Z');n<=Date.parse(to+'T00:00:00Z');n+=86400000){const d=new Date(n),date=d.toISOString().slice(0,10),closed=d.getUTCDay()===0||d.getUTCDay()===6||definition.closed.has(date),published=observations.has(date);
  if(closed&&published)unexpected.push(date);else if(!closed&&!published)missing.push(date);else days.push({date,business_day:published});
 }
 if(missing.length||unexpected.length)return {status:'blocked' as const,reason:'calendar_index_disagreement',missing_rates:missing,unexpected_rates:unexpected};
 const calendar=normalizeCalendar({coverage_kind:'confirmed',calendar_code:'b3-di',source_uri:definition.source_uri,source_revision:`${definition.source_revision}; DI FTP sha256=${data.version}`,coverage_start:from,coverage_end:to,days});
 return {status:'complete' as const,calendar,data};
}


/** Validate all year sources before fetching or storing any portion of the interval. */
export async function verifyB3DiCalendars(input:{from:string;to:string;as_of:string},options:{calendars?:Readonly<Record<number,CalendarDefinition>>;fetcher?:(from:string,to:string)=>Promise<DiImport>}={}){
 const {from,to,as_of}=input;
 if(!valid(from)||!valid(to)||!valid(as_of)||from>to||to>=as_of||Date.parse(to+'T00:00:00Z')-Date.parse(from+'T00:00:00Z')>366*86400000)throw new Error('INVALID_B3_CALENDAR_INTERVAL');
 const calendars=options.calendars??CONFIRMED_CALENDARS,years:number[]=[];
 for(let y=Number(from.slice(0,4));y<=Number(to.slice(0,4));y++)years.push(y);
 const missing_years=years.filter(y=>!calendars[y]);
 if(missing_years.length)return {status:'blocked' as const,reason:'calendar_source_unavailable' as const,from,to,missing_years,next_action:'Incorporar y revisar la fuente oficial B3 independiente para cada año faltante.'};
 const batches:Array<Extract<Awaited<ReturnType<typeof verifyYear>>,{status:'complete'}>>=[];
 for(const year of years){const definition=calendars[year];if(definition.year!==year)throw new Error('INVALID_B3_CALENDAR_DEFINITION');
  const start=from>`${year}-01-01`?from:`${year}-01-01`,end=to<`${year}-12-31`?to:`${year}-12-31`;
  const result=await verifyYear({from:start,to:end,as_of},definition,options.fetcher??fetchB3Di);
  if(result.status==='blocked')return {...result,year,from,to};batches.push(result);
 }
 return {status:'complete' as const,from,to,batches};
}
export function dailyDiWindow(now:Date){
 const as_of=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
 const day=(offset:number)=>new Date(Date.parse(as_of+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10);
 return {as_of,from:day(-14),to:day(-1)};
}

/** Persist the verified calendar and rate batch in one transaction; replays are harmless. */
export async function storeVerifiedB3Di2026(db:import('pg').Pool,result:Extract<Awaited<ReturnType<typeof verifyB3DiCalendar2026>>,{status:'complete'}>){
 return (await storeVerifiedB3DiBatches(db,[result]))[0];
}
export async function storeVerifiedB3DiBatches(db:import('pg').Pool,results:Array<Extract<Awaited<ReturnType<typeof verifyYear>>,{status:'complete'}>>){
 const {createHash,randomUUID}=await import('node:crypto'),c=await db.connect(),stored=[];
 try{await c.query('BEGIN');for(const result of results){const calendar=result.calendar,data=result.data,digest=createHash('sha256').update(JSON.stringify(calendar)).digest('hex');
  const existingDays=await c.query(`SELECT DISTINCT ON(d.civil_date) d.civil_date::text AS date,d.business_day FROM market.calendar_days d JOIN market.calendar_imports i ON i.id=d.import_id WHERE i.calendar_code=$1 AND i.coverage_kind='confirmed' AND d.civil_date BETWEEN $2::date AND $3::date ORDER BY d.civil_date,i.received_at DESC,i.id DESC`,[calendar.calendar_code,calendar.coverage_start,calendar.coverage_end]);
  const existingRates=await c.query(`SELECT DISTINCT ON(o.observed_on) o.observed_on::text AS date,o.rate_pct::text AS rate_pct FROM market.index_observations o JOIN market.index_imports i ON i.id=o.import_id WHERE i.indexer='CDI' AND o.observed_on BETWEEN $1::date AND $2::date ORDER BY o.observed_on,i.received_at DESC,i.id DESC`,[data.requested_from,data.requested_to]);
  const dayMap=new Map(calendar.days.map(day=>[day.date,day.business_day])),rateMap=new Map(data.observations.map(row=>[row.date,Number(row.rate_pct)]));
  const conflicting_days=existingDays.rows.filter(row=>dayMap.get(row.date)!==row.business_day).map(row=>row.date),conflicting_rates=existingRates.rows.filter(row=>rateMap.has(row.date)&&rateMap.get(row.date)!==Number(row.rate_pct)).map(row=>row.date);
  if(conflicting_days.length||conflicting_rates.length)throw Object.assign(new Error('EXISTING_DI_DATA_DISAGREEMENT'),{conflicting_days,conflicting_rates});
  const calendarId=randomUUID(),inserted=await c.query(`INSERT INTO market.calendar_imports(id,calendar_code,source_uri,source_revision,content_sha256,coverage_start,coverage_end,coverage_kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(calendar_code,content_sha256) DO NOTHING RETURNING id`,[calendarId,calendar.calendar_code,calendar.source_uri,calendar.source_revision,digest,calendar.coverage_start,calendar.coverage_end,calendar.coverage_kind]);
  if(inserted.rowCount)for(const day of calendar.days)await c.query('INSERT INTO market.calendar_days(import_id,civil_date,business_day) VALUES($1,$2,$3)',[calendarId,day.date,day.business_day]);
  let indexInserted=false;
  if(data.observations.length){const id=randomUUID(),index=await c.query(`INSERT INTO market.index_imports(id,provider,indexer,source_uri,content_sha256,requested_from,requested_to) VALUES($1,$2,'CDI',$3,$4,$5,$6) ON CONFLICT(provider,indexer,content_sha256,requested_from,requested_to) DO NOTHING RETURNING id`,[id,data.provider,data.source_uri,data.version,data.requested_from,data.requested_to]);indexInserted=Boolean(index.rowCount);if(indexInserted)for(const row of data.observations)await c.query('INSERT INTO market.index_observations(import_id,observed_on,rate_pct,unit) VALUES($1,$2,$3,$4)',[id,row.date,row.rate_pct,row.unit]);}
  stored.push({calendar_replayed:!inserted.rowCount,index_replayed:data.observations.length?!indexInserted:null,calendar_version:digest,observations:data.observations.length});}
  await c.query('COMMIT');return stored;
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
