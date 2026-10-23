import type pg from 'pg';
import {buildFixedIncomeProjectionItems,type FixedIncomeGroup,type CostBasisPoint} from './fixed-income-projection.ts';

type ArchivedRow={run_id:string;import:Record<string,unknown>;record:Record<string,unknown>};
const fixedClasses=new Set(['fixed_income','treasury','international_fixed_income','private_pension']);
function code(value:unknown){return String(value??'').trim().toUpperCase().replace(/^(BVMF|NASDAQ|NYSE|NYSEARCA):/,'');}
function number(value:unknown){if(typeof value==='number')return Number.isFinite(value)?value:0;if(typeof value!=='string'||!value.trim()||value.trim()==='-')return 0;const s=value.replace(/R\$/g,'').replace(/\s/g,'');const n=Number(s.includes(',')?s.replace(/\./g,'').replace(',','.'):s);return Number.isFinite(n)?n:0;}
function valuation(item:Record<string,unknown>){
 const raw=(item.raw&&typeof item.raw==='object'?item.raw:{}) as Record<string,unknown>;
 const candidates:[[unknown,unknown,string],[unknown,unknown,string],[unknown,unknown,string],[unknown,unknown,string]]=[
  [raw['Valor Atualizado MTM'],raw['Preço Atualizado MTM'],'b3_mtm'],
  [raw['Valor Atualizado FECHAMENTO'],raw['Preço Atualizado FECHAMENTO']??raw['Preço de Fechamento'],'b3_close'],
  [raw['Valor Atualizado CURVA'],raw['Preço Atualizado CURVA'],'b3_curve'],
  [raw['Valor Atualizado'],raw['Preço de Fechamento'],'b3_position']];
 for(const [value,price,source] of candidates){if(value!==null&&value!==undefined&&value!==''&&value!=='-')return {market_value_cents:Math.round(number(value)*100),unit_price:number(price)||number(item.unit_price),price_source:source};}
 return {market_value_cents:number(item.market_value_cents),unit_price:number(item.unit_price),price_source:'b3_position'};
}
function payload(row:ArchivedRow){try{return JSON.parse(String(row.record.payload??'{}')) as Record<string,unknown>;}catch{return {};}}

