import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixedIncomeProjection} from '../src/fixed-income.ts';

test('shadow fixed-income projection rebuilds historical prices and current holdings from archived snapshots',async()=>{
 const owner='Fixture';
 const archived=[
  {run_id:'run-old',import:{id:'import-old',owner,status:'processed',file_type:'positions',reference_date:'2026-01-01',created_at:'2026-01-02'},record:{id:1,record_kind:'position',payload:JSON.stringify({owner,asset_class:'fixed_income',instrument_code:'CDBTEST',product_name:'CDB Fixture',institution:'Custodian',issuer:'Fixture Bank',quantity:'2',unit_price:'10000',market_value_cents:'2000000',maturity_date:'2027-01-01',reference_date:'2026-01-01'})}},
  {run_id:'run-new',import:{id:'import-new',owner,status:'processed',file_type:'positions',reference_date:'2026-10-01',created_at:'2026-10-02'},record:{id:2,record_kind:'position',payload:JSON.stringify({owner,asset_class:'fixed_income',instrument_code:'CDBTEST',product_name:'CDB Fixture',institution:'Custodian',issuer:'Fixture Bank',quantity:'2',unit_price:'10500',market_value_cents:'2100000',maturity_date:'2027-01-01',reference_date:'2026-10-01'})}},
  {run_id:'run-new',import:{id:'import-new',owner,status:'processed',file_type:'positions',reference_date:'2026-10-01',created_at:'2026-10-02'},record:{id:3,record_kind:'position',payload:JSON.stringify({owner,asset_class:'fixed_income',instrument_code:'LCITEST',product_name:'LCI Fixture',institution:'Custodian',issuer:'Fixture Bank',quantity:'3',unit_price:'1000',market_value_cents:'300000',maturity_date:'2027-02-01',reference_date:'2026-10-01'})}},
 ];
 let call=0;const fake={query:async()=>({rows:call++===0?archived:[],rowCount:0})} as never;
 const result=await fixedIncomeProjection(fake,'household-test');
 assert.equal(result.reference_date,'2026-10-01');assert.equal(result.summary.total_count,2);assert.equal(result.summary.total_current_cents,2400000);
 const cdb=result.items.find(item=>item.instrument_code==='CDBTEST')!;assert.equal(cdb.owner,owner);assert.equal(cdb.issuer,'Fixture Bank');assert.equal(cdb.observationCount,2);
 assert.equal(cdb.firstDate,'2026-01-01');assert.equal(cdb.lastDate,'2026-10-01');assert.ok((cdb.projected_value_cents??0)>cdb.current_value_cents);
 assert.equal(result.authoritative,false);
});

test('resolved acquisition lots add account-scoped cost observations and supersede accountless legacy costs',async()=>{
 const owner='Fixture';
 const archived=[
  {run_id:'run-old',import:{id:'import-old',owner,status:'processed',file_type:'positions',reference_date:'2026-01-01',created_at:'2026-01-02'},record:{id:1,record_kind:'position',payload:JSON.stringify({owner,asset_class:'fixed_income',instrument_code:'CDBTEST',product_name:'CDB Fixture',institution:'Custodian',issuer:'Fixture Bank',quantity:'2',unit_price:'10000',market_value_cents:'2000000',maturity_date:'2027-01-01',reference_date:'2026-01-01'})}},
  {run_id:'run-new',import:{id:'import-new',owner,status:'processed',file_type:'positions',reference_date:'2026-10-01',created_at:'2026-10-02'},record:{id:2,record_kind:'position',payload:JSON.stringify({owner,asset_class:'fixed_income',instrument_code:'CDBTEST',product_name:'CDB Fixture',institution:'Custodian',issuer:'Fixture Bank',quantity:'2',unit_price:'10500',market_value_cents:'2100000',maturity_date:'2027-01-01',reference_date:'2026-10-01'})}},
 ];
 const lots=[{owner,institution:'Custodian',instrument_code:'CDBTEST',currency:'BRL',lot_currency:'BRL',custody_identity_resolved:true,resolved_account_count:1,account_reference:null,external_reference:null,effective_date:'2026-02-01',quantity:'2',unit_price:'9000',fees_minor:100,voided:false}];
 const legacy=[{cost:{owner,instrument_code:'CDBTEST',average_unit_cost:5000,as_of:'2026-03-01',source:'legacy'}}];
 const responses=[archived,[],lots,legacy];let call=0;const fake={query:async()=>({rows:responses[call++]??[],rowCount:0})} as never;
 const result=await fixedIncomeProjection(fake,'household-test');const cdb=result.items.find(item=>item.instrument_code==='CDBTEST')!;
 assert.equal(cdb.observationCount,3);assert.equal(cdb.firstDate,'2026-01-01');
 assert.deepEqual(cdb.observation_sources,['acquisition_lot','b3_position']);
 assert.ok(cdb.projected_value_cents!>cdb.current_value_cents);
 assert.equal(result.acquisition_lot_diagnostics.used_lots,1);
});

test('acquisition lots are excluded when an accountless position could map to multiple custody accounts',async()=>{
 const owner='Fixture';const archived=[{run_id:'run',import:{id:'current',owner,status:'processed',file_type:'positions',reference_date:'2026-10-01',created_at:'2026-10-02'},record:{id:1,record_kind:'position',payload:JSON.stringify({owner,asset_class:'fixed_income',instrument_code:'CDBTEST',institution:'Custodian',quantity:'2',unit_price:'10500',market_value_cents:'2100000',maturity_date:'2027-01-01',reference_date:'2026-10-01'})}}];
 const lots=[{owner,institution:'Custodian',instrument_code:'CDBTEST',currency:'BRL',lot_currency:'BRL',custody_identity_resolved:true,resolved_account_count:2,account_reference:null,external_reference:null,effective_date:'2026-02-01',quantity:'2',unit_price:'9000',fees_minor:0,voided:false}];
 const responses=[archived,[],lots,[]];let call=0;const fake={query:async()=>({rows:responses[call++]??[],rowCount:0})} as never;
 const result=await fixedIncomeProjection(fake,'household-test');const cdb=result.items.find(item=>item.instrument_code==='CDBTEST')!;
 assert.equal(cdb.observation_sources.includes('acquisition_lot'),false);assert.equal(cdb.observationCount,1);
 assert.equal(result.acquisition_lot_diagnostics.ambiguous_position,1);
});
