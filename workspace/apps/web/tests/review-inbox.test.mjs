import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildReviewCards,custodyLabel} from '../lib/review-inbox.ts';

const proposal=(id,date,received='2026-10-28T12:00:00Z')=>({id,owner:'Jorge',owner_id:'owner-1',account_id:'account-1',account_scope:'["Jorge","custody:c1"]',instrument_code:'CSAN3',currency:'BRL',side:'sell',quantity:'8',unit_price:'2.73',fees_minor:'0',effective_date:date,version:1,summary_hash:'hash',status:'pending',source_evidence_kind:'manual_photo',source_evidence_id:'photo-1',source_evidence_received_at:received});
const text=(id,date)=>({id,owner:'Jorge',original_text:'Venta ejecutada: 8 acciones de CSAN3',occurred_on:null,received_at:'2026-10-28T13:00:00Z',status:'awaiting_review',fields:{side:'sell',instrument_code:'CSAN3',quantity:'8',trade_date:date},interpretation_status:'parsed_review'});
const input=(overrides={})=>({proposals:[],confirmations:[],texts:[],photos:[],b3:[],external:[],positions:[],...overrides});

test('review cards prioritize decisions and sort by receipt, not operation date',()=>{
 const cards=buildReviewCards(input({proposals:[proposal('old-business-date','2026-01-01','2026-10-28T12:00:00Z'),proposal('new-business-date','2026-10-27','2026-10-27T12:00:00Z')],texts:[text('unrelated','2026-10-26')]}));
 assert.deepEqual(cards.map(card=>card.id),['proposal:old-business-date','proposal:new-business-date','text:unrelated']);
});

test('photo and exact text are shown inside their one proposal; ambiguous same-day trades stay visible',()=>{
 const photo={upload_id:'photo-1',owner:'Jorge',file_name:'order.jpg',created_at:'2026-10-28T12:00:00Z',status:'stored',proposal_evidence_status:'linked'};
 const single=buildReviewCards(input({proposals:[proposal('one','2026-10-27')],texts:[text('text-1','2026-10-27')],photos:[photo]}));
 assert.equal(single.length,1);assert.equal(single[0].related_texts[0].id,'text-1');assert.equal(single[0].related_photos[0].upload_id,'photo-1');
 const ambiguous=buildReviewCards(input({proposals:[proposal('one','2026-10-27'),proposal('two','2026-10-27')],texts:[text('text-1','2026-10-27')]}));
 assert.equal(ambiguous.find(card=>card.id==='text:text-1')?.lane,'evidence');
 assert.equal(ambiguous.filter(card=>card.kind==='proposal').length,2);
});

test('custody label uses institution rather than raw account scope and marks internal reference only if needed',()=>{
 const p=proposal('one','2026-10-27');const positions=[{owner:'Jorge',account_id:'account-1',institution:'Itaú Corretora de Valores',instrument_code:'CSAN3',currency:'BRL'}];
 assert.equal(custodyLabel(p,positions),'Itaú Corretora de Valores');
 assert.match(custodyLabel(p,positions,2),/ref\. interna/);
});

test('a recorded keep-open answer moves to follow-up rather than asking again',()=>{
 const confirmation={id:'quote-refresh',owner:'Jorge',category:'Valoración',title:'Actualizar cotizaciones',context:{},evidence:[],actions:[{key:'refresh',label:'Actualizar',keeps_open:true},{key:'accept',label:'Aceptar'}],status:'open',created_at:'2026-10-24T12:00:00Z',updated_at:'2026-10-28T12:00:00Z',decision:{action_key:'refresh',note:null,decided_at:'2026-10-28T12:00:00Z'}};
 const card=buildReviewCards(input({confirmations:[confirmation]}))[0];assert.equal(card.lane,'follow_up');assert.equal(card.status,'in_follow_up');
 const resolved=buildReviewCards(input({confirmations:[{...confirmation,status:'resolved'}]}))[0];assert.equal(resolved.lane,'history');
});
