import {Decimal} from 'decimal.js';

/** Explicit, source-versioned calendar: one record for every civil date in its coverage. */
export type BusinessCalendar = {
  source_uri:string; version:string; coverage_start:string; coverage_end:string; sources?:Array<{source_uri:string;source_revision:string;version:string;coverage_kind?:'confirmed'|'estimated'}>;
  days:Array<{date:string;business_day:boolean;coverage_kind?:'confirmed'|'estimated'}>;
};
export type DailyIndexObservation = {date:string;rate_pct:string;unit:'annual_effective_252'|'daily_percent';source_uri:string;version:string};
export type Business252Input = {
  from:string; to:string; observed_through:string; calendar:BusinessCalendar;
  observations:DailyIndexObservation[];
  future_assumption:{annual_rate_pct:string;source:string;as_of:string}|null;
  relation:'multiplier'|'compound'|'additive'; contract_rate_pct:string;
};
const iso=(s:string)=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(s))return false;const d=new Date(s+'T00:00:00Z');return Number.isFinite(d.valueOf())&&d.toISOString().slice(0,10)===s;};
const next=(s:string)=>new Date(Date.parse(s+'T00:00:00Z')+86400000).toISOString().slice(0,10);
const validDecimal=(s:unknown)=>typeof s==='string'&&/^-?\d{1,6}(?:\.\d{1,10})?$/.test(s);
const incomplete=(reason:string,missing_dates:string[]=[])=>({status:'incomplete' as const,reason,missing_dates,factor:null,days:[],version:'business-252-v1'});

/** Accumulate (from, to], never replacing a missing historical observation with a future assumption. */
export function accumulateBusiness252(input:Business252Input){
 const {calendar}=input;
 if(!iso(input.from)||!iso(input.to)||!iso(input.observed_through)||input.from>input.to||input.to>'9998-12-31'||Date.parse(input.to+'T00:00:00Z')-Date.parse(input.from+'T00:00:00Z')>18300*86400000||!calendar||!iso(calendar.coverage_start)||!iso(calendar.coverage_end)||!calendar.source_uri?.trim()||!calendar.version?.trim()||!Array.isArray(calendar.days)||calendar.days.length>20000||!Array.isArray(input.observations)||input.observations.length>20000)return incomplete('invalid_interval_or_calendar');
 if(calendar.coverage_start>next(input.from)||calendar.coverage_end<input.to)return incomplete('calendar_coverage_missing');
 if(!['multiplier','compound','additive'].includes(input.relation)||!validDecimal(input.contract_rate_pct))return incomplete('invalid_contract_rate');
 const contract=new Decimal(input.contract_rate_pct);
 if((input.relation==='multiplier'&&contract.lt(0))||(input.relation!=='multiplier'&&contract.lte(-100)))return incomplete('invalid_contract_rate');
 const dayMap=new Map<string,boolean>();
 for(const day of calendar.days){if(!iso(day.date)||typeof day.business_day!=='boolean'||dayMap.has(day.date))return incomplete('invalid_calendar');dayMap.set(day.date,day.business_day);}
 const indexMap=new Map<string,DailyIndexObservation>();
 for(const row of input.observations){if(!iso(row.date)||!validDecimal(row.rate_pct)||!['annual_effective_252','daily_percent'].includes(row.unit)||!row.source_uri?.trim()||!row.version?.trim()||indexMap.has(row.date))return incomplete('invalid_index_observation');indexMap.set(row.date,row);}
 let factor=new Decimal(1);const days:Array<{date:string;kind:'observed'|'projected';index_rate_pct:string;unit:string;factor:string;source:string;version:string}>=[];const missingCalendar:string[]=[],missingRates:string[]=[];
 for(let day=next(input.from);day<=input.to;day=next(day)){
  if(!dayMap.has(day)){missingCalendar.push(day);continue;}
  if(!dayMap.get(day))continue;
  const row=day<=input.observed_through?indexMap.get(day):undefined;
  if(day<=input.observed_through&&!row){missingRates.push(day);continue;}
  const assumption=input.future_assumption;
  if(day>input.observed_through&&(!assumption||!validDecimal(assumption.annual_rate_pct)||!assumption.source?.trim()||!iso(assumption.as_of)||assumption.as_of>input.observed_through)){missingRates.push(day);continue;}
  const raw=new Decimal(row?row.rate_pct:assumption!.annual_rate_pct),unit=row?row.unit:'annual_effective_252';
  if(raw.lte(-100))return incomplete('invalid_index_rate',[day]);
  const daily=unit==='daily_percent'?raw.div(100):new Decimal(1).plus(raw.div(100)).pow(new Decimal(1).div(252)).minus(1);
  let dayFactor:Decimal;
  if(input.relation==='multiplier')dayFactor=new Decimal(1).plus(daily.mul(contract).div(100));
  else if(input.relation==='compound')dayFactor=new Decimal(1).plus(daily).mul(new Decimal(1).plus(contract.div(100)).pow(new Decimal(1).div(252)));
  else {const annual=unit==='annual_effective_252'?raw:new Decimal(1).plus(daily).pow(252).minus(1).mul(100);const sum=annual.plus(contract);if(sum.lte(-100))return incomplete('invalid_combined_rate',[day]);dayFactor=new Decimal(1).plus(sum.div(100)).pow(new Decimal(1).div(252));}
  if(!dayFactor.isFinite()||dayFactor.lte(0))return incomplete('invalid_daily_factor',[day]);
  factor=factor.mul(dayFactor);
  days.push({date:day,kind:row?'observed':'projected',index_rate_pct:raw.toFixed(),unit,factor:dayFactor.toFixed(),source:row?row.source_uri:assumption!.source,version:row?row.version:assumption!.as_of});
 }
 if(missingCalendar.length)return incomplete('calendar_dates_missing',missingCalendar);
 if(missingRates.length)return incomplete('index_rates_missing',missingRates);
 return {status:'complete' as const,reason:null,missing_dates:[],factor:factor.toFixed(),days,version:'business-252-v1',calendar_source:calendar.source_uri,calendar_version:calendar.version};
}
