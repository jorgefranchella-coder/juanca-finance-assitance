import {createHash} from 'node:crypto';

type Raw=Record<string,unknown>;
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
export function pensionIdentity(raw:Raw,provider:string){
 const institution=typeof raw.institution==='string'?raw.institution.trim().replace(/\s+/g,' '):'',plan=typeof raw.plan_number==='string'?raw.plan_number.trim():'',fund=typeof raw.fund==='string'?raw.fund.trim():'',cnpj=typeof raw.fund_cnpj==='string'?raw.fund_cnpj.replace(/\D/g,''):'';
 if(Array.isArray(raw.plans)&&raw.plans.length!==1)return null;
 if(institution!==provider||!plan||plan.length>100||!fund||!/^\d{14}$/.test(cnpj)||raw.instrument_code!==`PREV-${cnpj}`||raw.identity_status!=='observed'||!raw.identity_evidence||typeof raw.identity_evidence!=='object'||Array.isArray(raw.identity_evidence))return null;
 const evidence=raw.identity_evidence as Raw;
 for(const [key,expected] of [['plan',plan],['fund',fund],['fund_cnpj',cnpj]]){
  const entries=evidence[key];if(!Array.isArray(entries)||!entries.length||entries.some(item=>!item||typeof item!=='object'||Array.isArray(item)||typeof item.value!=='string'||item.value.trim()!==expected||typeof item.locator!=='string'||!item.locator.trim()))return null;
 }
 const institutionId='pension-provider-'+sha(provider.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase()).slice(0,24);
 return {plan,fund,cnpj,institutionId};
}
export function pensionCustodyId(household:string,owner:string,institutionId:string,plan:string){return 'custody-'+sha(JSON.stringify([household,owner,institutionId,plan])).slice(0,32);}
