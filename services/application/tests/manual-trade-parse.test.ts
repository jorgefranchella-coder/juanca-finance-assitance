import {test} from 'node:test';
import assert from 'node:assert/strict';
import {interpretManualTrade} from '../src/manual-trade-parse.ts';
import {guardAmbiguousText} from '../src/manual-intake.ts';

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

test('numeric parser preserves unambiguous English and Brazilian grouping exactly',()=>{
 for(const amount of ['1,234.56','1.234,56']){
  const result=interpretManualTrade(`Bought AAPL quantity 10 at USD ${amount} on 2026-11-02`,null);
  assert.equal(result.fields.unit_price,'1234.56');assert.equal(result.status,'parsed_review');
 }
 const grouped=interpretManualTrade('Bought AAPL quantity 1,234.50 at USD 10.50 on 2026-11-02',null);
 assert.equal(grouped.fields.quantity,'1234.50');
});

test('ambiguous and malformed amounts and quantities remain unresolved without truncation',()=>{
 for(const amount of ['1,234','1.234','12,34.56','1.23.456','12,34,567','1,234.56.78']){
  const result=interpretManualTrade(`Bought AAPL quantity 10 at USD ${amount} on 2026-11-02`,null);
  assert.equal(result.fields.unit_price,null,amount);assert.equal(result.status,'needs_manual_review');assert.ok(result.review_reasons.includes('numeric_format_ambiguous_or_invalid'));
 }
 for(const quantity of ['1,234','1.234','12,34.56','1,234.56.78']){
  const result=interpretManualTrade(`Bought AAPL quantity ${quantity} at USD 10.50 on 2026-11-02`,null);
  assert.equal(result.fields.quantity,null,quantity);assert.equal(result.status,'needs_manual_review');assert.ok(result.review_reasons.includes('numeric_format_ambiguous_or_invalid'));
 }
});


test('pending historic interpretation with wrong amount is rechecked without mutating stored data',()=>{
 const row={status:'awaiting_review',original_text:'Bought AAPL quantity 10 at USD 1,234.56 on 2026-11-02',occurred_on:null,fields:{quantity:'10',unit_price:'1.23456'},interpretation_status:'parsed_review',review_reasons:[] as string[],parser_version:'manual-trade-v4'};
 const checked=guardAmbiguousText(row);assert.equal(checked.interpretation_status,'needs_manual_review');assert.equal(checked.fields.unit_price,'1234.56');assert.ok(checked.review_reasons.includes('numeric_interpretation_changed_requires_review'));assert.equal(row.fields.unit_price,'1.23456');
 const approved=guardAmbiguousText({...row,status:'linked'});assert.equal(approved.fields.unit_price,'1.23456');
});

test('totals and commissions never become unit prices',()=>{
 for(const text of [
  'Compra ejecutada PETR4; cantidad 10; total R$ 300,00; fecha 2026-11-03',
  'Compra ejecutada PETR4; cantidad 10; comisión R$ 5,00; total R$ 305,00; fecha 2026-11-03',
  'Executed buy AAPL quantity 10; fee USD 5.00; net total USD 305.00; date 2026-11-03',
  'Compra executada PETR4; quantidade 10; corretagem R$ 5,00; total líquido R$ 305,00; data 2026-11-03',
 ]){
  const result=interpretManualTrade(text,null);assert.equal(result.status,'needs_manual_review');assert.equal(result.fields.unit_price,null);assert.ok(result.review_reasons.includes('unit_price_unresolved'));assert.ok(result.fields.amount_candidates?.length);
 }
 const withFee=interpretManualTrade('Compra ejecutada PETR4; cantidad 10; comisión R$ 5,00; total R$ 305,00; fecha 2026-11-03',null);
 assert.equal(withFee.fields.fees_minor,'500');assert.equal(withFee.fields.fees_assumed_zero,false);
});

test('price and fees reconcile declared gross and net values, otherwise require review',()=>{
 for(const [text,expected] of [
  ['Compra ejecutada PETR4; cantidad 10; precio R$ 30,00; total bruto R$ 300,00; comisión R$ 5,00; total neto R$ 305,00; fecha 2026-11-03',true],
  ['Compra ejecutada PETR4; cantidad 10; precio R$ 30,00; total bruto R$ 400,00; fecha 2026-11-03',false],
  ['Bought AAPL quantity 10; unit price USD 30.00; fee USD 5.00; net total USD 305.00; date 2026-11-03',true],
  ['Compra executada PETR4; quantidade 10; preço unitário R$ 30,00; corretagem R$ 5,00; total líquido R$ 306,00; data 2026-11-03',false],
 ] as const){const result=interpretManualTrade(text,null);assert.equal(result.fields.unit_price,'30.00');assert.equal(result.status,expected?'parsed_review':'needs_manual_review',text);if(!expected)assert.ok(result.review_reasons.includes('declared_amount_mismatch'));}
 const unknown=interpretManualTrade('Bought AAPL quantity 10; price USD 30.00; net total USD 300.00; date 2026-11-03',null);assert.ok(unknown.review_reasons.includes('net_total_requires_review'));
});

test('unparsed commission is never silently assumed zero',()=>{
 const parsed=interpretManualTrade('Compra PETR4 quantidade 10 preço R$ 30,00 comissão 5,00 data 03/11/2026',null);
 assert.equal(parsed.fields.fees_minor,null);assert.equal(parsed.fields.fees_assumed_zero,false);assert.ok(parsed.review_reasons.includes('fees_require_review'));
});

test('pending old total-as-unit-price interpretation is blocked and original remains intact',()=>{
 const row={status:'awaiting_review',original_text:'Compra ejecutada PETR4; cantidad 10; total R$ 300,00; fecha 2026-11-03',occurred_on:null,fields:{quantity:'10',unit_price:'300.00',fees_minor:'0'},interpretation_status:'parsed_review',review_reasons:[] as string[],parser_version:'manual-trade-v5-numeric'};
 const checked=guardAmbiguousText(row);assert.equal(checked.interpretation_status,'needs_manual_review');assert.equal(checked.fields.unit_price,null);assert.ok(checked.review_reasons.includes('unit_price_unresolved'));assert.equal(row.fields.unit_price,'300.00');
});

test('one action and two quantified securities are separate candidate trades',()=>{
 for(const text of [
  'Compré 10 PETR4 y 20 VALE3 a R$ 60,00 el 03/11/2026',
  'Compré 10 PETR4 a R$ 30,00 y 20 PETR4 a R$ 31,00 el 03/11/2026',
  'Bought 10 AAPL and 5 MSFT at USD 60.00 on 2026-11-03',
  'Compra PETR4 quantidade 10 e VALE3 quantidade 20 preço R$ 60,00',
 ]){
  const parsed=interpretManualTrade(text,null);assert.equal(parsed.status,'needs_manual_review',text);assert.equal(parsed.fields.unit_price,null);assert.ok(parsed.review_reasons.includes('multiple_operations_require_separate_evidence'));assert.equal(parsed.candidates?.length,2);
  for(const c of parsed.candidates??[])assert.equal(text.slice(c.index,c.index+c.length),c.value);
 }
 const single=interpretManualTrade('Bought 10 AAPL at USD 30.00 on 2026-11-03; reference MSFT',null);
 assert.ok(!single.review_reasons.includes('multiple_operations_require_separate_evidence'));
});
