import {test} from 'node:test';
import assert from 'node:assert/strict';
import {D,exact,minor,integer} from '../src/money.ts';
import {buildPortfolio,selectInputs,type Inputs,type Row} from '../src/portfolio.ts';
const input=():Inputs=>({snapshots:[],trades:[],quotes:[],fx:null,facts_revision:'0'});
function source(payload:Row,id='1'){return {id,import_id:'i1',file_type:'positions',owner:'Fixture',reference_date:'2026-08-01',created_at:'2026-08-02 00:00:00',payload:JSON.stringify(payload)};}
test('decimal arithmetic preserves fractional holdings and rounds negative ties away from zero',()=>{
 assert.equal(exact('0.1').add(exact('0.2')).toFixed(),'0.3');assert.equal(minor(new D('-0.5')),'-1');assert.equal(minor(new D('0.5')),'1');assert.equal(integer('9007199254740993'),'9007199254740993');assert.throws(()=>integer(9007199254740993));
});
test('rejects unrepresentable input and bigint overflow instead of truncating',()=>{
 for(const value of ['NaN','Infinity','0.00000000001','1000000000000000000'])assert.throws(()=>exact(value));assert.throws(()=>minor(new D('9223372036854775808')));
});
test('USD without observed FX retains original currency and marks the subtotal',()=>{
 const i=input();i.snapshots=[source({owner:'Fixture',account:'custody1',currency:'USD',instrument_code:'AAPL',quantity:'0.3',unit_price:'3.35',market_value_minor:'101',reference_date:'2026-08-01'})];const result=buildPortfolio(i);assert.equal(result.positions[0].market_value_minor,'101');assert.equal(result.positions[0].market_value_cents,null);assert.equal(result.total_value_cents,'0');assert.equal(result.valuation_complete,false);
});
test('large monetary values are serialized as exact JSON strings',()=>{
 const i=input();i.snapshots=[source({owner:'Fixture',account:'a',currency:'BRL',instrument_code:'FIXTURE',quantity:'1',unit_price:'0',market_value_cents:'9007199254740993',reference_date:'2026-08-01'})];const v=buildPortfolio(i);assert.equal(v.total_value_cents,'9007199254740993');assert.equal(JSON.parse(JSON.stringify(v)).positions[0].market_value_cents,'9007199254740993');
});
test('events on the snapshot day and without account proof remain unapplied',()=>{
 const i=input();i.snapshots=[source({owner:'Fixture',account:'custody1',currency:'BRL',instrument_code:'PETR4',quantity:'10',unit_price:'30',market_value_cents:'30000',reference_date:'2026-08-01'})];i.trades=[source({owner:'Fixture',account:'custody1',instrument_code:'PETR4',quantity:'2',unit_price:'30',side:'buy',trade_date:'2026-08-01'}),source({owner:'Fixture',instrument_code:'PETR4',quantity:'2',unit_price:'30',side:'buy',trade_date:'2026-08-02'},'2')];const v=buildPortfolio(i);assert.equal(v.positions[0].quantity,'10');assert.deepEqual(v.issues.map(i=>i.code),['same_day_trade','unresolved_trade_account']);
});
test('known account fractional trades are exact; no ticker merge across accounts',()=>{
 const i=input();i.snapshots=[source({owner:'Fixture',account:'a',currency:'BRL',instrument_code:'PETR4',quantity:'0.1',unit_price:'3',market_value_cents:'30',reference_date:'2026-08-01'})];i.trades=[source({owner:'Fixture',account:'a',instrument_code:'PETR4',quantity:'0.2',unit_price:'3',side:'buy',trade_date:'2026-08-02'})];assert.equal(buildPortfolio(i).positions[0].quantity,'0.3');i.snapshots.push(source({owner:'Fixture',account:'b',currency:'BRL',instrument_code:'PETR4',quantity:'5',unit_price:'3',market_value_cents:'1500',reference_date:'2026-08-01'},'3'));const v=buildPortfolio(i);assert.equal(v.positions[0].quantity,'0.3');assert.equal(v.positions[1].quantity,'5');assert.equal(v.issues.length,0);
});
test('reference-date selection and knowledge cutoff exclude late and future data',()=>{
 const tables:Record<string,Row[]>={imports:[{id:'new',user_id:'fixture',owner:'Fixture',status:'processed',file_type:'positions',reference_date:'2026-08-01',created_at:'2026-08-02 00:00:00'},{id:'late',user_id:'fixture',owner:'Fixture',status:'processed',file_type:'positions',reference_date:'2026-07-01',created_at:'2026-08-10 00:00:00'}],import_records:[{id:1,import_id:'new',record_kind:'position',payload:'{}'},{id:2,import_id:'late',record_kind:'position',payload:'{}'}],market_quotes:[{user_id:'fixture',quoted_at:'2026-09-01',updated_at:'2026-08-01 00:00:00'},{user_id:'fixture',quoted_at:'2026-08-01',updated_at:'2026-08-20 00:00:00'}],fx_observations:[],portfolio_revisions:[]};const result=selectInputs(tables,'fixture','2026-08-15','2026-08-15T00:00:00.000Z');assert.equal(result.snapshots[0].import_id,'new');assert.equal(result.quotes.length,0);
});
