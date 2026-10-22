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
 assert.equal(parsed.rows[0].record_kind,'position');assert.equal(parsed.rows[0].original.instrument_code,'PREV-47822104000145');assert.equal(parsed.rows[0].original.quantity,'14642.64066576');assert.equal(parsed.rows[0].original.duplicate_balances_collapsed,2);
 assert.deepEqual(parsed.rows.slice(1).map(row=>[row.sheet,row.record_kind,row.original.direction]),[['Conta Básica Empresa','movement','in'],['Conta Básica Participante','movement','in']]);
});
test('pension parser refuses different duplicated final balances instead of guessing their sum',()=>{
 const text=`${header}
EXTRATO DETALHADO - Conta Básica Empresa
21/10/2026 20/10/2026 Saldo Final R$ 200.000,00 15,00000000 13.333,33333333
EXTRATO DETALHADO - Conta Básica Participante
21/10/2026 20/10/2026 Saldo Final R$ 224.592,18 15,33822900 14.642,64066576`;
 assert.throws(()=>parsePensionText(text,'owner-jorge'),/PENSION_FINAL_BALANCE_AMBIGUOUS/);
});
