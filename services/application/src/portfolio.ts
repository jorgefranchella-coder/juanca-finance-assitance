import { D, exact, integer, localized, minor } from './money.ts';
export type Row=Record<string,unknown>;
export type SourceRow={id:string;import_id:string;file_type:string;owner:string;reference_date:string|null;created_at:string;payload:string};
export type Inputs={snapshots:SourceRow[];trades:SourceRow[];quotes:Row[];fx:Row|null;facts_revision:string};
export type PositionAccountResolution={custody_account_id:string;institution_id:string;assertion_id:string|null};
export type Position={owner:string;account_id:string;identity_status:string;instrument_code:string;currency:string;quantity:string;current_unit_price:string;market_value_minor:string;market_value_cents:string|null;asset_class:string;product_name:string;institution:string;base_reference_date:string;reference_date:string;price_as_of:string;source:string};
export type Issue={code:string;record_id?:string;owner?:string;instrument_code?:string};
export function codeOf(value:unknown){return String(value??'').trim().toUpperCase().replace(/^(BVMF|NASDAQ|NYSE|NYSEARCA):/,'');}
function documentValue(item:Row){
 const raw=(item.raw??{}) as Row;
 for(const [field,price,source] of [['Valor Atualizado MTM','Preço Atualizado MTM','b3_mtm'],['Valor Atualizado FECHAMENTO','Preço Atualizado FECHAMENTO','b3_close'],['Valor Atualizado CURVA','Preço Atualizado CURVA','b3_curve'],['Valor Atualizado','Preço de Fechamento','b3_position']]){
  const value=localized(raw[field]);if(value!==null)return {value:minor(value.mul(100)),price:localized(raw[price])??exact(item.unit_price??'0'),source};
 }
 return {value:integer(item.market_value_cents??item.market_value_minor??'0'),price:exact(item.unit_price??'0'),source:String(item.source??'document')};
}
export function accountScope(owner:string,type:string,item:Row){return JSON.stringify([owner,item.account?'account:'+String(item.account):'unresolved:'+type+':'+String(item.institution??'unknown')]);}
export function buildPortfolio(input:Inputs,resolutions:Map<string,string>=new Map(),accountAliases:Map<string,string>=new Map(),tradeAttributions:Map<string,{owner:string;source_scope:string}>=new Map(),positionAccountResolutions:Map<string,PositionAccountResolution>=new Map()){
 const positions:Position[]=[];const issues:Issue[]=[];const bases=new Map<string,string>();const legacyBases=new Map<string,string>();
 const quotes=new Map(input.quotes.map(q=>[String(q.market)+'\0'+codeOf(q.symbol),q]));
 const fx=input.fx?exact(input.fx.rate):null;
 for(const row of input.snapshots){try{
  const item=JSON.parse(row.payload) as Row;const owner=String(item.owner??row.owner);const currency=String(item.currency??(row.file_type==='avenue_statement'?'USD':'BRL'));
  const date=String(item.reference_date??row.reference_date??'');const code=codeOf(item.instrument_code||item.product_name);const quantity=exact(item.quantity);
  if(!code||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!['BRL','USD'].includes(currency))throw new Error('INVALID_POSITION');
  const val=documentValue(item);const quote=quotes.get((currency==='USD'?'US':'B3')+'\0'+code);const price=quote?exact(quote.price):val.price;
  const value=quote?minor(price.mul(quantity).mul(100)):currency==='USD'?integer(item.market_value_minor??'0'):val.value;
  const brl=currency==='USD'?fx?minor((quote?price.mul(quantity).mul(100):new D(value)).mul(fx)):null:value;
  const positionResolution=positionAccountResolutions.get(`${row.import_id}:${row.id}`);
  const positionScope=positionResolution?JSON.stringify([owner,'custody:'+positionResolution.custody_account_id]):accountScope(owner,row.file_type,item);
  positions.push({owner,account_id:positionScope,identity_status:item.account||positionResolution?'known':'unresolved',instrument_code:code,currency,quantity:quantity.toFixed(),current_unit_price:price.toFixed(),market_value_minor:value,market_value_cents:brl,asset_class:String(item.asset_class??'other'),product_name:String(item.product_name??code),institution:String(item.institution??''),base_reference_date:date,reference_date:date,price_as_of:String(quote?.quoted_at??date),source:String(quote?.provider??(row.file_type==='avenue_statement'?'avenue_statement':val.source))});
  if(row.file_type!=='pension_statement'){bases.set(owner+'\0'+currency+'\0'+positionScope,date);legacyBases.set(owner+'\0'+currency,date);}
 }catch{issues.push({code:'invalid_source_row',record_id:row.id});}}
 for(const row of input.trades){try{
  const t=JSON.parse(row.payload) as Row;const attribution=tradeAttributions.get(row.id);const owner=attribution?.owner??String(t.owner??row.owner);const currency=String(t.currency??'BRL');const code=codeOf(t.instrument_code);const date=String(t.trade_date??'');const quantity=exact(t.quantity);const price=exact(t.unit_price);const side=String(t.side);
  if(!code||!date||quantity.lte(0)||price.lte(0)||!['buy','sell'].includes(side))throw new Error('INVALID_TRADE');
  const scope=resolutions.get(row.id)??attribution?.source_scope??(t.account?accountAliases.get(owner+'\0'+String(t.account))??accountScope(owner,row.file_type,t):null);
  const base=scope?bases.get(owner+'\0'+currency+'\0'+scope):legacyBases.get(owner+'\0'+currency);if(base&&date<base)continue;
  if(base&&date===base){issues.push({code:'same_day_trade',owner,instrument_code:code,record_id:row.id});continue;}
  if(!base&&(currency==='USD'||scope)){issues.push({code:'missing_base',owner,instrument_code:code,record_id:row.id});continue;}
  const candidates=positions.filter(p=>p.owner===owner&&p.currency===currency&&p.instrument_code===code&&(!scope||p.account_id===scope));
  if(candidates.length>1){issues.push({code:'ambiguous_account',owner,instrument_code:code,record_id:row.id});continue;}
  let p=candidates[0];
  // A ticker does not prove account identity. Historical evidence remains unapplied.
  if(!scope||p&&p.account_id!==scope){issues.push({code:'unresolved_trade_account',owner,instrument_code:code,record_id:row.id});continue;}
  if(!p&&side==='sell'){issues.push({code:'unknown_position',owner,instrument_code:code,record_id:row.id});continue;}
  if(!p){p={owner,account_id:scope,identity_status:'known',instrument_code:code,currency,quantity:'0',current_unit_price:price.toFixed(),market_value_minor:'0',market_value_cents:'0',asset_class:String(t.asset_class??(currency==='USD'?'international_equity':'equity')),product_name:String(t.product_name??code),institution:String(t.institution??'Informado no chat'),base_reference_date:base??'',reference_date:date,price_as_of:date,source:'transaction_chat'};positions.push(p);}
  const qty=exact(p.quantity).add(side==='sell'?quantity.neg():quantity);p.quantity=exact(qty.toFixed()).toFixed();p.reference_date=date;
  const quote=quotes.get((currency==='USD'?'US':'B3')+'\0'+code);const current=quote?exact(quote.price):price;p.current_unit_price=current.toFixed();p.price_as_of=String(quote?.quoted_at??date);p.source=String(quote?.provider??t.source??'transaction_chat');
  p.market_value_minor=minor(qty.mul(current).mul(100));p.market_value_cents=currency==='USD'?fx?minor((quote?qty.mul(current).mul(100):new D(p.market_value_minor)).mul(fx)):null:p.market_value_minor;
  if(qty.lt(0)){p.market_value_cents=null;issues.push({code:'negative_position',owner,instrument_code:code,record_id:row.id});}
 }catch{issues.push({code:'invalid_trade',record_id:row.id});}}
 const visible=positions.filter(p=>p.instrument_code!=='USD_CASH'&&(p.currency!=='USD'||!new D(p.quantity).isZero()));
 for(const p of visible)if(p.market_value_cents===null&&!issues.some(i=>i.code==='negative_position'&&i.owner===p.owner&&i.instrument_code===p.instrument_code))issues.push({code:'missing_fx',owner:p.owner,instrument_code:p.instrument_code});
 return {positions:visible,total_value_cents:minor(visible.reduce((sum,p)=>sum.add(p.market_value_cents??'0'),new D(0))),valuation_complete:issues.length===0,identity_complete:visible.every(p=>p.identity_status==='known'),issues,unvalued_count:visible.filter(p=>p.market_value_cents===null).length,count:visible.length,reference_date:visible.map(p=>p.reference_date).sort().at(-1)??'',ptax:input.fx?{rate:fx!.toFixed(),date:String(input.fx.quoted_at),provider:String(input.fx.provider)}:null};
}
export function selectInputs(tables:Record<string,Row[]>,household:string,effectiveAsOf:string,knownAt:string):Inputs{
 const imports=tables.imports.filter(i=>i.user_id===household&&i.status==='processed'&&String(i.reference_date??'')<=effectiveAsOf&&new Date(String(i.created_at)+'Z').toISOString()<=knownAt);
 const latest=new Map<string,Row>();
 for(const i of imports){const key=String(i.owner)+'\0'+String(i.file_type);const old=latest.get(key);if(!old||String(i.reference_date??'')>String(old.reference_date??'')||i.reference_date===old.reference_date&&String(i.created_at)>=String(old.created_at))latest.set(key,i);}
 const byId=new Map(imports.map(i=>[String(i.id),i]));const snapshots:SourceRow[]=[];const trades:SourceRow[]=[];
 for(const r of tables.import_records){const i=byId.get(String(r.import_id));if(!i)continue;const row={id:String(r.id),import_id:String(i.id),file_type:String(i.file_type),owner:String(i.owner),reference_date:i.reference_date as string|null,created_at:String(i.created_at),payload:String(r.payload)};
  if(r.record_kind==='position'&&['positions','avenue_statement','pension_statement'].includes(row.file_type)&&latest.get(row.owner+'\0'+row.file_type)===i)snapshots.push(row);
  if(r.record_kind==='trade'&&['chat_transaction','avenue_confirmation'].includes(row.file_type)){const p=JSON.parse(row.payload) as Row;if(String(p.trade_date??'')<=effectiveAsOf)trades.push(row);}
 }
 snapshots.sort((a,b)=>a.owner.localeCompare(b.owner)||a.file_type.localeCompare(b.file_type)||Number(a.id)-Number(b.id));
 trades.sort((a,b)=>String((JSON.parse(a.payload) as Row).trade_date).localeCompare(String((JSON.parse(b.payload) as Row).trade_date))||a.created_at.localeCompare(b.created_at)||Number(a.id)-Number(b.id));
 const quotes=tables.market_quotes.filter(q=>q.user_id===household&&String(q.quoted_at).slice(0,10)<=effectiveAsOf&&new Date(String(q.updated_at)+'Z').toISOString()<=knownAt);
 const fx=tables.fx_observations.filter(q=>q.user_id===household&&String(q.quoted_at).slice(0,10)<=effectiveAsOf&&new Date(String(q.recorded_at)+'Z').toISOString()<=knownAt).sort((a,b)=>String(b.quoted_at).localeCompare(String(a.quoted_at))||Number(b.id)-Number(a.id))[0]??null;
 return {snapshots,trades,quotes,fx,facts_revision:String(tables.portfolio_revisions.find(r=>r.user_id===household)?.revision??'0')};
}
