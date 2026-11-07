import test from 'node:test';
import assert from 'node:assert/strict';
import {countReviewCards} from '../src/review-counts.ts';
import type {ReviewInput} from '../../../workspace/apps/web/lib/review-inbox.ts';

test('global counts match grouped cards beyond page boundaries',()=>{
 const confirmations=Array.from({length:201},(_,i)=>({id:`c${i}`,owner:'Jorge',category:'test',title:'Pendiente',context:{},evidence:[],actions:[],status:'open',created_at:'2026-01-01T00:00:00Z',updated_at:'2026-01-01T00:00:00Z'}));
 const proposal={id:'p1',owner:'Jorge',owner_id:'owner',account_id:'account',account_scope:'a',instrument_code:'PETR4',currency:'BRL',side:'buy',quantity:'10',unit_price:'10',fees_minor:'0',effective_date:'2026-01-01',version:1,summary_hash:'x',status:'pending',source_evidence_kind:'manual_text',source_evidence_id:'text-linked'};
 const texts=[{id:'text-linked',owner:'Jorge',original_text:'fixture',occurred_on:null,received_at:'2026-01-01T00:00:00Z',status:'awaiting_review',fields:{}},{id:'text-independent',owner:'Jorge',original_text:'fixture',occurred_on:null,received_at:'2026-01-01T00:00:00Z',status:'awaiting_review',fields:{}}];
 const photos=[{upload_id:'photo',owner:'Julia',file_name:'photo.jpg',created_at:'2026-01-01T00:00:00Z',status:'stored',proposal_evidence_status:'awaiting_review'}];
 const b3=[{document_id:'b3',owner:'Julia',original_name:'fixture',content_sha256:'x',effective_as_of:'2026-01-01',rows:1,invalid_rows:0,published:false,latest:true}];
 const input={proposals:[proposal],confirmations,texts,photos,b3,external:[],positions:[]} as ReviewInput;
 const result=countReviewCards(input);assert.deepEqual(result.counts,{decision:203,evidence:2,follow_up:0,history:0});assert.equal(result.open_count,205);
});
