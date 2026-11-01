import type pg from 'pg';
import {fetchB3Di} from './b3-di.ts';
import {listCalendar} from './calendar-storage.ts';
import {storeDiImport} from './index-storage.ts';

type DiImport=Awaited<ReturnType<typeof fetchB3Di>>;
type CalendarResult=Awaited<ReturnType<typeof listCalendar>>;
type Dependencies={loadCalendar:(from:string,to:string)=>Promise<CalendarResult>;fetchDi:(from:string,to:string)=>Promise<DiImport>;storeDi:(data:DiImport)=>Promise<unknown>};
const valid=(s:string)=>/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s+'T00:00:00Z'))&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;
/** Validate published DI against independently confirmed calendar dates before storing any observations. */
export async function syncDiHistory(input:{from:string;to:string;as_of:string;apply:boolean},deps:Dependencies){
 const {from,to,as_of,apply}=input;
 if(!valid(from)||!valid(to)||!valid(as_of)||from>to||to>=as_of||Date.parse(to+'T00:00:00Z')-Date.parse(from+'T00:00:00Z')>366*86400000)throw new Error('INVALID_DI_SYNC_INTERVAL');
 const result=await deps.loadCalendar(from,to);
 if(result.coverage!=='declared'||!result.calendar)return {status:'blocked' as const,reason:'calendar_coverage_missing',from,to};
 const unconfirmed=result.calendar.days.filter(day=>day.coverage_kind!=='confirmed').map(day=>day.date);
 if(unconfirmed.length)return {status:'blocked' as const,reason:'historical_calendar_unconfirmed',from,to,dates:unconfirmed};
 const data=await deps.fetchDi(from,to);
 if(data.requested_from!==from||data.requested_to!==to||data.provider!=='B3_DI_FTP'||!Array.isArray(data.observations))throw new Error('INVALID_DI_SYNC_SOURCE');
 const dates=new Set<string>();for(const row of data.observations){if(!valid(row.date)||row.date<from||row.date>to||dates.has(row.date)||row.indexer!=='CDI'||row.unit!=='annual_effective_252'||!/^\d{1,2}\.\d{2}$/.test(row.rate_pct)||!row.source_uri||!row.version)throw new Error('INVALID_DI_SYNC_SOURCE');dates.add(row.date);}
 const missing=result.calendar.days.filter(day=>day.business_day&&!dates.has(day.date)).map(day=>day.date);
 const unexpected=result.calendar.days.filter(day=>!day.business_day&&dates.has(day.date)).map(day=>day.date);
 if(missing.length||unexpected.length)return {status:'blocked' as const,reason:'calendar_index_disagreement',from,to,missing_rates:missing,unexpected_rates:unexpected};
 const count=data.observations.length;
 if(!count)return {status:'complete' as const,mode:apply?'no_changes':'preview',from,to,observations:0,calendar_version:result.calendar.version};
 if(!apply)return {status:'complete' as const,mode:'preview',from,to,observations:count,calendar_version:result.calendar.version,index_version:data.version};
 const stored=await deps.storeDi(data);return {status:'complete' as const,mode:'stored',from,to,observations:count,calendar_version:result.calendar.version,index_version:data.version,stored};
}
export function marketDiSyncDependencies(db:pg.Pool):Dependencies{return {loadCalendar:(from,to)=>listCalendar(db,'b3-di',from,to),fetchDi:fetchB3Di,storeDi:data=>storeDiImport(db,data)};}
