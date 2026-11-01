import {verifyB3DiCalendar2026,storeVerifiedB3Di2026} from '../../services/market/src/b3-di-calendar-2026.ts';
import {pool} from '../../services/market/src/db.ts';
const args=process.argv.slice(2),apply=args.includes('--apply'),dates=args.filter(x=>x!=='--apply');
if(dates.length!==2||args.length!==dates.length+(apply?1:0))throw new Error('Usage: confirm_b3_di_2026.ts YYYY-MM-DD YYYY-MM-DD [--apply]');
const as_of=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const result=await verifyB3DiCalendar2026({from:dates[0],to:dates[1],as_of});
if(result.status==='blocked'){console.log(JSON.stringify(result));process.exitCode=2;}
else if(!apply)console.log(JSON.stringify({status:'complete',mode:'preview',from:dates[0],to:dates[1],calendar_days:result.calendar.days.length,observations:result.data.observations.length,index_version:result.data.version}));
else{const db=pool();try{const stored=await storeVerifiedB3Di2026(db,result);console.log(JSON.stringify({status:'complete',mode:'stored',...stored}));}finally{await db.end();}}
