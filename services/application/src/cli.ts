import {pool,migrate} from './db.ts';
import {importEnvelope,publish} from './migration.ts';
const db=pool();
try{
 const [command,...args]=process.argv.slice(2);
 if(command==='migrate'){await migrate(db);console.log('Application schema ready.');}
 else if(command==='import'){console.log(JSON.stringify(await importEnvelope(db,args[0])));}
 else if(command==='publish'){const result=await publish(db,args[0],args[1],args[2],args[3]);console.log(JSON.stringify({portfolio_version:result.portfolio_version,count:result.view.count,complete:result.view.valuation_complete,identity_complete:result.view.identity_complete,issues:[...new Set(result.view.issues.map(i=>i.code))]}));}
 else throw new Error('Usage: cli.ts migrate | import private-envelope.json | publish run household YYYY-MM-DD known_at');
}finally{await db.end();}
