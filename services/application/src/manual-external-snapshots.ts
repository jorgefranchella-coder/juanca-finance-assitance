import {createHash} from 'node:crypto';
import type pg from 'pg';
import {Conflict} from './commands.ts';
import {exact} from './money.ts';

const KEY=/^[A-Za-z0-9._:-]{8,128}$/;
type Obj=Record<string,unknown>;
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const text=(v:unknown,max=180)=>typeof v==='string'?v.trim().replace(/\s+/g,' ').slice(0,max):'';
function object(value:unknown):Obj{if(!value||typeof value!=='object'||Array.isArray(value))throw new Conflict('VALIDATION',422);return value as Obj;}
function date(value:unknown){if(typeof value!=='string'||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)||Number.isNaN(Date.parse(value+'T00:00:00Z'))||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)throw new Conflict('VALIDATION',422);return value;}
function amount(value:unknown){if(typeof value!=='string'&&typeof value!=='number')throw new Conflict('VALIDATION',422);const n=exact(String(value));if(!n.isFinite()||n.lt(0))throw new Conflict('VALIDATION',422);return n.toFixed();}

/** Stage a complete user-compiled non-B3 position cut as evidence only. */
export async function createManualExternalPositionSnapshot(db:pg.Pool,household:string,actor:string,body:unknown){
 const input=object(body),allowed=['request_key','owner','institution','reference_date','valuation_basis','plans','evidence_refs','update_scope','identity_unverified'];
 if(Object.keys(input).some(k=>!allowed.includes(k))||typeof input.request_key!=='string'||!KEY.test(input.request_key))throw new Conflict('VALIDATION',422);
 if(typeof input.owner!=='string'||!['Jorge','Julia'].includes(input.owner))throw new Conflict('VALIDATION',422);
 const institution=text(input.institution);if(!institution)throw new Conflict('VALIDATION',422);
 const cut=date(input.reference_date);
 const partial=input.update_scope==='plans';if(input.update_scope!==undefined&&!['plans','complete'].includes(String(input.update_scope)))throw new Conflict('VALIDATION',422);if(input.identity_unverified!==undefined&&(typeof input.identity_unverified!=='boolean'||input.identity_unverified&&!partial))throw new Conflict('VALIDATION',422);
 if(input.valuation_basis!=='gross'&&input.valuation_basis!=='net')throw new Conflict('VALIDATION',422);
 if(!Array.isArray(input.plans)||input.plans.length<1||input.plans.length>100)throw new Conflict('VALIDATION',422);
 const evidenceRefs=input.evidence_refs??[];if(!Array.isArray(evidenceRefs)||evidenceRefs.length>20||evidenceRefs.some(v=>typeof v==='string'?v.length>240:!v||typeof v!=='object'||Array.isArray(v)||JSON.stringify(v).length>1000))throw new Conflict('VALIDATION',422);
 const photoIds=evidenceRefs.filter(v=>v&&typeof v==='object'&&!Array.isArray(v)&&(v as Obj).kind==='manual_photo').map(v=>(v as Obj).upload_id);
 if(photoIds.some(id=>typeof id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))||new Set(photoIds).size!==photoIds.length)throw new Conflict('VALIDATION',422);
 const plans=input.plans.map((value,index)=>{
  const p=object(value);if(Object.keys(p).some(k=>!['plan_number','product_name','fund','fund_cnpj','gross_balance','net_balance','tax_regime','isin','anbima_code'].includes(k)))throw new Conflict('VALIDATION',422);
  const cnpj=text(p.fund_cnpj,32).replace(/\D/g,'');if(!/^\d{14}$/.test(cnpj))throw new Conflict('FUND_CNPJ_REQUIRED',422);
  const gross=amount(p.gross_balance),net=amount(p.net_balance),chosen=input.valuation_basis==='gross'?gross:net;
  if(!exact(chosen).gt(0))throw new Conflict('POSITION_MARKET_VALUE_MISSING',422);
  const planNumber=text(p.plan_number,100),product=text(p.product_name),fund=text(p.fund);
  if(!planNumber||!product||!fund||!text(p.tax_regime,80))throw new Conflict('VALIDATION',422);
  return {index,cnpj,plan_number:planNumber,product_name:product,fund,fund_cnpj:cnpj,gross_balance:gross,net_balance:net,tax_regime:text(p.tax_regime,80),isin:text(p.isin,32)||null,anbima_code:text(p.anbima_code,32)||null,currency:'BRL',market_value:chosen,unit_price:chosen,quantity:'1'};
 });
 if(new Set(plans.map(p=>p.plan_number)).size!==plans.length)throw new Conflict('DUPLICATE_PLAN_NUMBER',422);
 const funds=new Map<string,{fund:string;product:string}>();for(const p of plans){const prior=funds.get(p.fund_cnpj);if(prior&&(prior.fund!==p.fund||prior.product!==p.product_name))throw new Conflict('FUND_CNPJ_IDENTITY_CONFLICT',422);funds.set(p.fund_cnpj,{fund:p.fund,product:p.product_name});}
 const positions:Array<(typeof plans)[number]&{carry?:{document_id:string;assertion_id:string;plan_index:number;as_of:string}}>=plans.map(p=>({...p}));
 const canonical={owner:input.owner,institution,reference_date:cut,valuation_basis:input.valuation_basis,plans,evidence_refs:[...evidenceRefs],...(partial?{update_scope:'plans'}:{}),...(input.identity_unverified?{identity_unverified:true}:{})};
 const contentHash=sha(JSON.stringify(canonical)),documentId=`telegram-pension-${sha(household+'\0'+input.request_key).slice(0,40)}`;
 const c=await db.connect();
 try{
  await c.query('BEGIN');
  const member=await c.query("SELECT 1 FROM app.memberships WHERE household_id=$1 AND actor_id=$2 AND role IN ('owner','approver')",[household,actor]);if(!member.rowCount)throw new Conflict('FORBIDDEN',403);
  const owner=await c.query('SELECT id FROM app.owners WHERE household_id=$1 AND display_name=$2',[household,input.owner]);if(!owner.rowCount)throw new Conflict('UNKNOWN_OWNER',422);
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${household}:manual-external-snapshot:${input.request_key}`]);
  const prior=await c.query('SELECT id,content_sha256 FROM app.source_documents WHERE household_id=$1 AND id=$2',[household,documentId]);
  if(prior.rowCount){if(prior.rows[0].content_sha256!==contentHash)throw new Conflict('IDEMPOTENCY_MISMATCH',409);await c.query('COMMIT');return{document_id:documentId,content_sha256:contentHash,source_system:institution,reference_date:cut,plans:plans.length,status:'evidence_only',portfolio_published:false,replayed:true};}
  if(partial){
   await c.query('SELECT 1 FROM app.household_state WHERE household_id=$1 FOR UPDATE',[household]);
   const base=await c.query(`SELECT d.id,d.effective_as_of::text FROM app.external_position_snapshot_publications p JOIN app.source_documents d ON d.household_id=p.household_id AND d.id=p.document_id WHERE p.household_id=$1 AND d.owner_id=$2 AND d.source_system=$3 ORDER BY d.effective_as_of DESC,d.registered_at DESC,d.id DESC LIMIT 1`,[household,owner.rows[0].id,institution]);
   if(!base.rowCount||String(base.rows[0].effective_as_of)>cut)throw new Conflict('PENSION_CARRY_BASE_UNAVAILABLE',409);
   const assertions=await c.query("SELECT id,instrument_code,raw_row FROM app.source_assertions WHERE household_id=$1 AND document_id=$2 AND assertion_kind='position' ORDER BY source_sheet,source_row",[household,base.rows[0].id]);
   if(!assertions.rowCount)throw new Conflict('PENSION_CARRY_BASE_UNAVAILABLE',409);
   const known=new Map<string,string>();
   for(const a of assertions.rows){const raw=a.raw_row as Obj,oldPlans=raw.plans;if(!Array.isArray(oldPlans)||!oldPlans.length||raw.valuation_basis!==input.valuation_basis)throw new Conflict('PENSION_CARRY_BASE_UNRESOLVED',409);const decisions=await c.query('SELECT plan_number,fund_name,fund_cnpj FROM app.pension_identity_decisions WHERE household_id=$1 AND assertion_id=$2',[household,a.id]);if((raw.identity_status==='needs_review'&&!decisions.rowCount)||decisions.rows.some(d=>d.plan_number!==raw.plan_number||d.fund_name!==raw.fund||d.fund_cnpj!==raw.fund_cnpj))throw new Conflict('PENSION_CARRY_BASE_UNRESOLVED',409);let total=exact('0');
    for(const [idx,value] of oldPlans.entries()){const p=object(value),number=text(p.plan_number,100),fund=text(p.fund),cnpj=text(p.fund_cnpj,32).replace(/\D/g,''),product=text(p.product_name),regime=text(p.tax_regime,80),gross=amount(p.gross_balance),net=amount(p.net_balance),chosen=input.valuation_basis==='gross'?gross:net;
     if(!number||!fund||!product||!regime||!/^\d{14}$/.test(cnpj)||a.instrument_code!==`PREV-${cnpj}`||!exact(chosen).gt(0)||known.has(number))throw new Conflict('PENSION_CARRY_BASE_UNRESOLVED',409);
     known.set(number,cnpj);total=total.add(chosen);
     if(!plans.some(plan=>plan.plan_number===number)){const asOf=date(raw.position_reference_date??base.rows[0].effective_as_of);if(asOf>cut)throw new Conflict('PENSION_CARRY_BASE_UNRESOLVED',409);positions.push({index:positions.length,cnpj,plan_number:number,product_name:product,fund,fund_cnpj:cnpj,gross_balance:gross,net_balance:net,tax_regime:regime,isin:text(p.isin,32)||null,anbima_code:text(p.anbima_code,32)||null,currency:'BRL',market_value:chosen,unit_price:chosen,quantity:'1',carry:{document_id:String(base.rows[0].id),assertion_id:String(a.id),plan_index:idx,as_of:asOf}});}
    }
    if(!total.eq(exact(String(raw.market_value??'0'))))throw new Conflict('PENSION_CARRY_BASE_UNRESOLVED',409);
   }
   if(plans.some(p=>known.get(p.plan_number)!==p.fund_cnpj))throw new Conflict('PENSION_PLAN_IDENTITY_CHANGED',409);
  }
  if(photoIds.length){const photos=await c.query('SELECT upload_id,owner_id,status FROM app.manual_photo_evidence WHERE household_id=$1 AND upload_id=ANY($2::uuid[]) FOR UPDATE',[household,photoIds]);if(photos.rowCount!==photoIds.length||photos.rows.some(p=>p.owner_id!==owner.rows[0].id||p.status!=='awaiting_review'))throw new Conflict('PHOTO_EVIDENCE_UNAVAILABLE',409);}
  const sourceLabel=photoIds.length?'Foto':'Telegram';
  await c.query(`INSERT INTO app.source_documents(household_id,id,owner_id,source_system,report_kind,original_name,content_sha256,storage_key,effective_as_of,date_basis,status)
    VALUES($1,$2,$3,$4,'position',$5,$6,$7,$8,'user_reported','evidence_only')`,[household,documentId,owner.rows[0].id,institution,`${sourceLabel} - snapshot previdencia ${cut}`,contentHash,`manual:telegram:${documentId}`,cut]);
  for(const [index,p] of positions.entries()){
   const {index:_planIndex,carry,...plan}=p;
   const needsIdentity=Boolean(input.identity_unverified&&!carry),locator=carry?`publicado:${carry.assertion_id}:plan:${carry.plan_index+1}`:`${sourceLabel}:usuario:plan:${index+1}`;const raw={institution,instrument_code:`PREV-${p.fund_cnpj}`,plan_number:p.plan_number,plans:[plan],product_name:p.product_name,fund:p.fund,fund_cnpj:p.fund_cnpj,gross_balance:p.gross_balance,net_balance:p.net_balance,tax_regime:p.tax_regime,isin:p.isin,anbima_code:p.anbima_code,valuation_basis:input.valuation_basis,currency:'BRL',market_value:p.market_value,unit_price:p.unit_price,identity_status:needsIdentity?'needs_review':'observed',identity_review_reasons:needsIdentity?['pension_fund_identity_requires_confirmation']:[],identity_evidence_kind:carry?'prior_published':needsIdentity?'prior_unconfirmed':'user_reported',identity_evidence:{plan:[{value:p.plan_number,locator}],fund:[{value:p.fund,locator}],fund_cnpj:[{value:p.fund_cnpj,locator}]},evidence_refs:carry?[{kind:'published_assertion',assertion_id:carry.assertion_id}]:evidenceRefs,...(carry?{carry_from:carry,position_reference_date:carry.as_of}:{})};
   await c.query(`INSERT INTO app.source_assertions(household_id,id,document_id,owner_id,source_sheet,source_row,assertion_kind,instrument_code,asserted_on,quantity,raw_row,interpretation_status)
     VALUES($1,$2,$3,$4,$5,$6,'position',$7,$8,'1',$9,$10)`,[household,`${documentId}:plan:${index+1}`,documentId,owner.rows[0].id,sourceLabel,index+2,`PREV-${p.fund_cnpj}`,carry?.as_of??cut,JSON.stringify(raw),needsIdentity?'needs_review':'observed']);
  }
  if(photoIds.length)await c.query("UPDATE app.manual_photo_evidence SET status='linked' WHERE household_id=$1 AND upload_id=ANY($2::uuid[])",[household,photoIds]);
  await c.query("INSERT INTO app.audit_log(household_id,actor_id,action,resource_id,details) VALUES($1,$2,'manual_external_snapshot_staged',$3,$4)",[household,actor,documentId,{source_system:institution,reference_date:cut,plans:plans.length,positions:positions.length,valuation_basis:input.valuation_basis,content_sha256:contentHash,evidence_refs:evidenceRefs,portfolio_changed:false}]);
  await c.query('COMMIT');
  return{document_id:documentId,content_sha256:contentHash,source_system:institution,reference_date:cut,plans:plans.length,positions:positions.length,status:'evidence_only',portfolio_published:false,replayed:false,mode:'shadow',authoritative:false};
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
