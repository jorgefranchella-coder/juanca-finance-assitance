import {test} from 'node:test';
import assert from 'node:assert/strict';
import {comparePortfolioPositions} from '../../../infra/migration/cutover_delta.ts';

test('cutover comparison normalizes exchange prefixes and aggregates split account rows',()=>{
 const d1=[{owner:'Jorge',instrument_code:'BVMF:PETR4',currency:'BRL',quantity:'2',market_value_cents:'6000'},{owner:'Jorge',instrument_code:'PETR4',currency:'BRL',quantity:'1.5',market_value_cents:'4500'}];
 const postgres=[{owner:'Jorge',instrument_code:'PETR4',currency:'BRL',quantity:'3.5',market_value_cents:'10500'}];
 const result=comparePortfolioPositions(d1,postgres);
 assert.equal(result.d1_position_count,1);assert.equal(result.postgres_position_count,1);assert.equal(result.matched_position_count,1);
 assert.equal(result.net_value_difference_cents,'0');assert.equal(result.differences.length,0);
});

test('cutover comparison separates missing, quantity and value differences with exact amounts',()=>{
 const d1=[{owner:'Jorge',instrument_code:'OLD1',quantity:'1.25',market_value_cents:'9007199254740993'},{owner:'Julia',instrument_code:'SAME',quantity:'2',market_value_cents:'200'}];
 const postgres=[{owner:'Jorge',instrument_code:'NEW1',quantity:'1',market_value_cents:'500'},{owner:'Julia',instrument_code:'SAME',quantity:'3',market_value_cents:'300'}];
 const result=comparePortfolioPositions(d1,postgres);
 assert.deepEqual(result.counts,{d1_only:1,postgres_only:1,quantity_only:0,value_only:0,quantity_and_value:1,matched:0});
 assert.equal(result.d1_total_cents,'9007199254741193');assert.equal(result.postgres_total_cents,'800');assert.equal(result.differences.length,3);
});
