import test from 'node:test';
import assert from 'node:assert/strict';
import {Decimal} from 'decimal.js';
import {accumulateBusiness252,type Business252Input} from '../src/business-252.ts';

const fixture=():Business252Input=>({from:'2026-01-01',to:'2026-01-05',observed_through:'2026-01-02',relation:'multiplier',contract_rate_pct:'110',
 calendar:{source_uri:'fixture:calendar',version:'v1',coverage_start:'2026-01-02',coverage_end:'2026-01-05',days:[{date:'2026-01-02',business_day:true},{date:'2026-01-03',business_day:false},{date:'2026-01-04',business_day:false},{date:'2026-01-05',business_day:true}]},
 observations:[{date:'2026-01-02',rate_pct:'10',unit:'annual_effective_252',source_uri:'fixture:index',version:'v1'}],
 future_assumption:{annual_rate_pct:'12',source:'fixture:scenario',as_of:'2026-01-02'}});

test('252-day model applies the CDI percentage to each daily rate and separates observed from projected',()=>{
 const result=accumulateBusiness252(fixture());assert.equal(result.status,'complete');assert.deepEqual(result.days.map(d=>d.kind),['observed','projected']);
 const factor=(pct:string)=>new Decimal(1).plus(new Decimal(1).plus(new Decimal(pct).div(100)).pow(new Decimal(1).div(252)).minus(1).mul('1.10'));
 assert.ok(new Decimal(result.factor!).minus(factor('10').mul(factor('12'))).abs().lt('0.000000000000001'));
});
test('missing historical rates do not silently use the future assumption',()=>{const input=fixture();input.observations=[];const result=accumulateBusiness252(input);assert.equal(result.status,'incomplete');assert.equal(result.reason,'index_rates_missing');assert.deepEqual(result.missing_dates,['2026-01-02']);});
test('missing calendar dates fail closed rather than assuming weekdays',()=>{const input=fixture();input.calendar.days=input.calendar.days.filter(d=>d.date!=='2026-01-03');const result=accumulateBusiness252(input);assert.equal(result.status,'incomplete');assert.equal(result.reason,'calendar_dates_missing');});
test('daily-percent observations and compounded spread use distinct daily factors',()=>{const input=fixture();input.to='2026-01-02';input.relation='compound';input.contract_rate_pct='5';input.observations[0].unit='daily_percent';input.observations[0].rate_pct='0.04';const result=accumulateBusiness252(input);assert.equal(result.status,'complete');const expected=new Decimal('1.0004').mul(new Decimal('1.05').pow(new Decimal(1).div(252)));assert.ok(new Decimal(result.factor!).minus(expected).abs().lt('0.000000000000001'));});
