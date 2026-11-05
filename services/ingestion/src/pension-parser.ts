import {pensionValuationCheck} from '../../application/src/pension-valuation.ts';
import {createHash} from 'node:crypto';
import {extractText,getDocumentProxy} from 'unpdf';

export const PENSION_PARSER_VERSION='pension-statement-v3-dates-2026-11-05';
export type PensionRow={sheet:string;source_ordinal:number;record_kind:'position'|'movement';original:Record<string,unknown>;original_sha256:string};
const iso=(value:string)=>{const m=/^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);if(!m)return null;const result=`${m[3]}-${m[2]}-${m[1]}`,parsed=new Date(`${result}T00:00:00Z`);return !Number.isNaN(parsed.valueOf())&&parsed.toISOString().slice(0,10)===result?result:null;};
function dateLocator(text:string,index:number){const before=text.slice(0,index);return `page:${before.split('\f').length}:line:${before.slice(before.lastIndexOf('\f')+1).split('\n').length}`;}
function checkedDate(text:string,value:string,field:string,index:number){const parsed=iso(value);if(parsed)return parsed;throw new Error(`PENSION_DATE_INVALID:${field}:${dateLocator(text,index)}`);}
const decimal=(value:string)=>value.replaceAll('.','').replace(',','.');
function record(sheet:string,ordinal:number,kind:PensionRow['record_kind'],original:Record<string,unknown>):PensionRow{return{sheet,source_ordinal:ordinal,record_kind:kind,original,original_sha256:createHash('sha256').update(JSON.stringify(original)).digest('hex')};}
export async function parsePensionStatement(bytes:Buffer,ownerRef:string){
 const pdf=await getDocumentProxy(new Uint8Array(bytes),{maxImageSize:16_777_216});if(pdf.numPages>20)throw new Error('PENSION_PAGE_LIMIT');
 const extracted=await extractText(pdf,{mergePages:false}),pages=extracted.text.map(String);try{return parsePensionText(pages.join('\f'),ownerRef);}catch(error){const message=error instanceof Error?error.message:'';const match=/^PENSION_DATE_INVALID:(reference_date|trade_date|quote_date):page:(\d+):line:(\d+)$/.exec(message);if(!match)throw error;return{rows:[] as PensionRow[],summary:{record_count:0,source_sheets:[],reference_date:null,coverage_start:null,coverage_end:null,review_issues:[{code:'invalid_pension_date',field:match[1],page:Number(match[2]),line:Number(match[3])}]}};}
}
export function parsePensionText(text:string,ownerRef:string){
 if(!/EXTRATO DE PREVIDÊNCIA/i.test(text)||!/Seguradora:/i.test(text))throw new Error('UNSUPPORTED_PENSION_STATEMENT');
 const provider=text.match(/Seguradora:[ \t]*([^\n\f]+)/i)?.[1]?.trim();
 const pages=text.split('\f');const plans:Array<{value:string;locator:string}>=[],funds:Array<{value:string;locator:string}>=[],cnpjs:Array<{value:string;locator:string}>=[];
 for(const [pageIndex,page] of pages.entries())for(const [lineIndex,line] of page.split('\n').entries()){
  const locator=`page:${pageIndex+1}:line:${lineIndex+1}`;
  const plan=/\b(?:N[úu]mero|N[º°o.]?)\s*(?:do|de)\s*Plano\s*[:#-]\s*([^\n]+)/i.exec(line);
  if(plan&&plan[1].trim())plans.push({value:plan[1].trim(),locator});
  const fund=/^\s*FUNDO\s*:\s*([^\n]+)/i.exec(line);if(fund&&fund[1].trim())funds.push({value:fund[1].replace(/\s+CNPJ.*$/i,'').trim(),locator});
  const labeled=/\bCNPJ\s*(?:(?:do|de)\s+)?FUNDO\s*[:#-]?\s*(\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}|\d{14})\b/i.exec(line)||/^\s*FUNDO\s*:[^\n]*?\bCNPJ\s*[:#-]?\s*(\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}|\d{14})\b/i.exec(line);
  if(labeled)cnpjs.push({value:labeled[1].replace(/\D/g,''),locator});
 }
 const unique=(items:Array<{value:string;locator:string}>)=>[...new Set(items.map(x=>x.value))];
 const planValues=unique(plans),fundValues=unique(funds),cnpjValues=unique(cnpjs),planNumber=planValues.length===1?planValues[0]:null,fund=fundValues.length===1?fundValues[0]:null,cnpj=cnpjValues.length===1?cnpjValues[0]:null;
 if(!provider||!ownerRef)throw new Error('PENSION_IDENTITY_FIELDS_MISSING');
 const identityReasons:string[]=[];if(!planNumber)identityReasons.push(planValues.length?'pension_plan_ambiguous':'pension_plan_missing');if(!fund||!cnpj)identityReasons.push(fundValues.length>1||cnpjValues.length>1?'pension_fund_ambiguous':'pension_fund_unresolved');
 const identity={plan_number:planNumber,fund,fund_cnpj:cnpj,identity_status:identityReasons.length?'needs_review':'observed',identity_review_reasons:identityReasons,identity_evidence:{plan:plans,fund:funds,fund_cnpj:cnpjs}};
 const positionRe=/\b(\d{2}\/\d{2}\/\d{4})\s+(\d{2}\/\d{2}\/\d{4})\s+Saldo Final\s+R\$\s*([\d.]+,\d{2})\s+([\d.]+,\d{8})\s+([\d.]+,\d{8})/gi;
 const positions=[...text.matchAll(positionRe)];if(!positions.length)throw new Error('PENSION_FINAL_BALANCE_MISSING');
 const normalized=positions.map(m=>({reference_date:checkedDate(text,m[1],'reference_date',m.index!),quote_date:checkedDate(text,m[2],'quote_date',m.index!),date_locator:dateLocator(text,m.index!),value:decimal(m[3]),unit_price:decimal(m[4]),quantity:decimal(m[5])}));
 const referenceDate=normalized[0].reference_date;if(!referenceDate)throw new Error('PENSION_REFERENCE_DATE_MISSING');
 if(normalized.some(p=>!p.reference_date||p.reference_date!==referenceDate))throw new Error('PENSION_REFERENCE_DATE_AMBIGUOUS');
 const balances=[...new Map(normalized.map(p=>[`${p.value}|${p.unit_price}|${p.quantity}|${p.quote_date}`,p])).values()],multipleBalances=balances.length>1;
 const instrument=cnpj?`PREV-${cnpj}`:null,rows:PensionRow[]=[];
 for(const [index,balance] of balances.entries()){const evidence=multipleBalances?{...identity,plan_number:null,identity_status:'needs_review',identity_review_reasons:[...identityReasons,'pension_multiple_balances_unassigned']}:identity;rows.push(record('Position',index+2,'position',{owner_ref:ownerRef,institution:provider,...evidence,instrument_code:instrument,currency:'BRL',reference_date:referenceDate,quote_date:balance.quote_date,date_evidence:{reference_date:balance.date_locator,quote_date:balance.date_locator},quantity:balance.quantity,unit_price:balance.unit_price,market_value:balance.value,valuation_reconciliation:pensionValuationCheck({reference_date:referenceDate,quote_date:balance.quote_date,unit_price:balance.unit_price,market_value:balance.value},balance.quantity),duplicate_balances_collapsed:normalized.filter(p=>p.value===balance.value&&p.unit_price===balance.unit_price&&p.quantity===balance.quantity&&p.quote_date===balance.quote_date).length}));}
 const movementOrdinals=new Map<string,number>();
 for(const [sectionIndex,section] of [...text.matchAll(/EXTRATO DETALHADO\s*-\s*(Conta Básica (?:Empresa|Participante))/gi)].entries()){
  const start=section.index!+section[0].length,next=text.slice(start).search(/EXTRATO DETALHADO\s*-\s*Conta Básica/);
  const body=text.slice(start,next<0?undefined:start+next),movementRe=/\b(\d{2}\/\d{2}\/\d{4})\s+(\d{2}\/\d{2}\/\d{4})\s+(Contribuição|Resgate|Portabilidade de entrada|Portabilidade de saída)\s+R\$\s*([\d.]+,\d{2})\s+([\d.]+,\d{8})\s+([\d.]+,\d{8})/gi;
  for(const [movementIndex,m] of [...body.matchAll(movementRe)].entries()){
   const date=checkedDate(text,m[1],'trade_date',start+m.index!),quoteDate=checkedDate(text,m[2],'quote_date',start+m.index!);const label=m[3],side=/Resgate|Portabilidade de saída/i.test(label)?'out':'in';
   const original={owner_ref:ownerRef,institution:provider,...identity,instrument_code:instrument,currency:'BRL',account_segment:section[1],trade_date:date,quote_date:quoteDate,date_evidence:{trade_date:dateLocator(text,start+m.index!),quote_date:dateLocator(text,start+m.index!)},event_type:label,direction:side,amount:decimal(m[4]),unit_price:decimal(m[5]),quantity:decimal(m[6])};
   const ordinal=movementOrdinals.get(section[1])??2;movementOrdinals.set(section[1],ordinal+1);rows.push(record(section[1],ordinal,'movement',original));
  }
 }
 const dates=rows.filter(r=>r.record_kind==='movement').map(r=>String(r.original.trade_date)).sort();
 return{rows,summary:{record_count:rows.length,source_sheets:[...new Set(rows.map(r=>r.sheet))],reference_date:referenceDate,coverage_start:dates[0]??null,coverage_end:dates.at(-1)??null,provider,fund,plan_number:planNumber,identity_status:identity.identity_status,identity_review_reasons:identityReasons,instrument_code:instrument}};
}
