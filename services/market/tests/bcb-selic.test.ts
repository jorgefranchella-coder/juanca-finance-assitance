import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchBcbSelicDaily} from '../src/bcb-selic.ts';

test('BCB SGS 11 adapter preserves daily percent, dates and response revision',async()=>{
 const result=await fetchBcbSelicDaily('2026-01-02','2026-01-05',async url=>{
  assert.match(String(url),/bcdata\.sgs\.11\/dados/);assert.match(String(url),/dataInicial=02%2F01%2F2026/);
  return new Response(JSON.stringify([{data:'02/01/2026',valor:'0.055131'},{data:'05/01/2026',valor:'0,055131'}]),{status:200});
 });
 assert.equal(result.observations.length,2);assert.equal(result.observations[0].unit,'daily_percent');assert.equal(result.observations[1].rate_pct,'0.055131');assert.match(result.version,/^[0-9a-f]{64}$/);
});
test('BCB adapter rejects duplicate dates, malformed data and overlong ranges',async()=>{
 await assert.rejects(()=>fetchBcbSelicDaily('2026-01-01','2026-01-05',async()=>new Response(JSON.stringify([{data:'02/01/2026',valor:'1'},{data:'02/01/2026',valor:'1'}]))),/BCB_SGS_INVALID_PAYLOAD/);
 await assert.rejects(()=>fetchBcbSelicDaily('2010-01-01','2026-01-01',fetch),/INVALID_SGS_INTERVAL/);
});
