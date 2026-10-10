import {pool} from './db.ts';
import {marketEvents,receiveMarketEvent} from './market-bridge.ts';
const db=pool(),once=process.argv.includes('--once');let stopping=false;
process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
try{while(!stopping){
 try{for(let page=0;page<10000&&!stopping;page++){
  const state=await db.query("SELECT last_outbox_id FROM app.market_feed_state WHERE feed='market'"),events=await marketEvents(String(state.rows[0].last_outbox_id));
  for(const event of events){const result=await receiveMarketEvent(db,event);console.log(JSON.stringify({market_outbox_id:event.id,quotes:result.quotes,fx:result.fx,replayed:result.replayed}));}
  if(events.length<100)break;
 }}catch(error){console.error(JSON.stringify({market_bridge_error:error instanceof Error?error.message:'UNKNOWN'}));if(once)throw error;}
 if(once)break;await new Promise(resolve=>setTimeout(resolve,30000));
}}finally{await db.end();}
