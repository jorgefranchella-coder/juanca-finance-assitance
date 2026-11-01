import {fetchBcbSelicDaily} from '../../services/market/src/bcb-selic.ts';
import {storeSelicImport} from '../../services/market/src/index-storage.ts';
import {pool} from '../../services/market/src/db.ts';

const args=process.argv.slice(2),apply=args.includes('--apply'),dates=args.filter(arg=>arg!=='--apply');
if(dates.length!==2)throw new Error('Usage: import_selic.ts YYYY-MM-DD YYYY-MM-DD [--apply]');
const data=await fetchBcbSelicDaily(dates[0],dates[1]);
if(!apply)console.log(JSON.stringify({mode:'preview',provider:data.provider,from:data.requested_from,to:data.requested_to,version:data.version,observations:data.observations.length}));
else {const db=pool();try{const result=await storeSelicImport(db,data);console.log(JSON.stringify({mode:'stored',...result,version:data.version}));}finally{await db.end();}}
