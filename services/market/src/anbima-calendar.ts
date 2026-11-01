import {createHash} from 'node:crypto';
import xlsx from 'xlsx';
import {normalizeCalendar} from './calendar-storage.ts';

const SOURCE='https://www.anbima.com.br/feriados/';
const DATA='https://www.anbima.com.br/feriados/arqs/feriados_nacionais.xls';
const valid=(s:string)=>/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s+'T00:00:00Z'))&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;
/** A future calendar scenario, not an official DI calendar. Weekends and ANBIMA dates are closed; other days are assumed open. */
export async function fetchAnbimaCalendarScenario(from:string,to:string,fetcher:typeof fetch=fetch){
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 if(!valid(from)||!valid(to)||from<today||from>to||from<'2001-01-01'||to>'2099-12-31'||Date.parse(to+'T00:00:00Z')-Date.parse(from+'T00:00:00Z')>18300*86400000)throw new Error('INVALID_CALENDAR_SCENARIO_INTERVAL');
 const response=await fetcher(DATA,{signal:AbortSignal.timeout(15000)});if(!response.ok)throw new Error('ANBIMA_UNAVAILABLE');const buffer=Buffer.from(await response.arrayBuffer());if(buffer.length>4_000_000)throw new Error('ANBIMA_TOO_LARGE');
 const workbook=xlsx.read(buffer,{type:'buffer'}),sheet=workbook.Sheets.Feriados;if(!sheet)throw new Error('ANBIMA_INVALID_DATA');const rows=xlsx.utils.sheet_to_json<unknown[]>(sheet,{header:1}),holidays=new Set<string>();
 for(const row of rows){if(typeof row[0]!=='number')continue;const parsed=xlsx.SSF.parse_date_code(row[0]);if(!parsed)throw new Error('ANBIMA_INVALID_DATA');const day=`${String(parsed.y).padStart(4,'0')}-${String(parsed.m).padStart(2,'0')}-${String(parsed.d).padStart(2,'0')}`;if(!valid(day))throw new Error('ANBIMA_INVALID_DATA');holidays.add(day);}
 for(let year=Number(from.slice(0,4));year<=Number(to.slice(0,4));year++)if(!holidays.has(`${year}-01-01`)||!holidays.has(`${year}-12-25`))throw new Error('ANBIMA_YEAR_NOT_COVERED');
 const days=[];for(let n=Date.parse(from+'T00:00:00Z');n<=Date.parse(to+'T00:00:00Z');n+=86400000){const d=new Date(n),date=d.toISOString().slice(0,10);days.push({date,business_day:d.getUTCDay()!==0&&d.getUTCDay()!==6&&!holidays.has(date)});}
 const hash=createHash('sha256').update(buffer).digest('hex');
 return normalizeCalendar({coverage_kind:'estimated',calendar_code:'b3-di',source_uri:SOURCE,source_revision:`ANBIMA feriados; sha256=${hash}; escenarios: fines de semana y feriados`,coverage_start:from,coverage_end:to,days});
}
