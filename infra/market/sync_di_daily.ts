import {pool} from '../../services/market/src/db.ts';
import {marketDiSyncDependencies,syncDiHistory} from '../../services/market/src/di-history-sync.ts';
const args=process.argv.slice(2);if(args.some(x=>x!=='--apply')||args.length>1)throw new Error('Usage: sync_di_daily.ts [--apply]');
const as_of=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const day=(offset:number)=>new Date(Date.parse(as_of+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10),db=pool();
try{const result=await syncDiHistory({from:day(-14),to:day(-1),as_of,apply:args.includes('--apply')},marketDiSyncDependencies(db));console.log(JSON.stringify(result));if(result.status==='blocked')process.exitCode=2;}finally{await db.end();}
