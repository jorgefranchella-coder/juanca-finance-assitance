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
});
