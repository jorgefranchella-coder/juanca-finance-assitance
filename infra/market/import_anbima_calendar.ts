import {fetchAnbimaCalendarScenario} from '../../services/market/src/anbima-calendar.ts';
import {storeCalendar} from '../../services/market/src/calendar-storage.ts';
import {pool} from '../../services/market/src/db.ts';
const args=process.argv.slice(2),apply=args.includes('--apply'),dates=args.filter(arg=>arg!=='--apply');
if(dates.length!==2)throw new Error('Usage: import_anbima_calendar.ts YYYY-MM-DD YYYY-MM-DD [--apply]');
const calendar=await fetchAnbimaCalendarScenario(dates[0],dates[1]);
if(!apply)console.log(JSON.stringify({mode:'preview',calendar_code:calendar.calendar_code,coverage_kind:calendar.coverage_kind,from:calendar.coverage_start,to:calendar.coverage_end,source:calendar.source_uri,source_revision:calendar.source_revision,days:calendar.days.length}));
else{const db=pool();try{console.log(JSON.stringify({mode:'stored',coverage_kind:calendar.coverage_kind,...await storeCalendar(db,calendar)}));}finally{await db.end();}}
