import {randomUUID} from 'node:crypto';
import {pool} from './db.ts';
import {b3Quotes,nasdaqQuote,ptax} from './providers.ts';
import {refreshOnce} from './service.ts';
const db=pool();const id=randomUUID();let stopped=false;
async function loop(){while(!stopped){try{const didWork=await refreshOnce(db,id,{b3:b3Quotes,us:nasdaqQuote,fx:ptax});if(!didWork)await new Promise(r=>setTimeout(r,1000));}catch{await new Promise(r=>setTimeout(r,2000));}}}
for(const signal of ['SIGTERM','SIGINT'] as const)process.on(signal,()=>{stopped=true;void db.end();});
await loop();
