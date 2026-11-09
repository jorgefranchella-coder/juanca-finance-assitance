/** Match a projected date to one linked, independently interpreted position assertion. */
export function maturityEvidence(item:{maturity_date:string;reference_date:string;quantity:number}, source:Record<string,unknown>|null){
 const unavailable={maturity_review_status:'unknown' as const,maturity_source_id:source?.assertion_document_id?String(source.assertion_document_id):null,maturity_assertion_id:source?.assertion_id?String(source.assertion_id):null,maturity_source_locator:source?.assertion_sheet&&source?.assertion_row?`${source.assertion_sheet} · fila ${source.assertion_row}`:null,maturity_source_date:typeof source?.assertion_reference_date==='string'?source.assertion_reference_date:null};
 if(!source)return unavailable;
 if(source.assertion_status==='needs_review'||source.interpretation_status==='needs_review')return {...unavailable,maturity_review_status:'pending' as const};
 if(source.assertion_status!=='observed'||(source.interpretation_status!=null&&source.interpretation_status!=='parsed'))return unavailable;
 const raw=source.assertion_raw as Record<string,unknown>|null;
 const date=String(raw?.Vencimento??'').trim();const match=/^(\d{2})\/(\d{2})\/(\d{4})$/.exec(date);const iso=match?`${match[3]}-${match[2]}-${match[1]}`:date;
 const qty=Number(source.assertion_quantity),expected=Number(item.quantity);
 if(!source.assertion_id||!source.assertion_document_id||!source.assertion_sheet||!source.assertion_row||iso!==item.maturity_date||typeof source.assertion_reference_date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(source.assertion_reference_date)||source.assertion_reference_date>item.reference_date||!Number.isFinite(qty)||!Number.isFinite(expected)||Math.abs(qty-expected)>Math.max(0.000001,Math.abs(expected)*1e-8))return unavailable;
 return {maturity_review_status:'clear' as const,maturity_source_id:String(source.assertion_document_id),maturity_assertion_id:String(source.assertion_id),maturity_source_locator:`${source.assertion_sheet} · fila ${source.assertion_row}`,maturity_source_date:source.assertion_reference_date};
}
