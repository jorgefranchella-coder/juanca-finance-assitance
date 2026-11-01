import {pool} from '../../services/market/src/db.ts';
import {verifyB3DiCalendar2026,storeVerifiedB3Di2026} from '../../services/market/src/b3-di-calendar-2026.ts';
const args=process.argv.slice(2);if(args.some(x=>x!=='--apply')||args.length>1)throw new Error('Usage: sync_di_daily.ts [--apply]');
const as_of=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const day=(offset:number)=>new Date(Date.parse(as_of+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10),from=day(-14),to=day(-1);
// The independent B3 circular encoded here covers only 2026; a later year requires its own verified source.
const result=await verifyB3DiCalendar2026({from,to,as_of});
if(result.status==='blocked'){console.log(JSON.stringify(result));process.exitCode=2;}
else if(!args.includes('--apply'))console.log(JSON.stringify({status:'complete',mode:'preview',from,to,days:result.calendar.days.length,observations:result.data.observations.length}));
else{const db=pool();try{console.log(JSON.stringify({status:'complete',mode:'stored',from,to,...await storeVerifiedB3Di2026(db,result)}));}finally{await db.end();}}
