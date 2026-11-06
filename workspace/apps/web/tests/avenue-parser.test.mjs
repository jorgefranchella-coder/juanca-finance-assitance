import assert from "node:assert/strict";
import test from "node:test";

import { analyzeAvenueConfirmations, analyzeAvenueStatement, parseAvenueConfirmations, parseAvenueStatement } from "../lib/avenue.ts";

test("parses Avenue invested positions and ignores cash balances", () => {
  const pages = [
    "PORTFOLIO SUMMARY July 01, 2026 - July 31, 2026 AVENUE ACCOUNT NUMBER: 123 TOTAL PRICED PORTFOLIO $ 6,763.79\nTotal Cash (Net Portfolio Balance) $ 23.69",
    "EQUITIES / OPTIONS\nMicrosoft Corporation\nMSFT C 5 464.72 $ 2,323.60\nNVIDIA Corp\nNVDA C 22 200.75 $ 4,416.50\nTotal Equities",
  ];
  const positions = parseAvenueStatement(pages, "Jorge");
  assert.equal(positions.length, 2);
  assert.equal(positions[0].instrument_code, "MSFT");
  assert.equal(positions[0].reference_date, "2026-07-31");
});

test("parses Avenue confirmation trades", () => {
  const pages = [`Account cleared by Apex\nTrade Date Account Number: 6AJ-74139\n1 S 08/11/26 08/12/26 2.68602 MELI 1,912.3700 5,136.66 0.00 0.00 0.00\nDesc: MERCADOLIBRE INC Interest/STTax: 0.00 CUSIP: 58733R102`];
  const trades = parseAvenueConfirmations(pages, "Jorge");
  assert.equal(trades.length, 1);
  assert.equal(trades[0].side, "sell");
  assert.equal(trades[0].principal_minor, 513666);
  assert.equal(trades[0].trade_date, "2026-08-11");
});

test('rejects multiple declared accounts instead of attributing trades to the first', () => {
 const page=(account,ticker)=>`Account cleared by Apex\nTrade Date Account Number: ${account}\n1 B 11/03/26 11/04/26 10 ${ticker} 30.00 300.00 0.00 0.00 0.00`;
 const a=analyzeAvenueConfirmations([page('SYNTHETIC-A','AAA'),page('SYNTHETIC-B','BBB')],'Jorge');
 assert.deepEqual(a.trades.map(t=>t.account),['SYNTHETIC-A','SYNTHETIC-B']);assert.ok(a.issues.some(i=>i.code==='multiple_accounts'));
 assert.throws(()=>parseAvenueConfirmations([page('SYNTHETIC-A','AAA'),page('SYNTHETIC-B','BBB')],'Jorge'),/REVIEW_REQUIRED/);
});

test('accepts valid US thousands and flags unrecognized rows without accepting a partial result',()=>{
 const prefix='Account cleared by Apex\nTrade Date Account Number: SYNTHETIC-A\n';
 const rows='1 B 11/03/26 11/04/26 10 AAA 30.00 300.00 0.00 0.00 0.00\n1 B 11/03/26 11/04/26 1,000 BBB 30.00 30,000.00 0.00 0.00 0.00';
 const trades=parseAvenueConfirmations([prefix+rows],'Jorge');assert.deepEqual(trades.map(t=>t.quantity),[10,1000]);assert.equal(trades[1].source_line,4);
 const bad=prefix+rows.replace('1,000 BBB','1,00 BBB');const result=analyzeAvenueConfirmations([bad],'Jorge');assert.equal(result.trades.length,1);assert.equal(result.issues[0].code,'unrecognized_trade');assert.equal(result.issues[0].line,4);assert.throws(()=>parseAvenueConfirmations([bad],'Jorge'),/REVIEW_REQUIRED/);
});

test('repeated account and continuation page preserve provenance',()=>{
 const a='Account cleared by Apex\nTrade Date Account Number: SYNTHETIC-A\n1 B 11/03/26 11/04/26 10 AAA 30.00 300.00 0.00 0.00 0.00';
 const b='Account Number: SYNTHETIC-A\n1 S 11/03/26 11/04/26 2.5 BBB 40.00 100.00 0.00 0.00 0.00';
 const c='CONTINUED FROM PREVIOUS PAGE\n1 B 11/03/26 11/04/26 3 CCC 20.00 60.00 0.00 0.00 0.00';
 const trades=parseAvenueConfirmations([a,b,c],'Jorge');assert.deepEqual(trades.map(t=>t.account),Array(3).fill('SYNTHETIC-A'));assert.equal(trades[2].source_page,3);
});


test('a page without an account or explicit continuation stays pending',()=>{
 const first='Account cleared by Apex\nTrade Date Account Number: SYNTHETIC-A\n1 B 11/03/26 11/04/26 10 AAA 30.00 300.00 0.00 0.00 0.00';
 const next='1 B 11/03/26 11/04/26 10 BBB 30.00 300.00 0.00 0.00 0.00';
 assert.ok(analyzeAvenueConfirmations([first,next],'Jorge').issues.some(i=>i.code==='account_context_missing'));
});


test('reads all statement pages with provenance, excluding explicitly identified cash',()=>{
 const pages=['PORTFOLIO SUMMARY\nOctober 01, 2026 - October 31, 2026\nAVENUE ACCOUNT NUMBER: SYNTHETIC-1\nTOTAL PRICED PORTFOLIO $625.00\nTotal Cash (Net Portfolio Balance) $25.00','EQUITIES / OPTIONS\nAlpha AAA C 10 10.00 $100.00\nBeta BBB C 10 20.00 $200.00','EQUITIES / OPTIONS\nPAGE 3','EQUITIES / OPTIONS\nGamma CCC C 10 30.00 $300.00\nTotal Equities $600.00'];
 const analysis=analyzeAvenueStatement(pages,'owner');assert.deepEqual(analysis.issues,[]);assert.deepEqual(analysis.positions.map(p=>p.instrument_code),['AAA','BBB','CCC']);assert.equal(analysis.positions[2].source_page,4);assert.equal(analysis.positions[2].source_line,2);assert.equal(analysis.coverage.cash_minor,2500);assert.equal(analysis.coverage.invested_minor,60000);
});

test('accepts one position and blocks missing coverage, unknown rows and wrong totals',()=>{
 const head='PORTFOLIO SUMMARY\nOctober 01, 2026 - October 31, 2026\nAVENUE ACCOUNT NUMBER: SYNTHETIC-1\nTOTAL PRICED PORTFOLIO $100.00';
 const body='EQUITIES / OPTIONS\nAlpha AAA C 10 10.00 $100.00';
 assert.equal(parseAvenueStatement([head,body],'owner').length,1);
 for(const [pages,code] of [
  [[head.replace('$100.00','$200.00'),body],'portfolio_total_mismatch'],
  [[head.replace(' $100.00',''),body],'portfolio_total_unavailable'],
  [[head,body+'\nBroken BBB C 1,00 10.00 $10.00'],'invalid_position'],
  [[head,body+'\nBroken BBB X 10 10.00 $100.00'],'unrecognized_position'],
  [[head,body,''],'empty_page'],
  [[head,'Orphan BBB C 10 10.00 $100.00'],'position_without_section'],
 ]){const analysis=analyzeAvenueStatement(pages,'owner');assert.ok(analysis.issues.some(i=>i.code===code),code);assert.throws(()=>parseAvenueStatement(pages,'owner'),/REVIEW_REQUIRED/);}
});
