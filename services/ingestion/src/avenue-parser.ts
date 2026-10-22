import {createHash} from 'node:crypto';
import {extractText,getDocumentProxy} from 'unpdf';
import {parseAvenueStatement} from '../../../workspace/apps/web/lib/avenue.ts';

export const AVENUE_PARSER_VERSION='avenue-statement-v1-2026-10-22';
export type AvenueParsedRow={sheet:string;source_ordinal:number;record_kind:'position';original:Record<string,unknown>;original_sha256:string};

export async function parseAvenue(bytes:Buffer,owner:string){
 const pdf=await getDocumentProxy(new Uint8Array(bytes),{maxImageSize:16_777_216});
 if(pdf.numPages>15)throw new Error('AVENUE_PAGE_LIMIT');
 const extracted=await extractText(pdf,{mergePages:false});
 const positions=parseAvenueStatement(extracted.text,owner);
 const rows:AvenueParsedRow[]=positions.map((position,index)=>{
  const original=JSON.parse(JSON.stringify(position)) as Record<string,unknown>;
  return{sheet:'Statement',source_ordinal:index+2,record_kind:'position',original,original_sha256:createHash('sha256').update(JSON.stringify(original)).digest('hex')};
 });
 const referenceDate=positions[0]?.reference_date;
 if(!referenceDate||positions.some(row=>row.reference_date!==referenceDate))throw new Error('AVENUE_REFERENCE_DATE_MISMATCH');
 return{rows,summary:{record_count:rows.length,source_sheets:['Statement'],reference_date:referenceDate,coverage_start:null,coverage_end:null}};
}
