import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {marketB3DiInputs} from '../src/market-bridge.ts';

test('market bridge uses internal authentication and fetches calendar and observed CDI',async()=>{
 const token='fixture-token-'.repeat(4),calls:string[]=[];
 const server=createServer((req,res)=>{assert.equal(req.headers.authorization,'Bearer '+token);calls.push(req.url??'');res.setHeader('Content-Type','application/json');if(req.url?.startsWith('/v1/calendars/'))res.end(JSON.stringify({coverage:'declared',calendar:{source_uri:'https://example.test',version:'v1',coverage_start:'2026-01-02',coverage_end:'2026-01-05',days:[]}}));else res.end(JSON.stringify({indexer:'CDI',observations:[{date:'2026-01-02',rate_pct:'10.00',unit:'annual_effective_252',indexer:'CDI',source_uri:'fixture',version:'v1'}]}));});
 server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');
 const dir=await mkdtemp(join(tmpdir(),'juanca-market-')),file=join(dir,'market.json');await writeFile(file,JSON.stringify({token,port:address.port}));process.env.JUANCA_MARKET_CONFIG=file;
 try{const result=await marketB3DiInputs({from:'2026-01-02',to:'2026-01-06',observed_through:'2026-01-02',calendar_code:'fixture',assumption:{annual_rate_pct:'12.00',source:'scenario',as_of:'2026-01-02'}});assert.equal(result?.observations.length,1);assert.equal(calls.length,2);assert.match(calls[0],/to=2026-01-05/);assert.match(calls[1],/to=2026-01-02/);}finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});delete process.env.JUANCA_MARKET_CONFIG;}
});
