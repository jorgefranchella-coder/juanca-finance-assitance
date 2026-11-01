import {Decimal} from 'decimal.js';
import type {BusinessCalendar} from './business-252.ts';

const D=Decimal.clone({precision:40,rounding:Decimal.ROUND_HALF_UP});
const DATE=/^\d{4}-\d{2}-\d{2}$/;
const dateOk=(s:string)=>DATE.test(s)&&Number.isFinite(Date.parse(s+'T00:00:00Z'))&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;
const next=(s:string)=>new Date(Date.parse(s+'T00:00:00Z')+86400000).toISOString().slice(0,10);
const incomplete=(reason:string,missing_dates:string[]=[])=>({status:'incomplete' as const,reason,missing_dates,factor:null,days:[],version:'b3-di-accumulation-v1'});
export type DiObservation={date:string;rate_pct:string;unit:'annual_effective_252';indexer:'CDI';source_uri:string;version:string};
export type B3DiInput={from:string;to:string;observed_through:string;calendar:BusinessCalendar;observations:DiObservation[];percentage:string;future_assumption:{annual_rate_pct:string;source:string;as_of:string}|null};

/** B3 percentage-DI calculation: [from,to), with historical observations and an explicitly dated future scenario. */
export function accumulateB3Di(input:B3DiInput){
 const c=input.calendar;
 if(!dateOk(input.from)||!dateOk(input.to)||!dateOk(input.observed_through)||input.from>input.to||input.to>'9998-12-31'||Date.parse(input.to+'T00:00:00Z')-Date.parse(input.from+'T00:00:00Z')>18300*86400000||!c||!dateOk(c.coverage_start)||!dateOk(c.coverage_end)||!c.source_uri?.trim()||!c.version?.trim()||!Array.isArray(c.days)||c.days.length>20000||!Array.isArray(input.observations)||input.observations.length>20000)return incomplete('invalid_interval_or_calendar');
 if(input.from<input.to&&(c.coverage_start>input.from||c.coverage_end<input.to&&next(c.coverage_end)!==input.to))return incomplete('calendar_coverage_missing');
 if(typeof input.percentage!=='string'||!/^\d{1,5}(?:\.\d{1,4})?$/.test(input.percentage))return incomplete('invalid_percentage');
 const pct=new D(input.percentage).div(100),calendar=new Map<string,boolean>(),observations=new Map<string,DiObservation>();
 for(const day of c.days){if(!dateOk(day.date)||typeof day.business_day!=='boolean'||calendar.has(day.date))return incomplete('invalid_calendar');calendar.set(day.date,day.business_day);}
 for(const row of input.observations){if(!dateOk(row.date)||row.indexer!=='CDI'||row.unit!=='annual_effective_252'||!/^\d{1,3}(?:\.\d{1,2})?$/.test(row.rate_pct)||!row.source_uri?.trim()||!row.version?.trim()||observations.has(row.date))return incomplete('invalid_index_observation');observations.set(row.date,row);}
 let product=new D(1);const days:Array<{date:string;kind:'observed'|'projected';rate_pct:string;daily_rate:string;factor:string;source:string;version:string}>=[],missingCalendar:string[]=[],missingRates:string[]=[];
 for(let date=input.from;date<input.to;date=next(date)){
  if(!calendar.has(date)){missingCalendar.push(date);continue;}if(!calendar.get(date))continue;
  const observed=date<=input.observed_through?observations.get(date):undefined,scenario=input.future_assumption;
  if(date<=input.observed_through&&!observed){missingRates.push(date);continue;}
  if(date>input.observed_through&&(!scenario||!/^\d{1,3}(?:\.\d{1,2})?$/.test(scenario.annual_rate_pct)||!scenario.source?.trim()||!dateOk(scenario.as_of)||scenario.as_of>input.observed_through)){missingRates.push(date);continue;}
  const rate=observed?.rate_pct??scenario!.annual_rate_pct;
  const daily=new D(1).plus(new D(rate).div(100)).pow(new D(1).div(252)).minus(1).toDecimalPlaces(8,D.ROUND_HALF_UP);
  const factor=new D(1).plus(daily.mul(pct)).toDecimalPlaces(16,D.ROUND_DOWN);
  product=product.mul(factor).toDecimalPlaces(16,D.ROUND_DOWN);
  days.push({date,kind:observed?'observed':'projected',rate_pct:rate,daily_rate:daily.toFixed(8),factor:factor.toFixed(16),source:observed?.source_uri??scenario!.source,version:observed?.version??scenario!.as_of});
 }
 if(missingCalendar.length)return incomplete('calendar_dates_missing',missingCalendar);
 if(missingRates.length)return incomplete('index_rates_missing',missingRates);
 return {status:'complete' as const,reason:null,missing_dates:[],factor:product.toFixed(8,D.ROUND_HALF_UP),days,version:'b3-di-accumulation-v1',calendar_source:c.source_uri,calendar_version:c.version,interval:'inclusive_start_exclusive_end' as const};
}
