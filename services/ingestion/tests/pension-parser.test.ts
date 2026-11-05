import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parsePensionText} from '../src/pension-parser.ts';

const header=`EXTRATO DE PREVIDÊNCIA
Seguradora: Zurich Santander Brasil Seguros e Previdência S.A.
CNPJ nº: 87.376.109/0001-06
FUNDO: MELI PREV SANB RFCP - CIC FIF RESP LTDA
NOME CIVIL
JORGE ESTEBAN FRANCHELLA
47.822.104/0001-45`;
test('pension parser collapses duplicated closing balances but preserves contribution segments',()=>{
 const closing='21/10/2026 20/10/2026 Saldo Final R$ 224.592,18 15,33822900 14.642,64066576';
 const contribution='11/08/2026 12/08/2026 Contribuição R$ 4.422,68 14,95461300 295,74018398';
 const text=`${header}
EXTRATO DETALHADO - Conta Básica Empresa
${contribution}
${closing}
EXTRATO DETALHADO - Conta Básica Participante
${contribution}
${closing}`;
 const parsed=parsePensionText(text,'owner-jorge');assert.equal(parsed.summary.reference_date,'2026-10-21');assert.equal(parsed.summary.record_count,3);
 assert.equal(parsed.rows[0].record_kind,'position');assert.equal(parsed.rows[0].original.instrument_code,null);assert.equal(parsed.rows[0].original.identity_status,'needs_review');assert.deepEqual(parsed.rows[0].original.identity_review_reasons,['pension_plan_missing','pension_fund_unresolved']);assert.equal(parsed.rows[0].original.quantity,'14642.64066576');assert.equal(parsed.rows[0].original.duplicate_balances_collapsed,2);
 assert.deepEqual(parsed.rows.slice(1).map(row=>[row.sheet,row.record_kind,row.original.direction]),[['Conta Básica Empresa','movement','in'],['Conta Básica Participante','movement','in']]);
});
test('different closing balances are preserved as separate unresolved evidence',()=>{
 const text=`${header}
EXTRATO DETALHADO - Conta Básica Empresa
21/10/2026 20/10/2026 Saldo Final R$ 200.000,00 15,00000000 13.333,33333333
EXTRATO DETALHADO - Conta Básica Participante
21/10/2026 20/10/2026 Saldo Final R$ 224.592,18 15,33822900 14.642,64066576`;
 const parsed=parsePensionText(text,'owner-jorge');assert.equal(parsed.rows.filter(row=>row.record_kind==='position').length,2);assert.ok(parsed.rows.every(row=>row.original.identity_status==='needs_review'));assert.ok(parsed.rows.every(row=>(row.original.identity_review_reasons as string[]).includes('pension_multiple_balances_unassigned')));
});

const synthetic=(plan:string,more='')=>`EXTRATO DE PREVIDÊNCIA
Seguradora: Seguradora Fixture
CNPJ da Seguradora: 11.111.111/0001-11
Número do Plano: ${plan}
FUNDO: Fundo Fixture
CNPJ do Fundo: 22.222.222/0001-22
${more}
21/10/2026 20/10/2026 Saldo Final R$ 1.000,00 10,00000000 100,00000000`;
test('distinct plans in the same fund retain their exact identity and document locations',()=>{const a=parsePensionText(synthetic('SYNTHETIC-A'),'owner'),b=parsePensionText(synthetic('SYNTHETIC-B'),'owner');assert.equal(a.rows[0].original.plan_number,'SYNTHETIC-A');assert.equal(b.rows[0].original.plan_number,'SYNTHETIC-B');assert.equal(a.rows[0].original.fund_cnpj,'22222222000122');assert.equal(a.rows[0].original.identity_status,'observed');assert.notDeepEqual(a.rows[0].original_sha256,b.rows[0].original_sha256);});
test('unlabeled or ambiguous fund CNPJs and missing plan stay pending',()=>{const noPlan=parsePensionText(synthetic('A').replace('Número do Plano: A',''),'owner');assert.equal(noPlan.rows[0].original.identity_status,'needs_review');const noLabel=parsePensionText(synthetic('A').replace('CNPJ do Fundo:','CNPJ:'),'owner');assert.equal(noLabel.rows[0].original.fund_cnpj,null);const ambiguous=parsePensionText(synthetic('A','CNPJ do Fundo: 33.333.333/0001-33'),'owner');assert.equal(ambiguous.rows[0].original.identity_status,'needs_review');});
test('a plan and fund on different pages retain page-specific evidence',()=>{const text=synthetic('A').replace('FUNDO: Fundo Fixture','\fFUNDO: Fundo Fixture');const parsed=parsePensionText(text,'owner');const evidence=parsed.rows[0].original.identity_evidence as {plan:Array<{locator:string}>;fund:Array<{locator:string}>};assert.match(evidence.plan[0].locator,/^page:1:/);assert.match(evidence.fund[0].locator,/^page:2:/);});

