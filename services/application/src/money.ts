import { Decimal } from 'decimal.js';
export const D = Decimal.clone({precision:60,rounding:Decimal.ROUND_HALF_UP});
export function exact(value: unknown): Decimal {
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error('INVALID_DECIMAL');
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('INVALID_DECIMAL');
  if(typeof value==='number' && Math.abs(value)>Number.MAX_SAFE_INTEGER)throw new Error('UNSAFE_LEGACY_NUMBER');
  const n=new D(String(value));
  if (!n.isFinite() || n.abs().gte('1000000000000000000') || n.decimalPlaces()>10) throw new Error('DECIMAL_RANGE');
  return n;
}
export function minor(value: Decimal): string {
  const n=value.toDecimalPlaces(0,D.ROUND_HALF_UP);
  if(n.lt('-9223372036854775808')||n.gt('9223372036854775807'))throw new Error('MINOR_RANGE');
  return n.toFixed(0);
}
export function integer(value: unknown): string {
  if(typeof value==='number'&&!Number.isSafeInteger(value))throw new Error('UNSAFE_LEGACY_INTEGER');
  const n=new D(String(value));if(!n.isFinite()||!n.isInteger())throw new Error('INVALID_MINOR');return minor(n);
}
export function localized(value: unknown): Decimal | null {
  if(value===null||value===undefined||value==='-'||value==='')return null;
  const s=String(value).replace(/R\$/g,'').replace(/\s/g,'');
  return exact(s.includes(',')?s.replace(/\./g,'').replace(',','.'):s);
}
