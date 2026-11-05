import {exact} from './money.ts';
/** The source total is rounded to cents; allow at most one cent for rounding. */
export function pensionValuationCheck(raw:Record<string,unknown>,quantity:unknown){
 try{
  if(raw.quote_date!=null){const day=String(raw.quote_date),parsed=new Date(day+'T00:00:00Z');if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||Number.isNaN(parsed.valueOf())||parsed.toISOString().slice(0,10)!==day)return {status:'invalid_date' as const};}
  const q=exact(String(quantity)),price=exact(String(raw.unit_price??'')),value=exact(String(raw.market_value??''));
  if(!q.gt(0)||!price.gt(0)||!value.gt(0))return {status:'invalid' as const};
  const basis=raw.valuation_basis;if(basis==='gross'||basis==='net'){const selected=raw[basis==='gross'?'gross_balance':'net_balance'];if(selected==null||!exact(String(selected)).eq(value))return {status:'basis_mismatch' as const};}
  const calculated=q.mul(price),difference=value.sub(calculated);
  if(basis==='net'&&raw.gross_balance!=null&&difference.abs().gt('0.01')&&calculated.sub(exact(String(raw.gross_balance))).abs().lte('0.01'))return {status:'not_comparable' as const,declared:value.toFixed(),calculated:calculated.toFixed(),difference:difference.toFixed(),tolerance:'0.01',method:'quantity_times_unit_price_v1',reference_date:raw.reference_date??raw.position_reference_date??null,quote_date:raw.quote_date??null,valuation_basis:basis};
  return {status:(difference.abs().lte('0.01')?'consistent':'mismatch') as 'consistent'|'mismatch',declared:value.toFixed(),calculated:calculated.toFixed(),difference:difference.toFixed(),tolerance:'0.01',method:'quantity_times_unit_price_v1',reference_date:raw.reference_date??raw.position_reference_date??null,quote_date:raw.quote_date??null,valuation_basis:raw.valuation_basis??'unspecified'};
 }catch{return {status:'invalid' as const};}
}
