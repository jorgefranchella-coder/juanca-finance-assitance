import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateContractProjection,type ContractTerms} from '../src/fixed-income-contract.ts';
import type {B3DiMarketData} from '../src/fixed-income-b3-di.ts';
const terms:ContractTerms={calculation_basis:'b3_di',method:'indexed',indexer:'CDI',indexer_relation:'multiplier',interest_treatment:'capitalize',annual_rate_pct:'110',indexer_assumption_pct:'12',tax_rate_pct:null,schedule_confirmed:true,payment_schedule:[]};
const market:B3DiMarketData={observed_through:'2026-01-02',calendar:{source_uri:'fixture:calendar',version:'v1',coverage_start:'2026-01-02',coverage_end:'2026-01-05',days:[{date:'2026-01-02',business_day:true},{date:'2026-01-03',business_day:false},{date:'2026-01-04',business_day:false},{date:'2026-01-05',business_day:true}]},observations:[{date:'2026-01-02',indexer:'CDI',unit:'annual_effective_252',rate_pct:'10.00',source_uri:'fixture:di',version:'v1'}],future_assumption:{annual_rate_pct:'12.00',source:'fixture:scenario',as_of:'2026-01-02'}};
const position={current_value_cents:10000000,quantity:1,as_of:'2026-01-02',maturity_date:'2026-01-06',terms};
test('contract uses B3 factor and reports a maturity and source coverage',()=>{const result=calculateContractProjection({...position,market});assert.equal(result.status,'complete');assert.equal(result.version,'contract-b3-di-v1');assert.equal(result.gross_maturity_cents,10009111);assert.equal(result.calendar[0].maturity_cents,10009111);});
test('B3 contracts never fall back to the civil-day scenario on missing market data',()=>{const result=calculateContractProjection(position);assert.equal(result.status,'incomplete');assert.equal(result.gross_maturity_cents,null);const missing=calculateContractProjection({...position,market:{...market,observations:[]}});assert.equal(missing.status,'incomplete');assert.equal(missing.gross_maturity_cents,null);});
test('unsupported cashflows are incomplete rather than silently ignored',()=>{const result=calculateContractProjection({...position,terms:{...terms,payment_schedule:[{date:'2026-01-05',kind:'coupon',amount_per_unit:'1'}]},market});assert.equal(result.status,'incomplete');});

test('a scenario that differs from the documented contract is incomplete',()=>{const result=calculateContractProjection({...position,market:{...market,future_assumption:{annual_rate_pct:'13.00',source:'fixture:scenario',as_of:'2026-01-02'}}});assert.equal(result.status,'incomplete');});

test('each monthly cut equals an independently accumulated B3 interval',async()=>{
 const {accumulateB3Di}=await import('../src/b3-di-accumulation.ts');const {Decimal}=await import('decimal.js');
 const days:Array<{date:string;business_day:boolean;coverage_kind:'estimated'}>=[];for(let n=Date.parse('2027-01-01T00:00:00Z');n<Date.parse('2027-05-01T00:00:00Z');n+=86400000){const d=new Date(n);days.push({date:d.toISOString().slice(0,10),business_day:![0,6].includes(d.getUTCDay()),coverage_kind:'estimated'});}
 const inputs:B3DiMarketData={calendar:{source_uri:'fixture:calendar',version:'v1',coverage_start:'2027-01-01',coverage_end:'2027-04-30',days},observations:[],observed_through:'2026-12-31',future_assumption:{annual_rate_pct:'12.00',source:'fixture',as_of:'2026-12-31'}};
 const result=calculateContractProjection({...position,as_of:'2027-01-01',maturity_date:'2027-05-01',market:inputs});assert.equal(result.status,'complete');if(result.status!=='complete')return;
 for(const row of result.calendar){const factor=accumulateB3Di({from:'2027-01-01',to:row.date,percentage:terms.annual_rate_pct,...inputs});assert.equal(factor.status,'complete');const expected=new Decimal(position.current_value_cents).mul(factor.factor!).toDecimalPlaces(0,Decimal.ROUND_HALF_UP).toNumber();assert.equal(row.maturity_cents||row.balance_cents,expected);}
});
