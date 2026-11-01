import {Decimal} from 'decimal.js';
import {accumulateB3Di,type B3DiInput} from './b3-di-accumulation.ts';
import type {ContractTerms} from './fixed-income-contract.ts';

export type B3DiMarketData=Pick<B3DiInput,'calendar'|'observations'|'observed_through'|'future_assumption'>;
const validDate=(s:string)=>/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s+'T00:00:00Z'))&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;
const incomplete=(reason:string,details:string[]=[])=>({status:'incomplete' as const,missing:[reason],missing_dates:details,version:'contract-b3-di-v1',calendar:[],gross_maturity_cents:null,net_maturity_cents:null,gross_cashflows_cents:null,net_cashflows_cents:null});

/** The first supported B3 contract is capitalized % CDI with a confirmed empty payment schedule. */
export function calculateB3DiContractProjection(input:{current_value_cents:number;quantity:number;as_of:string;maturity_date:string;terms:ContractTerms;market:B3DiMarketData|null}){
 const {terms,market}=input;
 if(terms.method!=='indexed'||terms.indexer!=='CDI'||terms.indexer_relation!=='multiplier'||terms.interest_treatment!=='capitalize')return incomplete('convención contractual CDI no soportada');
 if(!terms.schedule_confirmed||terms.payment_schedule.length)return incomplete('calendario de pagos CDI no soportado o sin confirmar');
 if(!Number.isSafeInteger(input.current_value_cents)||input.current_value_cents<=0||!Number.isFinite(input.quantity)||input.quantity<=0||!validDate(input.as_of)||!validDate(input.maturity_date)||input.maturity_date<=input.as_of||Date.parse(input.maturity_date+'T00:00:00Z')-Date.parse(input.as_of+'T00:00:00Z')>18300*86400000)return incomplete('posición, fecha de referencia o vencimiento inválido');
 if(!market)return incomplete('datos de mercado CDI y calendario no disponibles');
 if(market.future_assumption&&(!terms.indexer_assumption_pct||!/^\d{1,3}(?:\.\d{1,2})?$/.test(market.future_assumption.annual_rate_pct)||!/^\d{1,3}(?:\.\d{1,8})?$/.test(terms.indexer_assumption_pct)||!new Decimal(market.future_assumption.annual_rate_pct).eq(terms.indexer_assumption_pct)))return incomplete('el supuesto CDI no coincide con el contrato');
 const end=new Date(input.maturity_date+'T12:00:00Z'),start=new Date(input.as_of+'T12:00:00Z'),dates=new Set<string>();let year=start.getUTCFullYear(),month=start.getUTCMonth()-1;
 while(true){if(++month>11){month=0;year++;}const value=Date.UTC(year,month+1,0,12);if(value>end.valueOf())break;const date=new Date(value).toISOString().slice(0,10);if(date>input.as_of)dates.add(date);}
 dates.add(input.maturity_date);
 const calendar:Array<{date:string;balance_cents:number;cashflow_cents:number;maturity_cents:number;kind:string}>=[];let gross=0,provenance:unknown=null;
 for(const date of [...dates].sort()){
  const factor=accumulateB3Di({from:input.as_of,to:date,percentage:terms.annual_rate_pct,...market});
  if(factor.status==='incomplete')return incomplete(`CDI: ${factor.reason}`,factor.missing_dates);
  const cents=new Decimal(input.current_value_cents).mul(factor.factor).toDecimalPlaces(0,Decimal.ROUND_HALF_UP);
  if(!cents.isFinite()||cents.gt(Number.MAX_SAFE_INTEGER))return incomplete('importe fuera del rango calculable');
  const amount=cents.toNumber(),maturity=date===input.maturity_date?amount:0;if(maturity)gross=maturity;
  calendar.push({date,balance_cents:maturity?0:amount,cashflow_cents:maturity,maturity_cents:maturity,kind:maturity?'maturity':'projection'});
  provenance={calendar_source:factor.calendar_source,calendar_version:factor.calendar_version,observed_through:market.observed_through,observed_days:factor.days.filter(d=>d.kind==='observed').length,projected_days:factor.days.filter(d=>d.kind==='projected').length,index_versions:[...new Set(factor.days.filter(d=>d.kind==='observed').map(d=>d.version))],assumption:market.future_assumption};
 }
 const tax=terms.tax_rate_pct===null?null:new Decimal(terms.tax_rate_pct).div(100),net=tax===null?null:new Decimal(gross).minus(Decimal.max(0,new Decimal(gross).minus(input.current_value_cents)).mul(tax)).toDecimalPlaces(0,Decimal.ROUND_HALF_UP).toNumber();
 return {status:'complete' as const,missing:[],version:'contract-b3-di-v1',calendar,gross_maturity_cents:gross,net_maturity_cents:net,gross_cashflows_cents:0,net_cashflows_cents:tax===null?null:0,tax_status:tax===null?'not_modelled':'explicit_assumption',rate_pct:null,indexer:'CDI',indexer_relation:'multiplier',indexer_assumption_pct:market.future_assumption?.annual_rate_pct??null,interest_treatment:'capitalize',cashflow_note:'El supuesto futuro y el calendario se identifican por separado; no hay pagos intermedios.',market_provenance:provenance};
}
