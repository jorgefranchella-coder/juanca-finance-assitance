import {createHash} from 'node:crypto';
import {Decimal} from 'decimal.js';

export type PortfolioPosition={owner:string;instrument_code:string;currency?:string;quantity:string|number;market_value_cents:string|number|null};
type Aggregate={owner:string;instrument_code:string;currency:string;quantity:Decimal;market_value_cents:bigint};
const code=(value:string)=>value.trim().toUpperCase().replace(/^(BVMF|NASDAQ|NYSE|NYSEARCA):/,'');
const identity=(position:PortfolioPosition)=>JSON.stringify([position.owner,code(position.instrument_code),position.currency??'BRL']);

function aggregate(positions:PortfolioPosition[]){
 const result=new Map<string,Aggregate>();
 for(const position of positions){
  if(!position.owner||!position.instrument_code||position.instrument_code.toUpperCase()==='USD_CASH')continue;
  const key=identity(position),current=result.get(key)??{owner:position.owner,instrument_code:code(position.instrument_code),currency:position.currency??'BRL',quantity:new Decimal(0),market_value_cents:0n};
  current.quantity=current.quantity.plus(String(position.quantity));
  if(position.market_value_cents!==null)current.market_value_cents+=BigInt(String(position.market_value_cents));
  result.set(key,current);
 }
 return result;
}

export function comparePortfolioPositions(d1:PortfolioPosition[],postgres:PortfolioPosition[]){
 const left=aggregate(d1),right=aggregate(postgres),keys=new Set([...left.keys(),...right.keys()]);
 const differences:Array<Record<string,string>>=[];
 const counts={d1_only:0,postgres_only:0,quantity_only:0,value_only:0,quantity_and_value:0,matched:0};
 for(const key of keys){
  const a=left.get(key),b=right.get(key),item=a??b!;
  const identity_sha256=createHash('sha256').update(key).digest('hex');
  if(!a){counts.postgres_only++;differences.push({owner:item.owner,instrument_code:item.instrument_code,currency:item.currency,identity_sha256,kind:'postgres_only',d1_quantity:'',postgres_quantity:b!.quantity.toFixed(),d1_value_cents:'',postgres_value_cents:b!.market_value_cents.toString()});continue;}
  if(!b){counts.d1_only++;differences.push({owner:item.owner,instrument_code:item.instrument_code,currency:item.currency,identity_sha256,kind:'d1_only',d1_quantity:a.quantity.toFixed(),postgres_quantity:'',d1_value_cents:a.market_value_cents.toString(),postgres_value_cents:''});continue;}
  const quantityChanged=!a.quantity.eq(b.quantity),valueChanged=a.market_value_cents!==b.market_value_cents;
  if(!quantityChanged&&!valueChanged){counts.matched++;continue;}
  const kind=quantityChanged&&valueChanged?'quantity_and_value':quantityChanged?'quantity_only':'value_only';counts[kind]++;
  differences.push({owner:item.owner,instrument_code:item.instrument_code,currency:item.currency,identity_sha256,kind,d1_quantity:a.quantity.toFixed(),postgres_quantity:b.quantity.toFixed(),d1_value_cents:a.market_value_cents.toString(),postgres_value_cents:b.market_value_cents.toString()});
 }
 const totals=(map:Map<string,Aggregate>)=>[...map.values()].reduce((sum,item)=>sum+item.market_value_cents,0n);
 const totalD1=totals(left),totalPostgres=totals(right);
 differences.sort((a,b)=>a.owner.localeCompare(b.owner)||a.instrument_code.localeCompare(b.instrument_code)||a.currency.localeCompare(b.currency));
 const canonical=JSON.stringify({d1:[...left].map(([k,v])=>[k,v.quantity.toFixed(),v.market_value_cents.toString()]).sort(),postgres:[...right].map(([k,v])=>[k,v.quantity.toFixed(),v.market_value_cents.toString()]).sort()});
 return {d1_position_count:left.size,postgres_position_count:right.size,matched_position_count:counts.matched,d1_total_cents:totalD1.toString(),postgres_total_cents:totalPostgres.toString(),net_value_difference_cents:(totalPostgres-totalD1).toString(),counts,differences,content_sha256:createHash('sha256').update(canonical).digest('hex')};
}
