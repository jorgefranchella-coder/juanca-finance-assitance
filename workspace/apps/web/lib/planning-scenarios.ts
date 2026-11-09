/** Deterministic illustration, rounded to BRL cents; no trades, cash flows or tax. */
export const PLANNING_METHOD = 'nominal-real-v1';
export type PlanningInput = {starting_minor:number;annual_return_pct:number;inflation_pct:number;years:number};
export function calculatePlanning(input:PlanningInput){
 const {starting_minor,annual_return_pct,inflation_pct,years}=input;
 if(!Number.isSafeInteger(starting_minor)||starting_minor<=0||starting_minor>100_000_000_000_000||!Number.isFinite(annual_return_pct)||annual_return_pct< -95||annual_return_pct>100||!Number.isFinite(inflation_pct)||inflation_pct< -95||inflation_pct>100||!Number.isInteger(years)||years<1||years>80)throw new Error('INVALID_SCENARIO_INPUT');
 const nominal_minor=Math.round(starting_minor*(1+annual_return_pct/100)**years),real_minor=Math.round(starting_minor*((1+annual_return_pct/100)/(1+inflation_pct/100))**years);
 if(!Number.isSafeInteger(nominal_minor)||!Number.isSafeInteger(real_minor))throw new Error('SCENARIO_AMOUNT_OUT_OF_RANGE');
 return {nominal_minor,real_minor};
}
