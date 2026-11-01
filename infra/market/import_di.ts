import {fetchB3Di} from '../../services/market/src/b3-di.ts';
import {storeDiImport} from '../../services/market/src/index-storage.ts';
import {pool} from '../../services/market/src/db.ts';
const args=process.argv.slice(2),apply=args.includes('--apply'),dates=args.filter(x=>x!=='--apply');
if(dates.length!==2)throw new Error('Usage: import_di.ts YYYY-MM-DD YYYY-MM-DD [--apply]');
const data=await fetchB3Di(dates[0],dates[1]);
if(!apply)console.log(JSON.stringify({mode:'preview',provider:data.provider,from:data.requested_from,to:data.requested_to,version:data.version,observations:data.observations.length,transport:'ftp_unencrypted'}));
else{const db=pool();try{console.log(JSON.stringify({mode:'stored',...await storeDiImport(db,data),version:data.version,transport:'ftp_unencrypted'}));}finally{await db.end();}}
