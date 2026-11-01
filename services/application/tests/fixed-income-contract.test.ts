import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateContractProjection,type ContractTerms} from '../src/fixed-income-contract.ts';

const base={current_value_cents:10_000,quantity:10,as_of:'2026-01-01',maturity_date:'2027-01-01'};
const terms=(patch:Partial<ContractTerms>={}):ContractTerms=>({method:'fixed',interest_treatment:'capitalize',indexer_relation:'additive',indexer:'none',annual_rate_pct:'10',indexer_assumption_pct:null,tax_rate_pct:null,schedule_confirmed:true,payment_schedule:[],...patch});

test('fixed annual rate compounds to maturity and versions its gross forecast',()=>{
 const result=calculateContractProjection({...base,terms:terms()});
 assert.equal(result.status,'complete');assert.equal(result.version,'contract-projection-v1');
 assert.ok(Math.abs((result.gross_maturity_cents??0)-11_000)<5);
 assert.ok(result.calendar.some((row)=>row.date==='2026-01-31'));
 assert.equal(result.net_maturity_cents,null);
});

test('indexed projection requires and applies an explicit index scenario',()=>{
 const missing=calculateContractProjection({...base,terms:terms({method:'indexed',indexer:'CDI',indexer_assumption_pct:null})});
 assert.equal(missing.status,'incomplete');assert.deepEqual(missing.missing,['supuesto de proyección CDI']);
 const result=calculateContractProjection({...base,terms:terms({method:'indexed',indexer:'CDI',annual_rate_pct:'5',indexer_assumption_pct:'4'})});
 assert.equal(result.status,'complete');assert.equal(result.rate_pct,9);
});

test('index multiplier models contracts such as 110% of CDI separately from spread',()=>{
 const result=calculateContractProjection({...base,terms:terms({method:'indexed',indexer:'CDI',indexer_relation:'multiplier',annual_rate_pct:'110',indexer_assumption_pct:'4'})});
 assert.equal(result.status,'complete');assert.equal(result.rate_pct,4.4);
});

test('compounded indexed spread is distinct from adding percentage points',()=>{
 const result=calculateContractProjection({...base,terms:terms({method:'indexed',indexer:'IPCA',indexer_relation:'compound',annual_rate_pct:'5',indexer_assumption_pct:'4'})});
 assert.equal(result.status,'complete');assert.ok(Math.abs((result.rate_pct??0)-9.2)<0.000001);
});

test('explicit coupons appear on their payment date and are reported as gross and net',()=>{
 const result=calculateContractProjection({...base,terms:terms({annual_rate_pct:'0',tax_rate_pct:'20',payment_schedule:[{date:'2026-07-01',kind:'coupon',amount_per_unit:'0.5'}]})});
 assert.equal(result.status,'complete');
 const coupon=result.calendar.find((row)=>row.date==='2026-07-01');
 assert.equal(coupon?.cashflow_cents,500);
 assert.equal(result.gross_cashflows_cents,500);assert.equal(result.net_cashflows_cents,400);
});

test('explicit amortization returns principal and reduces the later maturity balance',()=>{
 const result=calculateContractProjection({...base,terms:terms({annual_rate_pct:'0',tax_rate_pct:'15',payment_schedule:[{date:'2026-07-01',kind:'amortization',amount_per_unit:'2'}]})});
 assert.equal(result.status,'complete');
 const amortization=result.calendar.find((row)=>row.date==='2026-07-01');
 assert.equal(amortization?.cashflow_cents,2_000);
 assert.equal(result.gross_maturity_cents,8_000);
 assert.equal(result.net_maturity_cents,null);assert.equal(result.tax_status,'amortization_tax_basis_missing');
});

test('cashflow treatment keeps principal flat and projects only explicit payments',()=>{
 const result=calculateContractProjection({...base,terms:terms({interest_treatment:'cashflow',payment_schedule:[{date:'2026-07-01',kind:'coupon',amount_per_unit:'0.5'}]})});
 assert.equal(result.status,'complete');assert.equal(result.rate_pct,null);assert.equal(result.gross_maturity_cents,10_000);
 assert.equal(result.calendar.find((row)=>row.date==='2026-07-01')?.cashflow_cents,500);
});

test('fixed forecast without maturity is explicitly incomplete',()=>{
 const result=calculateContractProjection({...base,maturity_date:'',terms:terms()});
 assert.equal(result.status,'incomplete');assert.deepEqual(result.missing,['fecha de vencimiento']);
});

test('unconfirmed payment schedule and excessive amortization never produce a complete forecast',()=>{
 const unconfirmed=calculateContractProjection({...base,terms:terms({schedule_confirmed:false})});
 assert.equal(unconfirmed.status,'incomplete');assert.equal(unconfirmed.gross_maturity_cents,null);
 const excessive=calculateContractProjection({...base,terms:terms({annual_rate_pct:'0',payment_schedule:[{date:'2026-07-01',kind:'amortization',amount_per_unit:'20'}]})});
 assert.equal(excessive.status,'incomplete');assert.equal(excessive.gross_maturity_cents,null);
});
