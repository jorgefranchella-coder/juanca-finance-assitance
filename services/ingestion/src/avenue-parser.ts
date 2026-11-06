import {createHash} from 'node:crypto';
import {extractText,getDocumentProxy} from 'unpdf';
import {analyzeAvenueConfirmations,analyzeAvenueStatement} from '../../../workspace/apps/web/lib/avenue.ts';

export const AVENUE_PARSER_VERSION='avenue-statement-v2-coverage-2026-11-06';
export const AVENUE_CONFIRMATION_PARSER_VERSION='avenue-confirmation-v2-2026-11-05';
export type AvenueParsedRow={sheet:string;source_ordinal:number;record_kind:'position'|'movement';original:Record<string,unknown>;original_sha256:string};

export async function parseAvenue(bytes:Buffer,owner:string){
 const pdf=await getDocumentProxy(new Uint8Array(bytes),{maxImageSize:16_777_216});
 if(pdf.numPages>15)throw new Error('AVENUE_PAGE_LIMIT');
 const extracted=await extractText(pdf,{mergePages:false});
 const analysis=analyzeAvenueStatement(extracted.text,owner);
 const positions=analysis.issues.length?[]:analysis.positions;
 const rows:AvenueParsedRow[]=positions.map((position,index)=>{
  const original=JSON.parse(JSON.stringify(position)) as Record<string,unknown>;
  return{sheet:'Statement',source_ordinal:index+2,record_kind:'position',original,original_sha256:createHash('sha256').update(JSON.stringify(original)).digest('hex')};
 });
 const referenceDate=analysis.reference_date;
 if(!referenceDate||positions.some(row=>row.reference_date!==referenceDate))throw new Error('AVENUE_REFERENCE_DATE_MISMATCH');
 return{rows,summary:{record_count:rows.length,source_sheets:['Statement'],reference_date:referenceDate,coverage_start:null,coverage_end:null,review_issues:analysis.issues,statement_coverage:analysis.coverage}};
}

export async function parseAvenueConfirmation(bytes:Buffer,owner:string){
 const pdf=await getDocumentProxy(new Uint8Array(bytes),{maxImageSize:16_777_216});
 if(pdf.numPages>15)throw new Error('AVENUE_PAGE_LIMIT');
 const extracted=await extractText(pdf,{mergePages:false});
 const analysis=analyzeAvenueConfirmations(extracted.text,owner);
 const trades=analysis.issues.length?[]:analysis.trades;
 const rows:AvenueParsedRow[]=trades.map((trade,index)=>{
  const original=JSON.parse(JSON.stringify(trade)) as Record<string,unknown>;
  return{sheet:'Confirmation',source_ordinal:index+2,record_kind:'movement',original,original_sha256:createHash('sha256').update(JSON.stringify(original)).digest('hex')};
 });
 const dates=trades.map(trade=>trade.trade_date).sort();
 return{rows,summary:{record_count:rows.length,source_sheets:['Confirmation'],reference_date:dates.at(-1)??null,coverage_start:dates[0]??null,coverage_end:dates.at(-1)??null,review_issues:analysis.issues}};
}
