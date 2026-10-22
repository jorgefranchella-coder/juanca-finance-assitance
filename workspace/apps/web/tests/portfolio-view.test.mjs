import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPortfolioView } from '../lib/portfolio-view.ts';
const snapshot = (payload,file_type='positions')=>({id:1,import_id:'snapshot',file_type,owner:'Jorge',reference_date:'2026-08-01',payload:JSON.stringify({owner:'Jorge',instrument_code:'PETR4',quantity:10,unit_price:30,market_value_cents:30000,reference_date:'2026-08-01',asset_class:'equity',...payload})});
const trade = (payload)=>({id:2,import_id:'trade',file_type:'chat_transaction',owner:'Jorge',reference_date:'2026-08-02',payload:JSON.stringify({owner:'Jorge',instrument_code:'PETR4',side:'sell',quantity:7,unit_price:30,currency:'BRL',trade_date:'2026-08-02',...payload})});
test('sales share the remaining-quantity valuation policy',()=>{
 const view=buildPortfolioView([snapshot({})],[trade({})],[],null);
 assert.equal(view.positions[0].quantity,3);assert.equal(view.total_value_cents,9000);
 assert.equal(view.positions[0].base_reference_date,'2026-08-01');
});
test('an oversold legacy fact remains visible rather than clamped to zero',()=>{
 const view=buildPortfolioView([snapshot({})],[trade({quantity:12})],[],null);
 assert.equal(view.positions[0].quantity,-2);assert.equal(view.positions[0].market_value_cents,null);
 assert.equal(view.valuation_complete,false);assert.equal(view.issues[0].code,'negative_position');
});
test('missing foreign exchange retains USD and marks the total incomplete',()=>{
 const view=buildPortfolioView([snapshot({instrument_code:'AAPL',currency:'USD',quantity:2,market_value_minor:45000},'avenue_statement')],[],[],null);
 assert.equal(view.positions[0].market_value_minor,45000);assert.equal(view.positions[0].market_value_cents,null);
 assert.equal(view.total_value_cents,0);assert.equal(view.unvalued_count,1);assert.equal(view.valuation_complete,false);
});
test('USD transactions update invested quantities without tracking the statement cash balance',()=>{
 const cash=snapshot({instrument_code:'USD_CASH',currency:'USD',quantity:100,unit_price:1,market_value_minor:10000,asset_class:'cash'},'avenue_statement');
 const asset=snapshot({instrument_code:'AAPL',currency:'USD',quantity:2,unit_price:50,market_value_minor:10000,asset_class:'international_equity'},'avenue_statement');
 const sale=trade({instrument_code:'AAPL',currency:'USD',quantity:1,unit_price:50,trade_date:'2026-08-02',principal_minor:5000});
 const view=buildPortfolioView([cash,asset],[sale],[],{rate:5,date:'2026-08-02'});
 assert.deepEqual(view.positions.map(p=>p.instrument_code),['AAPL']);assert.equal(view.positions[0].quantity,1);
});
test('same-day trades require an explicit snapshot cutoff',()=>{
 const view=buildPortfolioView([snapshot({})],[trade({trade_date:'2026-08-01'})],[],null);
 assert.equal(view.positions[0].quantity,10);assert.equal(view.issues[0].code,'same_day_trade');
});
test('unknown custody does not merge two accounts with the same ticker',()=>{
 const view=buildPortfolioView([snapshot({account:'A'}),snapshot({account:'B'})],[trade({})],[],null);
 assert.equal(view.positions.length,2);assert.equal(view.issues[0].code,'ambiguous_account');
});
