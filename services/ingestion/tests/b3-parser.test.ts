import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import {parseB3} from '../src/b3-parser.ts';

test('B3 parser preserves sheet and row identity across a multi-sheet snapshot',()=>{
 const book=XLSX.utils.book_new();
 for(const sheet of ['Ações','Renda Fixa'])XLSX.utils.book_append_sheet(book,XLSX.utils.json_to_sheet([{Produto:'PETR4',Instituição:'Itaú',Quantidade:1}]),sheet);
 const parsed=parseB3(Buffer.from(XLSX.write(book,{type:'buffer',bookType:'xlsx'})),'positions','2026-10-09');
 assert.equal(parsed.rows.length,2);
 assert.deepEqual(parsed.rows.map(row=>[row.sheet,row.source_ordinal]),[['Ações',2],['Renda Fixa',2]]);
 assert.equal(parsed.summary.reference_date,'2026-10-09');
});

test('B3 parser derives movement coverage from row dates and rejects missing required fields',()=>{
 const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.json_to_sheet([
  {Produto:'PETR4',Instituição:'Itaú',Quantidade:1,Data:'08/10/2026',Movimentação:'Transferência - Liquidação'},
  {Produto:'PETR4',Instituição:'Itaú',Quantidade:2,Data:'05/10/2026',Movimentação:'Transferência - Liquidação'}
 ]),'Movimentação');
 const parsed=parseB3(Buffer.from(XLSX.write(book,{type:'buffer',bookType:'xlsx'})),'movements',null);
 assert.equal(parsed.summary.coverage_start,'2026-10-05');assert.equal(parsed.summary.coverage_end,'2026-10-08');
 const broken=XLSX.utils.book_new();XLSX.utils.book_append_sheet(broken,XLSX.utils.json_to_sheet([{Produto:'PETR4',Instituição:'Itaú',Quantidade:1}]),'Movimentação');
 assert.throws(()=>parseB3(Buffer.from(XLSX.write(broken,{type:'buffer',bookType:'xlsx'})),'movements',null),/B3_MOVEMENT_INVALID/);
});
