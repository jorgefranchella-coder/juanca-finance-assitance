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
