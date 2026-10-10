import {createMarketServer} from './service.ts';
const {db}=await createMarketServer();
async function stop(){process.exitCode=0;await db.end();process.exit(0);}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
