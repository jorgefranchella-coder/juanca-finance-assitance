import {pool} from '../../services/market/src/db.ts';
import {dailyDiWindow,verifyB3DiCalendars,storeVerifiedB3DiBatches} from '../../services/market/src/b3-di-calendar-2026.ts';
const args=process.argv.slice(2);if(args.some(x=>x!=='--apply')||args.length>1)throw new Error('Usage: sync_di_daily.ts [--apply]');
const {as_of,from,to}=dailyDiWindow(new Date());
const result=await verifyB3DiCalendars({from,to,as_of});
if(result.status==='blocked'){console.log(JSON.stringify(result));process.exitCode=2;}
else if(!args.includes('--apply'))console.log(JSON.stringify({status:'complete',mode:'preview',from,to,days:result.batches.reduce((n,x)=>n+x.calendar.days.length,0),observations:result.batches.reduce((n,x)=>n+x.data.observations.length,0)}));
else{const db=pool();try{console.log(JSON.stringify({status:'complete',mode:'stored',from,to,batches:await storeVerifiedB3DiBatches(db,result.batches)}));}catch(error){if(error instanceof Error&&error.message==='EXISTING_DI_DATA_DISAGREEMENT'){console.log(JSON.stringify({status:'blocked',reason:'existing_data_disagreement',from,to,conflicting_days:(error as Error & {conflicting_days:string[]}).conflicting_days,conflicting_rates:(error as Error & {conflicting_rates:string[]}).conflicting_rates,next_action:'Revisar las diferencias antes de registrar una corrección.'}));process.exitCode=2;}else throw error;}finally{await db.end();}}
