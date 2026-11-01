import {createHash,randomUUID} from 'node:crypto';
import type pg from 'pg';
import {Conflict} from './commands.ts';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOCUMENT_ID=/^[A-Za-z0-9._:-]{1,240}$/;
const KEY=/^[A-Za-z0-9._:-]{8,128}$/;
const DATE=/^\d{4}-\d{2}-\d{2}$/;
const DECIMAL=/^-?\d{1,6}(?:\.\d{1,8})?$/;
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const validDate=(value:string)=>{if(!DATE.test(value))return false;const d=new Date(value+'T12:00:00Z');return Number.isFinite(d.valueOf())&&d.toISOString().slice(0,10)===value;};
type Payment={date:string;kind:'coupon'|'amortization';amount_per_unit:string};
export type ContractTerms={method:'fixed'|'indexed';interest_treatment:'capitalize'|'cashflow';indexer_relation:'additive'|'compound'|'multiplier';indexer:'none'|'CDI'|'IPCA'|'SELIC';annual_rate_pct:string;indexer_assumption_pct:string|null;tax_rate_pct:string|null;schedule_confirmed:boolean;payment_schedule:Payment[]};

function parseTerms(value:unknown):ContractTerms {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Conflict('VALIDATION',422);
 const input=value as Record<string,unknown>,allowed=['method','interest_treatment','indexer_relation','indexer','annual_rate_pct','indexer_assumption_pct','tax_rate_pct','schedule_confirmed','payment_schedule'];
 if(Object.keys(input).some(key=>!allowed.includes(key)))throw new Conflict('VALIDATION',422);
 const method=input.method,treatment=input.interest_treatment,relation=input.indexer_relation,indexer=input.indexer,rate=String(input.annual_rate_pct??'');
 if(!['fixed','indexed'].includes(String(method))||!['capitalize','cashflow'].includes(String(treatment))||!['additive','compound','multiplier'].includes(String(relation))||!['none','CDI','IPCA','SELIC'].includes(String(indexer))||!DECIMAL.test(rate)||Number(rate)<=-100||Number(rate)>1000)throw new Conflict('VALIDATION',422);
 const indexRate=input.indexer_assumption_pct==null?null:String(input.indexer_assumption_pct);
 if(method==='fixed'&&(indexer!=='none'||indexRate!==null||relation!=='additive')||method==='indexed'&&(!['CDI','IPCA','SELIC'].includes(String(indexer))||!indexRate||!DECIMAL.test(indexRate)||Number(indexRate)<=-100||Number(indexRate)>1000||relation==='multiplier'&&Number(rate)<0))throw new Conflict('VALIDATION',422);
 const tax=input.tax_rate_pct==null?null:String(input.tax_rate_pct);
 if(tax!==null&&(!DECIMAL.test(tax)||Number(tax)<0||Number(tax)>100))throw new Conflict('VALIDATION',422);
 if(typeof input.schedule_confirmed!=='boolean'||!Array.isArray(input.payment_schedule)||input.payment_schedule.length>200)throw new Conflict('VALIDATION',422);
 const schedule=input.payment_schedule.map((raw):Payment=>{
   if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Conflict('VALIDATION',422);
   const row=raw as Record<string,unknown>,date=String(row.date??''),kind=row.kind,amount=String(row.amount_per_unit??'');
   if(Object.keys(row).some(key=>!['date','kind','amount_per_unit'].includes(key))||!validDate(date)||!['coupon','amortization'].includes(String(kind))||!DECIMAL.test(amount)||Number(amount)<=0)throw new Conflict('VALIDATION',422);
   return {date,kind:kind as Payment['kind'],amount_per_unit:amount};
 }).sort((a,b)=>a.date.localeCompare(b.date));
 return {method:method as ContractTerms['method'],interest_treatment:treatment as ContractTerms['interest_treatment'],indexer_relation:relation as ContractTerms['indexer_relation'],indexer:indexer as ContractTerms['indexer'],annual_rate_pct:rate,indexer_assumption_pct:indexRate,tax_rate_pct:tax,schedule_confirmed:input.schedule_confirmed,payment_schedule:schedule};
}

