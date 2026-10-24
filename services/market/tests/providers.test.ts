import {test} from 'node:test';
import assert from 'node:assert/strict';
import {archiveDateToTradingDate,parseCotahist,yahooQuote} from '../src/providers.ts';

test('B3 archive filename date maps to the trading date inside COTAHIST rows',()=>{
 assert.equal(archiveDateToTradingDate('09102026'),'20261009');
 const line='01'+'20261009'+' '.repeat(2)+'PETR4'.padEnd(12)+'010'+' '.repeat(81)+'0000000003999'+' '.repeat(124);
 const parsed=parseCotahist(line,['PETR4'],archiveDateToTradingDate('09102026'));
 assert.equal(parsed.length,1);assert.equal(parsed[0].price,'39.99');
});
test('US quote adapter uses Yahoo market price and observation timestamp',async()=>{
 const quote=await yahooQuote('NVDA',async()=>new Response(JSON.stringify({chart:{result:[{meta:{regularMarketPrice:210.96,regularMarketTime:1792699200}}]}}),{status:200}));
 assert.equal(quote.provider,'yahoo_public');assert.equal(quote.price,'210.96');assert.equal(quote.observed_at,new Date(1792699200*1000).toISOString());
});
test('US quote adapter rejects bad provider payloads instead of recording a fabricated price',async()=>{
 await assert.rejects(()=>yahooQuote('NVDA',async()=>new Response(JSON.stringify({chart:{result:[{meta:{regularMarketPrice:0}}]}}),{status:200})),/YAHOO_QUOTE_INVALID/);
});
