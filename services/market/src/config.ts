import {readFile} from 'node:fs/promises';
export type MarketConfig={token:string;port:number};
export async function config():Promise<MarketConfig>{
 const value=JSON.parse(await readFile(process.env.JUANCA_MARKET_CONFIG??'/home/jorge/.local/share/juanca-shadow/market.json','utf8')) as MarketConfig;
 if(value.token.length<32||!Number.isInteger(value.port)||value.port<1024||value.port>65535)throw new Error('INVALID_CONFIGURATION');
 return value;
}