export function calculateContractProjection(input:{current_value_cents:number;quantity:number;as_of:string;maturity_date:string;terms:ContractTerms}) {
 const {terms}=input,missing:string[]=[];
 if(!validDate(input.maturity_date))missing.push('fecha de vencimiento');
 if(!validDate(input.as_of)||!Number.isSafeInteger(input.current_value_cents)||input.current_value_cents<=0||!Number.isFinite(input.quantity)||input.quantity<=0)missing.push('posición y fecha de referencia');
 if(terms.method==='indexed'&&terms.indexer_assumption_pct===null)missing.push(`supuesto de proyección ${terms.indexer}`);
 if(!terms.schedule_confirmed)missing.push('confirmación del calendario completo de cupones y amortizaciones');
 if(missing.length)return {status:'incomplete' as const,missing,version:'contract-projection-v1',calendar:[],gross_maturity_cents:null,net_maturity_cents:null,gross_cashflows_cents:null,net_cashflows_cents:null};
 const indexRate=Number(terms.indexer_assumption_pct),contractRate=Number(terms.annual_rate_pct);
 const projectedAnnualPct=terms.method==='indexed'?(terms.indexer_relation==='multiplier'?indexRate*contractRate/100:terms.indexer_relation==='compound'?((1+indexRate/100)*(1+contractRate/100)-1)*100:indexRate+contractRate):contractRate;
 if(!Number.isFinite(projectedAnnualPct)||projectedAnnualPct<=-100)return {status:'incomplete' as const,missing:['tasa anual del escenario inválida'],version:'contract-projection-v1',calendar:[],gross_maturity_cents:null,net_maturity_cents:null,gross_cashflows_cents:null,net_cashflows_cents:null};
 const rate=terms.interest_treatment==='capitalize'?projectedAnnualPct/100:0;
 const start=new Date(input.as_of+'T12:00:00Z'),end=new Date(input.maturity_date+'T12:00:00Z');
 if(Number.isNaN(start.valueOf())||Number.isNaN(end.valueOf())||end<start)return {status:'incomplete' as const,missing:['fechas válidas y vencimiento posterior a la referencia'],version:'contract-projection-v1',calendar:[],gross_maturity_cents:null,net_maturity_cents:null,gross_cashflows_cents:null,net_cashflows_cents:null};
 const payments=terms.payment_schedule.filter(p=>p.date>input.as_of&&p.date<=input.maturity_date),dates=new Set<string>();
 let year=start.getUTCFullYear(),month=start.getUTCMonth()-1;
 while(true) {if(++month>11){month=0;year++;}const monthEnd=Date.UTC(year,month+1,0,12);if(monthEnd>end.valueOf())break;const date=new Date(monthEnd).toISOString().slice(0,10);if(date>input.as_of&&date<=input.maturity_date)dates.add(date);}
 dates.add(input.maturity_date);for(const p of payments)dates.add(p.date);
 let balance=input.current_value_cents/100,previous=input.as_of,grossCoupons=0,grossAmortizations=0,grossMaturity=0;const calendar:Array<{date:string;balance_cents:number;cashflow_cents:number;maturity_cents:number;kind:string}> = [];
 for(const date of [...dates].sort()){
   const days=(Date.parse(date+'T12:00:00Z')-Date.parse(previous+'T12:00:00Z'))/86400000;
   balance*=Math.pow(1+rate,days/365.25);
   if(!Number.isFinite(balance)||balance*100>Number.MAX_SAFE_INTEGER)return {status:'incomplete' as const,missing:['importe del escenario fuera del rango calculable'],version:'contract-projection-v1',calendar:[],gross_maturity_cents:null,net_maturity_cents:null,gross_cashflows_cents:null,net_cashflows_cents:null};
   const todaysPayments=payments.filter(p=>p.date===date);
   for(const payment of todaysPayments){
     const amount=Number(payment.amount_per_unit)*input.quantity;
     if(payment.kind==='amortization'){
       if(amount>balance+0.005)return {status:'incomplete' as const,missing:[`amortización del ${date} supera el saldo proyectado`],version:'contract-projection-v1',calendar:[],gross_maturity_cents:null,net_maturity_cents:null,gross_cashflows_cents:null,net_cashflows_cents:null};
       balance=Math.max(0,balance-amount);grossAmortizations+=amount;
     }
   }
   const couponCents=Math.round(todaysPayments.filter(p=>p.kind==='coupon').reduce((sum,p)=>sum+Number(p.amount_per_unit)*input.quantity,0)*100);
   const amortizationCents=Math.round(todaysPayments.filter(p=>p.kind==='amortization').reduce((sum,p)=>sum+Number(p.amount_per_unit)*input.quantity,0)*100);
   grossCoupons+=couponCents/100;let paid=couponCents+amortizationCents;const maturityCents=date===input.maturity_date?Math.round(balance*100):0;
   if(maturityCents){grossMaturity=maturityCents;paid+=maturityCents;balance=0;}
   calendar.push({date,balance_cents:Math.round(balance*100),cashflow_cents:paid,maturity_cents:maturityCents,kind:date===input.maturity_date?'maturity':'projection'});previous=date;
 }
 const taxRate=terms.tax_rate_pct===null?null:Number(terms.tax_rate_pct)/100,netAvailable=taxRate!==null&&grossAmortizations===0,flowCents=Math.round((grossCoupons+grossAmortizations)*100);
 return {status:'complete' as const,missing:[],version:'contract-projection-v1',rate_pct:terms.interest_treatment==='capitalize'?rate*100:null,indexer:terms.indexer,indexer_relation:terms.indexer_relation,indexer_assumption_pct:terms.indexer_assumption_pct,interest_treatment:terms.interest_treatment,calendar,gross_maturity_cents:grossMaturity,
   net_maturity_cents:!netAvailable?null:Math.round((grossMaturity/100-Math.max(0,grossMaturity/100+grossAmortizations-input.current_value_cents/100)*taxRate)*100),
   gross_cashflows_cents:flowCents,net_cashflows_cents:!netAvailable?null:Math.round((grossAmortizations+grossCoupons*(1-taxRate))*100),
   tax_status:taxRate===null?'not_modelled':netAvailable?'explicit_assumption':'amortization_tax_basis_missing',cashflow_note:terms.interest_treatment==='cashflow'?'El principal no se capitaliza; se proyectan solo los flujos ingresados y se devuelve el principal pendiente al vencimiento.':'Los cupones y amortizaciones se registran como importe por unidad y fecha; los cupones no se reinvierten. En indexados se usa la relación de suma, composición o porcentaje elegida.'};
}