test('a synthetic two-page PDF preserves page provenance for plan and fund',async()=>{
 const {parsePensionStatement}=await import('../src/pension-parser.ts');
 const stream=(lines:string[])=>`BT /F1 10 Tf 40 750 Td 14 TL ${lines.map(line=>`(${line.replaceAll('\\','\\\\').replaceAll('(','\\(').replaceAll(')','\\)')}) Tj T*`).join(' ')} ET`;
 const streams=[stream(['EXTRATO DE PREVIDÊNCIA','Seguradora: Seguradora Fixture','Número do Plano: PLAN-001']),stream(['FUNDO: Fundo Fixture','CNPJ do Fundo: 22.222.222/0001-22','21/10/2026 20/10/2026 Saldo Final R$ 1.000,00 10,00000000 100,00000000'])];
 const objs=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',...streams.map(body=>`<< /Length ${Buffer.byteLength(body,'latin1')} >>\nstream\n${body}\nendstream`)];
 let pdf='%PDF-1.4\n',offsets=[0];for(const [i,obj] of objs.entries()){offsets.push(Buffer.byteLength(pdf,'latin1'));pdf+=`${i+1} 0 obj\n${obj}\nendobj\n`;}const xref=Buffer.byteLength(pdf,'latin1');pdf+=`xref\n0 ${objs.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(o=>`${String(o).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
 const parsed=await parsePensionStatement(Buffer.from(pdf,'latin1'),'owner');const original=parsed.rows[0].original;assert.equal(original.plan_number,'PLAN-001');assert.equal(original.fund_cnpj,'22222222000122');assert.equal(original.identity_status,'observed');const evidence=original.identity_evidence as {plan:Array<{locator:string}>;fund:Array<{locator:string}>};assert.match(evidence.plan[0].locator,/^page:1:/);assert.match(evidence.fund[0].locator,/^page:2:/);
 const invalid=await parsePensionStatement(Buffer.from(pdf.replace('20/10/2026','30/02/2026'),'latin1'),'owner');assert.equal(invalid.rows.length,0);assert.ok('review_issues' in invalid.summary);if('review_issues' in invalid.summary)assert.equal(invalid.summary.review_issues[0].field,'quote_date');
});

test('pension dates validate real calendar days and retain the quote date',()=>{
 for(const value of ['31/02/2026','31/04/2026','01/13/2026','00/01/2026','29/02/2025']){
  assert.throws(()=>parsePensionText(synthetic('A').replace('21/10/2026',value),'owner'),/PENSION_DATE_INVALID:reference_date:page:1:line:/);
 }
 const leap=parsePensionText(synthetic('A').replace('21/10/2026','29/02/2024'),'owner');assert.equal(leap.rows[0].original.reference_date,'2024-02-29');assert.equal(leap.rows[0].original.quote_date,'2026-10-20');
 assert.throws(()=>parsePensionText(synthetic('A').replace('20/10/2026','30/02/2026'),'owner'),/PENSION_DATE_INVALID:quote_date:page:1:line:/);
 const movement=synthetic('A')+'\nEXTRATO DETALHADO - Conta Básica Empresa\n11/08/2026 31/04/2026 Contribuição R$ 10,00 10,00000000 1,00000000';
 assert.throws(()=>parsePensionText(movement,'owner'),/PENSION_DATE_INVALID:quote_date:page:1:line:/);
});

test('pension valuation keeps reported numbers and flags material difference',()=>{
 const text=synthetic('A').replace('1.000,00','9.000,00');const row=parsePensionText(text,'owner').rows[0].original;
 assert.equal(row.market_value,'9000.00');assert.equal(row.quantity,'100.00000000');assert.equal(row.unit_price,'10.00000000');
 const check=row.valuation_reconciliation as {status:string;difference:string;quote_date:string};assert.equal(check.status,'mismatch');assert.equal(check.difference,'8000');assert.equal(check.quote_date,'2026-10-20');
});

test('pension valuation allows a one-cent rounding tolerance',()=>{
 const okay=synthetic('A').replace('1.000,00','1.000,01');assert.equal((parsePensionText(okay,'owner').rows[0].original.valuation_reconciliation as {status:string}).status,'consistent');
 const bad=synthetic('A').replace('1.000,00','1.000,02');assert.equal((parsePensionText(bad,'owner').rows[0].original.valuation_reconciliation as {status:string}).status,'mismatch');
});

test('valuation does not mix gross and net bases',async()=>{
 const {pensionValuationCheck}=await import('../../application/src/pension-valuation.ts');
 assert.equal(pensionValuationCheck({unit_price:'10',market_value:'1000',valuation_basis:'gross',gross_balance:'2000',net_balance:'1000'},'100').status,'basis_mismatch');
 assert.equal(pensionValuationCheck({unit_price:'10',market_value:'1000',valuation_basis:'net',gross_balance:'2000',net_balance:'1000'},'100').status,'consistent');
 assert.equal(pensionValuationCheck({unit_price:'20',market_value:'1000',valuation_basis:'net',gross_balance:'2000',net_balance:'1000'},'100').status,'not_comparable');
 assert.equal(pensionValuationCheck({unit_price:'10',market_value:'1000',quote_date:'2026-02-31'},'100').status,'invalid_date');
});
