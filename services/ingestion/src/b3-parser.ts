import * as XLSX from 'xlsx';
import {createHash} from 'node:crypto';

export const B3_PARSER_VERSION='b3-raw-v1-2026-10-10';
type Row=Record<string,unknown>;
export type ParsedRow={sheet:string;source_ordinal:number;record_kind:'position'|'movement';original:Row;original_sha256:string};
function clean(value:unknown){return String(value??'').trim();}
function iso(value:unknown):string|null{if(value instanceof Date&&!Number.isNaN(value.getTime()))return value.toISOString().slice(0,10);const text=clean(value);const m=/^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);if(m)return `${m[3]}-${m[2]}-${m[1]}`;return /^\d{4}-\d{2}-\d{2}$/.test(text)?text:null;}
export function parseB3(bytes:Buffer,fileType:'positions'|'movements',referenceDate:string|null){
 const workbook=XLSX.read(bytes,{type:'buffer',cellDates:true});const rows:ParsedRow[]=[];const dates:string[]=[];
 const selected=workbook.SheetNames.filter(name=>fileType==='movements'?name==='Movimentação':name!=='Movimentação');
 if(!selected.length)throw new Error('B3_SHEET_MISSING');
 for(const sheet of selected){
  const worksheet=workbook.Sheets[sheet];
  for(const raw of XLSX.utils.sheet_to_json<Row>(worksheet,{defval:null})){
   const ordinal=Number((raw as Row&{__rowNum__?:number}).__rowNum__??NaN)+1;
   if(!Number.isInteger(ordinal)||ordinal<2)throw new Error('B3_ROW_NUMBER_INVALID');
   if(!clean(raw.Produto)&&!clean(raw.Instituição))continue;
   if(!clean(raw.Produto)||!clean(raw.Instituição)||!clean(raw.Quantidade))throw new Error('B3_REQUIRED_COLUMN_MISSING');
   if(fileType==='movements'){const date=iso(raw.Data);if(!date||!clean(raw.Movimentação))throw new Error('B3_MOVEMENT_INVALID');dates.push(date);}
   const original=JSON.parse(JSON.stringify(raw)) as Row;
   rows.push({sheet,source_ordinal:ordinal,record_kind:fileType==='positions'?'position':'movement',original,original_sha256:createHash('sha256').update(JSON.stringify(original)).digest('hex')});
  }
 }
 if(!rows.length)throw new Error('B3_EMPTY_REPORT');
 if(fileType==='positions'&&!referenceDate)throw new Error('B3_REFERENCE_DATE_REQUIRED');
 dates.sort();return{rows,summary:{record_count:rows.length,source_sheets:selected,reference_date:referenceDate,coverage_start:dates[0]??null,coverage_end:dates.at(-1)??null}};
}
