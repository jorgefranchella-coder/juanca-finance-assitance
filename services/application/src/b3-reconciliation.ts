import {D,exact} from './money.ts';

export type PositionEvidence={assertion_id:string;sheet:string;product:string;institution_id:string|null;account_id:string|null;instrument_code:string|null;quantity:string|null};
export type MovementEvidence={assertion_id:string;institution_id:string|null;account_id:string|null;instrument_code:string|null;asserted_on:string|null;source_event_type:string|null;tentative_event_type?:string|null;direction:string|null;quantity:string|null};
type Group={key:string;instrument_code:string|null;institution_id:string|null;account_id:string|null;quantity:ReturnType<typeof exact>;assertion_ids:string[]};
function norm(value:string|null){return String(value??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/\s+/g,' ').trim();}
function group(rows:PositionEvidence[]){const groups=new Map<string,Group>();for(const row of rows){const scope=row.account_id?'account:'+row.account_id:'institution:'+norm(row.institution_id);const key=[scope,norm(row.sheet),norm(row.product),norm(row.instrument_code)].join('|');const item=groups.get(key)??{key,instrument_code:row.instrument_code,institution_id:row.institution_id,account_id:row.account_id,quantity:new D(0),assertion_ids:[]};if(row.quantity===null)throw new Error('POSITION_QUANTITY_MISSING');item.quantity=item.quantity.add(exact(row.quantity));item.assertion_ids.push(row.assertion_id);groups.set(key,item);}return groups;}
export function compareB3Snapshots(priorDate:string,currentDate:string,prior:PositionEvidence[],current:PositionEvidence[],movements:MovementEvidence[],coverage:{start:string|null;end:string|null}){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(priorDate)||!/^\d{4}-\d{2}-\d{2}$/.test(currentDate)||priorDate>=currentDate)throw new Error('INVALID_SNAPSHOT_INTERVAL');
 const before=group(prior),after=group(current),keys=new Set([...before.keys(),...after.keys()]);
 const differences=[] as Array<{kind:'added'|'removed'|'quantity_changed';key:string;instrument_code:string|null;institution_id:string|null;account_id:string|null;prior_quantity:string;current_quantity:string;delta:string;prior_assertion_ids:string[];current_assertion_ids:string[];candidate_movements:string[];review_reasons:string[]}>;
 for(const key of [...keys].sort()){
  const old=before.get(key),now=after.get(key),oldQty=old?.quantity??new D(0),newQty=now?.quantity??new D(0);if(old&&now&&oldQty.eq(newQty))continue;
  const chosen=now??old!;const candidates=movements.filter(m=>m.asserted_on!==null&&m.asserted_on>priorDate&&m.asserted_on<=currentDate&&chosen.instrument_code!==null&&m.instrument_code===chosen.instrument_code&&(chosen.account_id?m.account_id===chosen.account_id:m.institution_id===chosen.institution_id));
  const reasons:string[]=[];if(!chosen.account_id)reasons.push('custody_account_pending');if(!chosen.instrument_code)reasons.push('instrument_pending');if(!candidates.length)reasons.push('no_post_snapshot_movement');if(candidates.some(m=>!m.account_id||!m.instrument_code))reasons.push('movement_identity_pending');
  // Only ordinary applications and redemptions have a safe, signed unit delta here.
  // Corporate actions, settlement, trades and custody transfers remain evidence for review.
  const unitMovements=candidates.filter(m=>['acquisition_observation','redemption_observation'].includes(m.tentative_event_type??''));
  const unsupported=candidates.filter(m=>!['acquisition_observation','redemption_observation','income_observation'].includes(m.tentative_event_type??''));
  const signed=unitMovements.map(m=>{
   if(m.quantity===null)return null;const direction=norm(m.direction);
   if(m.tentative_event_type==='acquisition_observation'&&direction==='CREDITO')return exact(m.quantity);
   if(m.tentative_event_type==='redemption_observation'&&direction==='DEBITO')return exact(m.quantity).neg();
   return null;
  });
  const rollforwardKnown=unitMovements.length>0&&signed.every(x=>x!==null)&&unsupported.length===0;
  const net=rollforwardKnown?signed.reduce((sum,value)=>sum.add(value!),new D(0)):null;
  const delta=newQty.sub(oldQty);
  if(unitMovements.length&&!rollforwardKnown)reasons.push('movement_quantity_semantics_incomplete');
  if(rollforwardKnown&&!net!.eq(delta))reasons.push('movement_quantity_delta_mismatch');
  differences.push({kind:old&&!now?'removed':!old&&now?'added':'quantity_changed',key,instrument_code:chosen.instrument_code,institution_id:chosen.institution_id,account_id:chosen.account_id,prior_quantity:oldQty.toFixed(),current_quantity:newQty.toFixed(),delta:delta.toFixed(),prior_assertion_ids:old?.assertion_ids??[],current_assertion_ids:now?.assertion_ids??[],candidate_movements:candidates.map(m=>m.assertion_id),candidate_movement_details:candidates.map(m=>({assertion_id:m.assertion_id,date:m.asserted_on,source_event_type:m.source_event_type,tentative_event_type:m.tentative_event_type??null,direction:m.direction,quantity:m.quantity})),unit_rollforward:{status:rollforwardKnown?(net!.eq(delta)?'matches':'mismatch'):unitMovements.length?'inconclusive':'not_available',net_quantity:net?.toFixed()??null,expected_delta:delta.toFixed()},review_reasons:reasons});
 }
 return{status:'candidate_only' as const,prior_snapshot_date:priorDate,new_snapshot_date:currentDate,prior_positions:prior.length,new_positions:current.length,movement_coverage:coverage,movement_interval_complete:coverage.start!==null&&coverage.end!==null&&coverage.start<=priorDate&&coverage.end>=currentDate,differences,portfolio_published:false};
}
