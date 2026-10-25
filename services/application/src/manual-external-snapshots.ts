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
 const input=object(body),allowed=['request_key','owner','institution','reference_date','valuation_basis','plans','evidence_refs'];
 if(Object.keys(input).some(k=>!allowed.includes(k))||typeof input.request_key!=='string'||!KEY.test(input.request_key))throw new Conflict('VALIDATION',422);
 if(typeof input.owner!=='string'||!['Jorge','Julia'].includes(input.owner))throw new Conflict('VALIDATION',422);
 const institution=text(input.institution);if(!institution)throw new Conflict('VALIDATION',422);
 const cut=date(input.reference_date);
 if(input.valuation_basis!=='gross'&&input.valuation_basis!=='net')throw new Conflict('VALIDATION',422);
 if(!Array.isArray(input.plans)||input.plans.length<1||input.plans.length>100)throw new Conflict('VALIDATION',422);
 const evidenceRefs=input.evidence_refs??[];if(!Array.isArray(evidenceRefs)||evidenceRefs.length>20||evidenceRefs.some(v=>typeof v==='string'?v.length>240:!v||typeof v!=='object'||Array.isArray(v)||JSON.stringify(v).length>1000))throw new Conflict('VALIDATION',422);
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
 const grouped=new Map<string,typeof plans[number] & {plans:typeof plans}>();
 for(const p of plans){const existing=grouped.get(p.fund_cnpj);if(!existing){grouped.set(p.fund_cnpj,{...p,plans:[p]});continue;}if(existing.fund!==p.fund||existing.product_name!==p.product_name)throw new Conflict('FUND_CNPJ_IDENTITY_CONFLICT',422);existing.plans.push(p);existing.gross_balance=exact(existing.gross_balance).plus(p.gross_balance).toFixed();existing.net_balance=exact(existing.net_balance).plus(p.net_balance).toFixed();existing.market_value=exact(existing.market_value).plus(p.market_value).toFixed();existing.unit_price=existing.market_value;}
 const positions=[...grouped.values()];
 const canonical={owner:input.owner,institution,reference_date:cut,valuation_basis:input.valuation_basis,plans,evidence_refs:[...evidenceRefs]};
 const contentHash=sha(JSON.stringify(canonical)),documentId=`telegram-pension-${sha(household+'\0'+input.request_key).slice(0,40)}`;
 const c=await db.connect();
 try{
  await c.query('BEGIN');
  const member=await c.query("SELECT 1 FROM app.memberships WHERE household_id=$1 AND actor_id=$2 AND role IN ('owner','approver')",[household,actor]);if(!member.rowCount)throw new Conflict('FORBIDDEN',403);
  const owner=await c.query('SELECT id FROM app.owners WHERE household_id=$1 AND display_name=$2',[household,input.owner]);if(!owner.rowCount)throw new Conflict('UNKNOWN_OWNER',422);
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${household}:manual-external-snapshot:${input.request_key}`]);
  const prior=await c.query('SELECT id,content_sha256 FROM app.source_documents WHERE household_id=$1 AND id=$2',[household,documentId]);
  if(prior.rowCount){if(prior.rows[0].content_sha256!==contentHash)throw new Conflict('IDEMPOTENCY_MISMATCH',409);await c.query('COMMIT');return{document_id:documentId,content_sha256:contentHash,source_system:institution,reference_date:cut,plans:plans.length,status:'evidence_only',portfolio_published:false,replayed:true};}
  await c.query(`INSERT INTO app.source_documents(household_id,id,owner_id,source_system,report_kind,original_name,content_sha256,storage_key,effective_as_of,date_basis,status)
    VALUES($1,$2,$3,$4,'position',$5,$6,$7,$8,'user_reported','evidence_only')`,[household,documentId,owner.rows[0].id,institution,`Telegram - snapshot previdencia ${cut}`,contentHash,`manual:telegram:${documentId}`,cut]);
  for(const [index,p] of positions.entries()){
   const raw={institution,plan_number:p.plan_number,plans:p.plans.map(({index:_i,...plan})=>plan),product_name:p.product_name,fund:p.fund,fund_cnpj:p.fund_cnpj,gross_balance:p.gross_balance,net_balance:p.net_balance,tax_regime:p.plans.every(plan=>plan.tax_regime===p.tax_regime)?p.tax_regime:'mixed',isin:p.isin,anbima_code:p.anbima_code,valuation_basis:input.valuation_basis,currency:'BRL',market_value:p.market_value,unit_price:p.unit_price,evidence_refs:evidenceRefs};
   await c.query(`INSERT INTO app.source_assertions(household_id,id,document_id,owner_id,source_sheet,source_row,assertion_kind,instrument_code,asserted_on,quantity,raw_row,interpretation_status)
     VALUES($1,$2,$3,$4,'Telegram',$5,'position',$6,$7,'1',$8,'observed')`,[household,`${documentId}:fund:${index+1}`,documentId,owner.rows[0].id,index+2,`PREV-${p.fund_cnpj}`,cut,JSON.stringify(raw)]);
  }
  await c.query("INSERT INTO app.audit_log(household_id,actor_id,action,resource_id,details) VALUES($1,$2,'manual_external_snapshot_staged',$3,$4)",[household,actor,documentId,{source_system:institution,reference_date:cut,plans:plans.length,positions:positions.length,valuation_basis:input.valuation_basis,content_sha256:contentHash,evidence_refs:evidenceRefs,portfolio_changed:false}]);
  await c.query('COMMIT');
  return{document_id:documentId,content_sha256:contentHash,source_system:institution,reference_date:cut,plans:plans.length,positions:positions.length,status:'evidence_only',portfolio_published:false,replayed:false,mode:'shadow',authoritative:false};
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
