import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseAvenue} from '../src/avenue-parser.ts';

function syntheticPdf(pages:string[][]){
 const count=pages.length,font=3+count,firstStream=font+1;
 const stream=(lines:string[])=>`BT /F1 10 Tf 40 750 Td 14 TL ${lines.map(line=>`(${line.replaceAll('\\','\\\\').replaceAll('(','\\(').replaceAll(')','\\)')}) Tj T*`).join(' ')} ET`;
 const streams=pages.map(stream),objs=[
  '<< /Type /Catalog /Pages 2 0 R >>',
  `<< /Type /Pages /Kids [${pages.map((_,i)=>`${3+i} 0 R`).join(' ')}] /Count ${count} >>`,
  ...pages.map((_,i)=>`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${firstStream+i} 0 R >>`),
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ...streams.map(body=>`<< /Length ${Buffer.byteLength(body,'latin1')} >>\nstream\n${body}\nendstream`)
 ];
 let pdf='%PDF-1.4\n',offsets=[0];for(const [i,obj] of objs.entries()){offsets.push(Buffer.byteLength(pdf,'latin1'));pdf+=`${i+1} 0 obj\n${obj}\nendobj\n`;}
 const xref=Buffer.byteLength(pdf,'latin1');pdf+=`xref\n0 ${objs.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(o=>`${String(o).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;return Buffer.from(pdf,'latin1');
}
test('four-page Avenue PDF is complete only when every position and the total match',async()=>{
 const pages=[['PORTFOLIO SUMMARY','October 01, 2026 - October 31, 2026','AVENUE ACCOUNT NUMBER: SYNTHETIC-1','TOTAL PRICED PORTFOLIO $600.00'],['EQUITIES / OPTIONS','Alpha AAA C 10 10.00 $100.00','Beta BBB C 10 20.00 $200.00'],['EQUITIES / OPTIONS','PAGE 3'],['EQUITIES / OPTIONS','Gamma CCC C 10 30.00 $300.00','Total Equities $600.00']];
 const ok=await parseAvenue(syntheticPdf(pages),'owner');assert.equal(ok.rows.length,3);assert.equal(ok.rows[2].original.source_page,4);assert.equal(ok.summary.statement_coverage.complete,true);
 pages[0][3]='TOTAL PRICED PORTFOLIO $700.00';const bad=await parseAvenue(syntheticPdf(pages),'owner');assert.equal(bad.rows.length,0);assert.ok(bad.summary.review_issues.some(x=>x.code==='portfolio_total_mismatch'));
});
