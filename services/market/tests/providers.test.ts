import {test} from 'node:test';
import assert from 'node:assert/strict';
import {archiveDateToTradingDate,parseCotahist} from '../src/providers.ts';

test('B3 archive filename date maps to the trading date inside COTAHIST rows',()=>{
 assert.equal(archiveDateToTradingDate('09102026'),'20261009');
 const line='01'+'20261009'+' '.repeat(2)+'PETR4'.padEnd(12)+'010'+' '.repeat(81)+'0000000003999'+' '.repeat(124);
 const parsed=parseCotahist(line,['PETR4'],archiveDateToTradingDate('09102026'));
 assert.equal(parsed.length,1);assert.equal(parsed[0].price,'39.99');
});
