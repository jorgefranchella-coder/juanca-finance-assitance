import {readFile} from 'node:fs/promises';
import {normalizeCalendar,storeCalendar} from '../../services/market/src/calendar-storage.ts';
import {pool} from '../../services/market/src/db.ts';
const args=process.argv.slice(2),apply=args.includes('--apply'),files=args.filter(arg=>arg!=='--apply');
if(files.length!==1)throw new Error('Usage: import_calendar.ts path-to-calendar.json [--apply]');
const data=normalizeCalendar(JSON.parse(await readFile(files[0],'utf8')));
if(!apply)console.log(JSON.stringify({mode:'preview',calendar_code:data.calendar_code,from:data.coverage_start,to:data.coverage_end,source:data.source_uri,days:data.days.length}));
else {const db=pool();try{const result=await storeCalendar(db,data);console.log(JSON.stringify({mode:'stored',...result}));}finally{await db.end();}}