export async function listFixedIncomeContractTerms(db:pg.Pool,household:string){
 const [result,documents]=await Promise.all([db.query(`SELECT p.id AS position_id,p.instrument_code,p.currency,o.display_name AS owner,ci.canonical_name AS institution,
   ca.external_reference AS account,sa.quantity::text AS source_quantity,sd.effective_as_of::text AS reference_date,sa.document_id AS position_source_document_id,
   sd.original_name AS position_source_document_name,concat_ws(' · ',sa.source_sheet,CASE WHEN sa.source_row IS NOT NULL THEN 'fila '||sa.source_row::text END) AS position_source_locator,
   (COALESCE(ir.custody_account_id,p.custody_account_id) IS NOT NULL) AS custody_identity_resolved,
   terms.id AS terms_id,terms.revision,terms.method,terms.interest_treatment,terms.indexer_relation,terms.indexer,terms.annual_rate_pct::text,terms.indexer_assumption_pct::text,terms.tax_rate_pct::text,
   terms.schedule_confirmed,terms.payment_schedule,terms.source_document_id,doc.original_name AS source_document_name,terms.source_assertion_id,terms.source_locator
   FROM app.position_identities p JOIN app.owners o ON o.household_id=p.household_id AND o.id=p.owner_id
   JOIN app.custody_institutions ci ON ci.id=p.institution_id
   LEFT JOIN LATERAL (SELECT custody_account_id FROM app.position_identity_resolutions x WHERE x.household_id=p.household_id AND x.position_id=p.id ORDER BY revision DESC LIMIT 1) ir ON true
   LEFT JOIN app.custody_accounts ca ON ca.household_id=p.household_id AND ca.id=COALESCE(ir.custody_account_id,p.custody_account_id)
   LEFT JOIN app.source_assertions sa ON sa.household_id=p.household_id AND sa.id=p.source_assertion_id
   LEFT JOIN app.source_documents sd ON sd.household_id=sa.household_id AND sd.id=sa.document_id
   LEFT JOIN LATERAL (SELECT * FROM app.fixed_income_contract_terms t WHERE t.household_id=p.household_id AND t.position_id=p.id ORDER BY revision DESC LIMIT 1) terms ON true
   LEFT JOIN app.source_documents doc ON doc.household_id=terms.household_id AND doc.id=terms.source_document_id
   WHERE p.household_id=$1 ORDER BY o.display_name,ci.canonical_name,p.instrument_code,p.id`,[household]),db.query(`SELECT d.id AS source_document_id,d.owner_id,o.display_name AS owner,d.original_name,d.source_system,d.report_kind,d.effective_as_of::text AS effective_as_of
     FROM app.source_documents d JOIN app.owners o ON o.household_id=d.household_id AND o.id=d.owner_id WHERE d.household_id=$1 ORDER BY d.registered_at DESC LIMIT 500`,[household])]);
 return {positions:result.rows,source_documents:documents.rows,mode:'postgres',authoritative:true,terms_version:'fixed-income-contract-v1'};
}

