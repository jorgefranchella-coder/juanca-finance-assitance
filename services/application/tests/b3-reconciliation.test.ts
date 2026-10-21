import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compareB3Snapshots,type PositionEvidence,type MovementEvidence} from '../src/b3-reconciliation.ts';
import {previewB3EventCount} from '../src/b3-duplicate-candidates.ts';

const base:PositionEvidence={assertion_id:'old',sheet:'Ações',product:'SMAL11',institution_id:'itau-corretora',account_id:'custody-jorge-itau',instrument_code:'SMAL11',quantity:'2.5'};
test('B3 snapshot comparison treats settlement as candidate evidence, never another applied sale',()=>{
 const move:MovementEvidence={assertion_id:'settlement',institution_id:base.institution_id,account_id:base.account_id,instrument_code:'SMAL11',asserted_on:'2026-10-07',source_event_type:'Transferência - Liquidação',direction:'Debito',quantity:'2.5'};
 const report=compareB3Snapshots('2026-09-19','2026-10-09',[base],[],[move],{start:'2025-10-08',end:'2026-10-08'});
 assert.equal(report.differences.length,1);assert.equal(report.differences[0].kind,'removed');assert.equal(report.differences[0].delta,'-2.5');assert.deepEqual(report.differences[0].candidate_movements,['settlement']);assert.equal(report.movement_interval_complete,false);assert.equal(report.portfolio_published,false);
});

test('B3 comparison keeps custody accounts separate and flags absent movement',()=>{
 const other={...base,assertion_id:'other',account_id:'custody-julia-itau',quantity:'1'};
 const report=compareB3Snapshots('2026-09-19','2026-10-09',[base,other],[{...base,assertion_id:'new',quantity:'3.5'},other],[],{start:null,end:null});
 assert.equal(report.differences.length,1);assert.equal(report.differences[0].delta,'1');assert.deepEqual(report.differences[0].review_reasons,['no_post_snapshot_movement']);
});

test('B3 duplicate event-count preview requires complete, consistent pair decisions',()=>{
 const ids=['a','b','c'];const pair=(left_assertion_id:string,right_assertion_id:string,decision:'same_event'|'distinct_events'|null)=>({left_assertion_id,right_assertion_id,decision});
 assert.deepEqual(previewB3EventCount(ids,[pair('a','b',null),pair('a','c',null),pair('b','c',null)]),{event_count_status:'needs_review',preview_event_count:null});
 assert.deepEqual(previewB3EventCount(ids,[pair('a','b','same_event'),pair('a','c','same_event'),pair('b','c','same_event')]),{event_count_status:'reconciled',preview_event_count:1});
 assert.deepEqual(previewB3EventCount(ids,[pair('a','b','distinct_events'),pair('a','c','same_event'),pair('b','c','same_event')]),{event_count_status:'conflict',preview_event_count:null});
 assert.deepEqual(previewB3EventCount(ids,[pair('a','b','distinct_events'),pair('a','c','distinct_events'),pair('b','c','distinct_events')]),{event_count_status:'reconciled',preview_event_count:3});
});
