import {test} from 'node:test';
import assert from 'node:assert/strict';
import {interpretManualTrade} from '../src/manual-trade-parse.ts';

const cases=[
 ['es','Venta ejecutada: 8 acciones de CSAN3 a R$ 2,73 el 27/10/2026.','BRL'],
 ['pt','Venda executada: 8 ações de CSAN3 por R$ 2,73 em 27/10/2026.','BRL'],
 ['en','Executed sell: 8 shares of CSAN3 at $2.73 on 2026-10-27.','USD'],
] as const;

for(const [language,text,currency] of cases)test(`manual trade parser reads ${language} sale, quantity, ticker, price and date`,()=>{
 const result=interpretManualTrade(text,null);
 assert.equal(result.status,'parsed_review');
 assert.deepEqual(result.fields,{side:'sell',instrument_code:'CSAN3',quantity:'8',unit_price:'2.73',currency,trade_date:'2026-10-27',fees_minor:'0',fees_assumed_zero:true});
 assert.deepEqual(result.review_reasons,[]);
});

test('manual trade parser ignores uppercase action words as tickers and accepts labeled quantity after ticker',()=>{
 const result=interpretManualTrade('VENDA de CSAN3; quantidade: 8 unidades; preço R$ 2,73; data 27/10/2026',null);
 assert.equal(result.status,'parsed_review');
 assert.equal(result.fields.side,'sell');
 assert.equal(result.fields.instrument_code,'CSAN3');
 assert.equal(result.fields.quantity,'8');
});

test('manual trade parser detects quantity before ticker when written with a unit between them',()=>{
 const result=interpretManualTrade('Confirmação: vendi 8 ações CSAN3 por R$ 2,73 em 27/10/2026',null);
 assert.equal(result.status,'parsed_review');
 assert.equal(result.fields.side,'sell');
 assert.equal(result.fields.quantity,'8');
 assert.equal(result.fields.instrument_code,'CSAN3');
});

test('manual trade parser keeps contradictory sides and ambiguous fields in review',()=>{
 const result=interpretManualTrade('Buy and sell 8 CSAN3 for BRL 2.73 on 2026-10-27',null);
 assert.equal(result.status,'needs_manual_review');
 assert.equal(result.fields.side,null);
 assert.ok(result.review_reasons.includes('side_conflict'));
});

test('limited broker order keeps structured fields but requires execution confirmation',()=>{
 const result=interpretManualTrade('Compra limitada de RDOR3\nTipo Compra\nOrdem Limitada\nValor R$ 3.369,00\nQuantidade 100 unidades\nPreco R$ 33,69\nData de solicitação 28/10/2026',null);
 assert.equal(result.status,'needs_manual_review');
 assert.equal(result.fields.instrument_code,'RDOR3');
 assert.equal(result.fields.quantity,'100');
 assert.equal(result.fields.unit_price,'33.69');
 assert.equal(result.fields.trade_date,'2026-10-28');
 assert.ok(result.review_reasons.includes('execution_unconfirmed'));
});


test('separate trade clauses never merge their prices or instruments',()=>{
 const result=interpretManualTrade('Compra ejecutada PETR4 cantidad 10; compra ejecutada VALE3 cantidad 20 precio R$ 60,00 fecha 2026-11-03',null);
 assert.equal(result.status,'needs_manual_review');
 assert.equal(result.fields.instrument_code,null);assert.equal(result.fields.unit_price,null);
 assert.ok(result.review_reasons.includes('multiple_operations_require_separate_evidence'));
});

test('same ticker distinct trade clauses also require separation',()=>{
 const result=interpretManualTrade('Compra PETR4 cantidad 10 precio R$ 30,00; compra PETR4 cantidad 20 precio R$ 31,00',null);
 assert.equal(result.fields.instrument_code,null);assert.ok(result.review_reasons.includes('multiple_operations_require_separate_evidence'));
});


test('OCR table rows are identified with source spans without mixing fields',()=>{
 const text='Compras executadas\nPETR4 10 R$ 30,00\nVALE3 20 R$ 60,00';
 const result=interpretManualTrade(text,null);
 assert.equal(result.status,'needs_manual_review');assert.equal(result.fields.instrument_code,null);
 assert.deepEqual(result.candidates?.map(c=>text.slice(c.index,c.index+c.length)),['PETR4 10 R$ 30,00','VALE3 20 R$ 60,00']);
});

test('an informative ticker mention is not a second operation',()=>{
 const result=interpretManualTrade('Compra PETR4 quantidade 10 preço R$ 30,00 data 03/11/2026; referência VALE3',null);
 assert.equal(result.fields.instrument_code,'PETR4');assert.ok(!result.review_reasons.includes('multiple_operations_require_separate_evidence'));
});


test('same-line trades and US OCR rows require separate review',()=>{
 for(const text of ['Compra PETR4 quantidade 10 e compra VALE3 quantidade 20 preço R$ 60,00','Executed buys\nAAPL 10 $100.00\nMSFT 5 $200.00']){
  const result=interpretManualTrade(text,null);assert.equal(result.fields.instrument_code,null);assert.ok(result.review_reasons.includes('multiple_operations_require_separate_evidence'));
 }
});