/** Rebuilds the D1 fixed-income projection from immutable archived import rows. */
export async function fixedIncomeProjection(db:pg.Pool,household:string){
 const archived=await db.query(`WITH pairs AS (
    SELECT DISTINCT ON (i.original::jsonb->>'id',r.original::jsonb->>'id') i.run_id,i.original::jsonb AS import,r.original::jsonb AS record
    FROM app.received_sources i JOIN app.received_sources r ON r.run_id=i.run_id AND r.household_id=i.household_id
      AND r.source_table='import_records' AND r.original::jsonb->>'import_id'=i.original::jsonb->>'id'
    JOIN app.migration_runs m ON m.id=i.run_id
    WHERE i.household_id=$1 AND i.source_table='imports'
    ORDER BY i.original::jsonb->>'id',r.original::jsonb->>'id',m.exported_at DESC,i.run_id DESC
  ) SELECT run_id,import,record FROM pairs ORDER BY (import->>'reference_date'),(import->>'created_at'),(record->>'id')`,[household]);
 const latest=new Map<string,{id:string;reference_date:string;created_at:string}>();
 for(const row of archived.rows as ArchivedRow[]){const i=row.import;if(i.status!=='processed'||!['positions','pension_statement'].includes(String(i.file_type)))continue;const key=`${i.owner}\0${i.file_type}`,candidate={id:String(i.id),reference_date:String(i.reference_date??''),created_at:String(i.created_at??'')},old=latest.get(key);if(!old||candidate.reference_date>old.reference_date||candidate.reference_date===old.reference_date&&candidate.created_at>=old.created_at)latest.set(key,candidate);}
 const groups=new Map<string,FixedIncomeGroup>();
 for(const row of archived.rows as ArchivedRow[]){const i=row.import;if(i.status!=='processed'||!['positions','pension_statement'].includes(String(i.file_type))||row.record.record_kind!=='position')continue;
  const item=payload(row),asset=String(item.asset_class??'');if(!fixedClasses.has(asset))continue;
  const owner=String(item.owner??i.owner??''),instrument=code(item.instrument_code||item.product_name),raw=(item.raw&&typeof item.raw==='object'?item.raw:{}) as Record<string,unknown>,issuer=String(item.issuer??raw.Emissor??raw.Emisor??'').trim();
  const date=String(item.reference_date??i.reference_date??''),quantity=number(item.quantity),maturityDate=String(item.maturity_date??''),value=valuation(item),derived=value.unit_price>0?value.unit_price:quantity>0?value.market_value_cents/100/quantity:0;
  if(!owner||!instrument||!/^\d{4}-\d{2}-\d{2}$/.test(date)||quantity<=0||derived<=0)continue;
  const currency=String(item.currency??'BRL'),institution=String(item.institution??'').trim(),account=item.account==null||!String(item.account).trim()?null:String(item.account).trim(),key=JSON.stringify([owner,institution,account,instrument,currency]),isCurrent=latest.get(`${i.owner}\0${i.file_type}`)?.id===String(i.id),observation={date,unitPrice:derived,source:value.price_source};
  const current=groups.get(key);
  if(!current)groups.set(key,{owner,account,instrumentCode:instrument,productName:String(item.product_name??instrument),institution,issuer,assetClass:asset,currency,quantity,maturityDate,latestDate:date,currentUnitPrice:derived,currentValueCents:value.market_value_cents,priceSource:value.price_source,observations:[observation],isCurrent});
  else{current.observations.push(observation);if(date>=current.latestDate)Object.assign(current,{quantity,maturityDate,latestDate:date,currentUnitPrice:derived,currentValueCents:value.market_value_cents,priceSource:value.price_source,productName:String(item.product_name??instrument),institution,account,isCurrent,issuer,currency});}
 }
 const movements=await db.query(`WITH pairs AS (
    SELECT DISTINCT ON (i.original::jsonb->>'id',r.original::jsonb->>'id') i.original::jsonb AS import,r.original::jsonb AS record
    FROM app.received_sources i JOIN app.received_sources r ON r.run_id=i.run_id AND r.household_id=i.household_id
      AND r.source_table='import_records' AND r.original::jsonb->>'import_id'=i.original::jsonb->>'id'
    JOIN app.migration_runs m ON m.id=i.run_id
    WHERE i.household_id=$1 AND i.source_table='imports' AND i.original::jsonb->>'file_type'='movements'
    ORDER BY i.original::jsonb->>'id',r.original::jsonb->>'id',m.exported_at DESC,i.run_id DESC
  ) SELECT import,record FROM pairs ORDER BY (import->>'created_at'),(record->>'id')`,[household]);
 const history=new Map<string,{buys:Map<string,{quantity:number;total:number}>;unsafe:boolean}>();
 for(const row of movements.rows as Array<{import:Record<string,unknown>;record:Record<string,unknown>}>){if(row.import.status!=='processed'||row.record.record_kind!=='movement')continue;const item=payload({run_id:'',import:row.import,record:row.record}),owner=String(item.owner??row.import.owner??''),institution=String(item.institution??'').trim(),instrument=code(item.instrument_code),date=String(item.occurred_on??''),type=String(item.event_type??''),quantity=number(item.quantity),unitPrice=number(item.unit_price);if(!owner||!institution||!instrument)continue;
  const key=JSON.stringify([owner,institution.toUpperCase(),instrument]),entry=history.get(key)??{buys:new Map(),unsafe:false};if(item.requires_review===true)entry.unsafe=true;else if(type==='buy'&&/^\d{4}-\d{2}-\d{2}$/.test(date)&&quantity>0&&unitPrice>0){const total=entry.buys.get(date)??{quantity:0,total:0};total.quantity+=quantity;total.total+=quantity*unitPrice;entry.buys.set(date,total);}else if(type!=='interest'&&type!=='income')entry.unsafe=true;history.set(key,entry);
 }
 for(const group of groups.values()){if(!group.isCurrent||!group.institution||movements.rowCount===10000)continue;const entry=history.get(JSON.stringify([group.owner,group.institution.toUpperCase(),code(group.instrumentCode)]));if(!entry||entry.unsafe||entry.buys.size!==1)continue;const [[date,buy]]=entry.buys;const tolerance=Math.max(.000001,Math.abs(group.quantity)*1e-8);if(Math.abs(buy.quantity-group.quantity)>tolerance||date>=group.latestDate||group.observations.some(o=>o.date===date))continue;group.observations.push({date,unitPrice:buy.total/buy.quantity,source:'b3_movement'});}
 const acquisitionRows=await db.query(`WITH latest_lots AS (
   SELECT DISTINCT ON (l.household_id,l.id) l.household_id,l.id,l.position_id,l.effective_date::text,l.quantity::text,l.unit_price::text,l.fees_minor,l.currency,l.voided
   FROM app.acquisition_lots l WHERE l.household_id=$1 ORDER BY l.household_id,l.id,l.revision DESC
 ) SELECT o.display_name AS owner,ci.canonical_name AS institution,p.instrument_code,p.currency,
     COALESCE(ir.custody_account_id,p.custody_account_id) IS NOT NULL AS custody_identity_resolved,
     (SELECT count(DISTINCT COALESCE(ir2.custody_account_id,p2.custody_account_id))::int FROM app.position_identities p2
       LEFT JOIN LATERAL (SELECT custody_account_id FROM app.position_identity_resolutions x2 WHERE x2.household_id=p2.household_id AND x2.position_id=p2.id ORDER BY revision DESC LIMIT 1) ir2 ON true
       WHERE p2.household_id=p.household_id AND p2.owner_id=p.owner_id AND p2.institution_id=p.institution_id
         AND p2.instrument_code=p.instrument_code AND p2.currency=p.currency AND COALESCE(ir2.custody_account_id,p2.custody_account_id) IS NOT NULL) AS resolved_account_count,
     ca.external_reference,sa.raw_row->>'Conta' AS account_reference,
     l.effective_date,l.quantity,l.unit_price,l.fees_minor,l.currency AS lot_currency,l.voided
   FROM latest_lots l JOIN app.position_identities p ON p.household_id=l.household_id AND p.id=l.position_id
   JOIN app.owners o ON o.household_id=p.household_id AND o.id=p.owner_id
   JOIN app.custody_institutions ci ON ci.id=p.institution_id
   LEFT JOIN LATERAL (SELECT custody_account_id FROM app.position_identity_resolutions x WHERE x.household_id=p.household_id AND x.position_id=p.id ORDER BY revision DESC LIMIT 1) ir ON true
   LEFT JOIN app.custody_accounts ca ON ca.household_id=p.household_id AND ca.id=COALESCE(ir.custody_account_id,p.custody_account_id)
   LEFT JOIN app.source_assertions sa ON sa.household_id=p.household_id AND sa.id=p.source_assertion_id
   WHERE p.household_id=$1 ORDER BY o.display_name,ci.canonical_name,p.instrument_code,l.effective_date`,[household]);
 const acquisitionPrices=new Map<string,{group:FixedIncomeGroup;quantity:number;total:number;date:string}>(),projectionKeys=new Set<string>();
 for(const lot of acquisitionRows.rows){
  if(lot.voided||!lot.custody_identity_resolved||String(lot.lot_currency)!==String(lot.currency))continue;
  const candidates=[...groups.values()].filter(group=>group.isCurrent&&group.owner===String(lot.owner)&&group.institution.trim().toUpperCase()===String(lot.institution).trim().toUpperCase()&&code(group.instrumentCode)===code(lot.instrument_code)&&group.currency===String(lot.currency)&&fixedClasses.has(group.assetClass)&&(group.account?(group.account===String(lot.account_reference??'').trim()||group.account===String(lot.external_reference??'').trim()):Number(lot.resolved_account_count)===1));
  if(candidates.length!==1)continue;
  const group=candidates[0],date=String(lot.effective_date),quantity=number(lot.quantity),unitPrice=number(lot.unit_price),fees=Number(lot.fees_minor??0)/100;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||date>=group.latestDate||quantity<=0||unitPrice<=0||!Number.isFinite(fees)||fees<0)continue;
  const key=JSON.stringify([group.owner,group.institution.trim().toUpperCase(),group.account,code(group.instrumentCode),date]);
  const aggregate=acquisitionPrices.get(key)??{group,quantity:0,total:0,date};aggregate.quantity+=quantity;aggregate.total+=quantity*unitPrice+fees;acquisitionPrices.set(key,aggregate);
  projectionKeys.add(`${group.owner}\0${code(group.instrumentCode)}`);
 }
 for(const {group,quantity,total,date} of acquisitionPrices.values())if(quantity>0)group.observations.push({date,unitPrice:total/quantity,source:'acquisition_lot'});
 const costRows=await db.query(`SELECT original::jsonb AS cost FROM app.received_sources WHERE household_id=$1 AND source_table='cost_basis' ORDER BY source_ordinal`,[household]);
 const costMap=new Map<string,CostBasisPoint>();for(const row of costRows.rows){const c=row.cost as Record<string,unknown>;const owner=String(c.owner??''),instrument=code(c.instrument_code);if(!owner||!instrument)continue;const key=`${owner}\0${instrument}`;if(projectionKeys.has(key))continue;const point={owner,instrument_code:instrument,average_unit_cost:number(c.average_unit_cost),as_of:String(c.as_of??''),source:String(c.source??'')};const old=costMap.get(key);if(!old||point.as_of>=old.as_of)costMap.set(key,point);}
 const items=buildFixedIncomeProjectionItems(groups.values(),[...costMap.values()]),covered=items.filter(item=>item.projected_value_cents!==null),total=items.reduce((sum,item)=>sum+item.current_value_cents,0),coveredCurrent=covered.reduce((sum,item)=>sum+item.current_value_cents,0),coveredProjected=covered.reduce((sum,item)=>sum+(item.projected_value_cents??0),0);
 return {reference_date:items.map(item=>item.reference_date).sort().at(-1)??'',summary:{total_current_cents:total,covered_current_cents:coveredCurrent,covered_projected_cents:coveredProjected,projected_gain_cents:coveredProjected-coveredCurrent,coverage:total?coveredCurrent/total:0,projected_count:covered.length,total_count:items.length},items,methodology:'Rentabilidad efectiva anualizada entre la primera y la última observación de precio; extrapolación compuesta hasta el vencimiento.',mode:'shadow',authoritative:false};
}
