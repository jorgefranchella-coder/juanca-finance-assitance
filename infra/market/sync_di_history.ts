import {pool} from '../../services/market/src/db.ts';
import {marketDiSyncDependencies,syncDiHistory} from '../../services/market/src/di-history-sync.ts';
const args=process.argv.slice(2),apply=args.includes('--apply'),dates=args.filter(arg=>arg!=='--apply');
if(dates.length!==2)throw new Error('Usage: sync_di_history.ts YYYY-MM-DD YYYY-MM-DD [--apply]');
const as_of=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()),db=pool();
try{const result=await syncDiHistory({from:dates[0],to:dates[1],as_of,apply},marketDiSyncDependencies(db));console.log(JSON.stringify(result));if(result.status==='blocked')process.exitCode=2;}finally{await db.end();}