export async function recordFixedIncomeContractTerms(db:pg.Pool,household:string,actor:string,key:string,value:unknown){
 if(!actor.trim()||actor.length>240||!KEY.test(key)||!value||typeof value!=='object'||Array.isArray(value))throw new Conflict('VALIDATION',422);
 const input=value as Record<string,unknown>,allowed=['position_id','source_document_id','source_assertion_id','source_locator','terms'];
 if(Object.keys(input).some(k=>!allowed.includes(k))||!UUID.test(String(input.position_id??''))||!DOCUMENT_ID.test(String(input.source_document_id??''))||input.source_assertion_id!=null&&!DOCUMENT_ID.test(String(input.source_assertion_id))||typeof input.source_locator!=='string'||!input.source_locator.trim()||input.source_locator.length>240)throw new Conflict('VALIDATION',422);
 const terms=parseTerms(input.terms),digest=hash(JSON.stringify({position_id:input.position_id,source_document_id:input.source_document_id,source_assertion_id:input.source_assertion_id??null,source_locator:input.source_locator.trim(),terms}));
 const c=await db.connect();try{await c.query('BEGIN');const member=await c.query("SELECT 1 FROM app.memberships WHERE household_id=$1 AND actor_id=$2 AND role IN ('owner','approver')",[household,actor]);if(!member.rowCount)throw new Conflict('FORBIDDEN',403);await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${household}:${actor}:${key}`]);
   const replay=await c.query('SELECT request_hash,id,revision FROM app.fixed_income_contract_terms WHERE household_id=$1 AND recorded_by=$2 AND request_key=$3',[household,actor,key]);
   if(replay.rowCount){if(replay.rows[0].request_hash!==digest)throw new Conflict('IDEMPOTENCY_MISMATCH',409);await c.query('COMMIT');return {terms_id:replay.rows[0].id,revision:replay.rows[0].revision,replayed:true,portfolio_changed:false};}
   const position=await c.query(`SELECT p.owner_id,COALESCE(ir.custody_account_id,p.custody_account_id) AS custody_account_id FROM app.position_identities p
     LEFT JOIN LATERAL (SELECT custody_account_id FROM app.position_identity_resolutions x WHERE x.household_id=p.household_id AND x.position_id=p.id ORDER BY revision DESC LIMIT 1) ir ON true
     WHERE p.household_id=$1 AND p.id=$2`,[household,input.position_id]);if(!position.rowCount)throw new Conflict('NOT_FOUND',404);if(!position.rows[0].custody_account_id)throw new Conflict('CUSTODY_ACCOUNT_IDENTITY_REQUIRED',422);
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${household}:fixed-income-position:${input.position_id}`]);
   const doc=await c.query('SELECT owner_id FROM app.source_documents WHERE household_id=$1 AND id=$2',[household,input.source_document_id]);if(doc.rows[0]?.owner_id!==position.rows[0].owner_id)throw new Conflict('CONTRACT_EVIDENCE_OWNER_MISMATCH',422);
   const previous=await c.query('SELECT id,revision FROM app.fixed_income_contract_terms WHERE household_id=$1 AND position_id=$2 ORDER BY revision DESC LIMIT 1 FOR UPDATE',[household,input.position_id]);
   const id=randomUUID(),revision=Number(previous.rows[0]?.revision??0)+1;
   await c.query(`INSERT INTO app.fixed_income_contract_terms(household_id,id,position_id,revision,method,interest_treatment,indexer_relation,indexer,annual_rate_pct,indexer_assumption_pct,tax_rate_pct,schedule_confirmed,payment_schedule,source_document_id,source_assertion_id,source_locator,recorded_by,request_key,request_hash,supersedes_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17,$18,$19,$20)`,[household,id,input.position_id,revision,terms.method,terms.interest_treatment,terms.indexer_relation,terms.indexer,terms.annual_rate_pct,terms.indexer_assumption_pct,terms.tax_rate_pct,terms.schedule_confirmed,JSON.stringify(terms.payment_schedule),input.source_document_id,input.source_assertion_id??null,input.source_locator.trim(),actor,key,digest,previous.rows[0]?.id??null]);
   await c.query("INSERT INTO app.audit_log(household_id,actor_id,action,resource_id,details) VALUES($1,$2,'fixed_income_contract_terms_recorded',$3,$4)",[household,actor,id,{position_id:input.position_id,revision,source_document_id:input.source_document_id,source_assertion_id:input.source_assertion_id??null,terms_version:'fixed-income-contract-v1',portfolio_changed:false}]);
   await c.query('COMMIT');return {terms_id:id,revision,replayed:false,portfolio_changed:false,terms_version:'fixed-income-contract-v1'};
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
