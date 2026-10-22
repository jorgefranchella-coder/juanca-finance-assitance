import {createHash} from 'node:crypto';
import {extractText,getDocumentProxy} from 'unpdf';

export const PENSION_PARSER_VERSION='pension-statement-v1-2026-10-22';
export type PensionRow={sheet:string;source_ordinal:number;record_kind:'position'|'movement';original:Record<string,unknown>;original_sha256:string};
const iso=(value:string)=>{const m=/^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);return m?`${m[3]}-${m[2]}-${m[1]}`:null;};
const decimal=(value:string)=>value.replaceAll('.','').replace(',','.');
function record(sheet:string,ordinal:number,kind:PensionRow['record_kind'],original:Record<string,unknown>):PensionRow{return{sheet,source_ordinal:ordinal,record_kind:kind,original,original_sha256:createHash('sha256').update(JSON.stringify(original)).digest('hex')};}
export async function parsePensionStatement(bytes:Buffer,ownerRef:string){
 const pdf=await getDocumentProxy(new Uint8Array(bytes),{maxImageSize:16_777_216});if(pdf.numPages>20)throw new Error('PENSION_PAGE_LIMIT');
 const extracted=await extractText(pdf,{mergePages:false}),pages=extracted.text.map(String);return parsePensionText(pages.join('\n'),ownerRef);
}
export function parsePensionText(text:string,ownerRef:string){
 if(!/EXTRATO DE PREVIDÊNCIA/i.test(text)||!/Seguradora:/i.test(text))throw new Error('UNSUPPORTED_PENSION_STATEMENT');
 const provider=text.match(/Seguradora:\s*([^\n]+)/i)?.[1]?.trim();const fund=text.match(/FUNDO:\s*([^\n]+)/i)?.[1]?.trim();const fundCnpjs=[...text.matchAll(/\b(\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2})\b/g)];const cnpj=fundCnpjs.at(-1)?.[1]?.replace(/\D/g,'');
 if(!provider||!fund||!cnpj||!ownerRef)throw new Error('PENSION_IDENTITY_FIELDS_MISSING');
 const positionRe=/\b(\d{2}\/\d{2}\/\d{4})\s+(\d{2}\/\d{2}\/\d{4})\s+Saldo Final\s+R\$\s*([\d.]+,\d{2})\s+([\d.]+,\d{8})\s+([\d.]+,\d{8})/gi;
 const positions=[...text.matchAll(positionRe)];if(!positions.length)throw new Error('PENSION_FINAL_BALANCE_MISSING');
 const normalized=positions.map(m=>({reference_date:iso(m[1]),value:decimal(m[3]),unit_price:decimal(m[4]),quantity:decimal(m[5])}));
 const referenceDate=normalized[0].reference_date;if(!referenceDate)throw new Error('PENSION_REFERENCE_DATE_MISSING');
 if(normalized.some(p=>!p.reference_date||p.reference_date!==referenceDate)||new Set(normalized.map(p=>`${p.value}|${p.unit_price}|${p.quantity}`)).size!==1)throw new Error('PENSION_FINAL_BALANCE_AMBIGUOUS');
 const instrument=`PREV-${cnpj}`,rows:PensionRow[]=[];
 rows.push(record('Position',2,'position',{owner_ref:ownerRef,institution:provider,fund,fund_cnpj:cnpj,instrument_code:instrument,currency:'BRL',reference_date:referenceDate,quantity:normalized[0].quantity,unit_price:normalized[0].unit_price,market_value:normalized[0].value,duplicate_balances_collapsed:positions.length}));
 for(const [sectionIndex,section] of [...text.matchAll(/EXTRATO DETALHADO\s*-\s*(Conta Básica (?:Empresa|Participante))/gi)].entries()){
  const start=section.index!+section[0].length,next=text.slice(start).search(/EXTRATO DETALHADO\s*-\s*Conta Básica/);
  const body=text.slice(start,next<0?undefined:start+next),movementRe=/\b(\d{2}\/\d{2}\/\d{4})\s+(\d{2}\/\d{2}\/\d{4})\s+(Contribuição|Resgate|Portabilidade de entrada|Portabilidade de saída)\s+R\$\s*([\d.]+,\d{2})\s+([\d.]+,\d{8})\s+([\d.]+,\d{8})/gi;
  for(const [movementIndex,m] of [...body.matchAll(movementRe)].entries()){
   const date=iso(m[1]);if(!date)throw new Error('PENSION_MOVEMENT_DATE_INVALID');const label=m[3],side=/Resgate|Portabilidade de saída/i.test(label)?'out':'in';
   const original={owner_ref:ownerRef,institution:provider,fund,fund_cnpj:cnpj,instrument_code:instrument,currency:'BRL',account_segment:section[1],trade_date:date,quote_date:iso(m[2]),event_type:label,direction:side,amount:decimal(m[4]),unit_price:decimal(m[5]),quantity:decimal(m[6])};
   rows.push(record(section[1],movementIndex+2,'movement',original));
  }
 }
 const dates=rows.filter(r=>r.record_kind==='movement').map(r=>String(r.original.trade_date)).sort();
 return{rows,summary:{record_count:rows.length,source_sheets:[...new Set(rows.map(r=>r.sheet))],reference_date:referenceDate,coverage_start:dates[0]??null,coverage_end:dates.at(-1)??null,provider,fund,instrument_code:instrument}};
}
