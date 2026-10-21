import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {once} from 'node:events';
import {Ajv2020} from 'ajv/dist/2020.js';
import {randomUUID} from 'node:crypto';
import {pool,migrate} from '../src/db.ts';
import {approve,Conflict} from '../src/commands.ts';
import {summaryHash,hash,importEnvelope,publish,type Envelope} from '../src/migration.ts';
import {portfolio,positionPage} from '../src/queries.ts';
import {answerGuided,chatHistory,classify,sendChat} from '../src/conversation.ts';
import {confirmSameAccount} from '../src/resolution.ts';
import {recordText,textStatus} from '../src/manual-intake.ts';
import {receiveMarketEvent} from '../src/market-bridge.ts';
import {listB3DuplicateMovementCandidates,recordB3DuplicateMovementDecision} from '../src/b3-duplicate-candidates.ts';
const database='juanca_test_'+randomUUID().replaceAll('-','');
const admin=pool('jorge','postgres');const db=pool('juanca_app',database);const migrator=pool('jorge',database);
before(async()=>{assert.match(database,/^juanca_test_[0-9a-f]+$/);await admin.query('CREATE DATABASE "'+database+'"');await migrator.query(await readFile(new URL('../../../infra/postgres/roles.sql',import.meta.url),'utf8'));await migrate(db);});
after(async()=>{await db.end();await migrator.end();await admin.query('DROP DATABASE "'+database+'"');await admin.end();});
test('written movement is retained once as review evidence without changing the portfolio',async()=>{
 const h='intake-'+randomUUID();await db.query('INSERT INTO app.households VALUES($1)',[h]);await db.query("INSERT INTO app.owners VALUES($1,'jorge','Jorge')",[h]);await db.query('INSERT INTO app.household_state(household_id) VALUES($1)',[h]);
 const input={request_id:'manual-test-001',owner:'Jorge',text:'Compré una participación',occurred_on:'2026-10-10'};
 const first=await recordText(db,h,input);const replay=await recordText(db,h,input);
 assert.equal(first.status,'awaiting_review');assert.equal(replay.replayed,true);assert.equal(replay.intake_id,first.intake_id);
 const saved=await textStatus(db,h,first.intake_id);assert.equal(saved.original_text,input.text);assert.equal(saved.occurred_on,input.occurred_on);
 await assert.rejects(()=>recordText(db,h,{...input,text:'Vendí una participación'}),(e:unknown)=>e instanceof Conflict&&e.code==='IDEMPOTENCY_MISMATCH');
 assert.equal((await db.query('SELECT count(*) FROM app.manual_intakes WHERE household_id=$1',[h])).rows[0].count,'1');
 assert.equal((await db.query('SELECT facts_revision FROM app.household_state WHERE household_id=$1',[h])).rows[0].facts_revision,'0');
});
test('overlapping B3 movement decisions are append-only, idempotent review evidence',async()=>{
 const h='b3-overlap-'+randomUUID(),actor='reviewer-'+randomUUID();
 await db.query('INSERT INTO app.households VALUES($1)',[h]);await db.query('INSERT INTO app.actors VALUES($1,$2)',[actor,'B3 reviewer']);await db.query("INSERT INTO app.memberships VALUES($1,$2,'owner')",[h,actor]);await db.query("INSERT INTO app.owners VALUES($1,'jorge','Jorge')",[h]);await db.query('INSERT INTO app.household_state(household_id) VALUES($1)',[h]);
 for(const [id,name,digest] of [['doc-a','movement-a.xlsx','a'.repeat(64)],['doc-b','movement-b.xlsx','b'.repeat(64)]]){
  await db.query("INSERT INTO app.source_documents(household_id,id,owner_id,source_system,report_kind,original_name,content_sha256,storage_key,coverage_start,coverage_end,date_basis) VALUES($1,$2,'jorge','B3','movement',$3,$4,$2,'2026-08-18','2026-09-17','report_window')",[h,id,name,digest]);
 }
 for(const [id,doc,row] of [['assert-a','doc-a',2],['assert-b','doc-b',2]])await db.query("INSERT INTO app.source_assertions(household_id,id,document_id,owner_id,source_sheet,source_row,assertion_kind,asserted_on,source_event_type,direction,quantity,raw_row,interpretation_status) VALUES($1,$2,$3,'jorge','Movimentação',$4,'movement','2026-09-02','Compra','Crédito',5,'{\"Ativo\":\"TEST11\",\"Quantidade\":\"5\"}'::jsonb,'observed')",[h,id,doc,row]);
 const initial=await listB3DuplicateMovementCandidates(db,h,10);assert.equal(initial.count,1);assert.equal(initial.candidates[0].review_status,'needs_review');const candidate=initial.candidates[0];
 const body={request_key:'review-b3-pair-001',left_assertion_id:'assert-a',right_assertion_id:'assert-b',candidate_key:candidate.candidate_key,decision:'same_event' as const};
 const first=await recordB3DuplicateMovementDecision(db,h,actor,body),replay=await recordB3DuplicateMovementDecision(db,h,actor,body);assert.equal(first.replayed,false);assert.equal(replay.replayed,true);assert.equal(replay.decision_id,first.decision_id);
 const reviewed=await listB3DuplicateMovementCandidates(db,h,10);assert.equal(reviewed.candidates[0].review_status,'reviewed');assert.equal(reviewed.candidates[0].link_decisions[0].review.decision,'same_event');assert.equal(reviewed.candidates[0].event_count_status,'reconciled');assert.equal(reviewed.candidates[0].preview_event_count,1);
 const correction=await recordB3DuplicateMovementDecision(db,h,actor,{...body,request_key:'review-b3-pair-002',decision:'distinct_events'});assert.equal(correction.revision,2);assert.equal((await db.query('SELECT supersedes_id FROM app.source_assertion_link_decisions WHERE household_id=$1 AND id=$2',[h,correction.decision_id])).rows[0].supersedes_id,first.decision_id);
 const corrected=await listB3DuplicateMovementCandidates(db,h,10);assert.equal(corrected.candidates[0].event_count_status,'reconciled');assert.equal(corrected.candidates[0].preview_event_count,2);
 await assert.rejects(()=>db.query('UPDATE app.source_assertion_link_decisions SET decision=\'same_event\' WHERE household_id=$1 AND id=$2',[h,first.decision_id]),/SOURCE_ASSERTION_LINK_DECISIONS_APPEND_ONLY/);
 assert.equal((await db.query('SELECT facts_revision FROM app.household_state WHERE household_id=$1',[h])).rows[0].facts_revision,'0');assert.equal((await db.query("SELECT count(*) FROM app.audit_log WHERE household_id=$1 AND action='b3_duplicate_movement_link_decision'",[h])).rows[0].count,'2');
});
test('guided chat transaction creates one manual evidence record for a known owner',async()=>{
 const h='chat-intake-'+randomUUID();await db.query('INSERT INTO app.households VALUES($1)',[h]);await db.query("INSERT INTO app.owners VALUES($1,'jorge','Jorge')",[h]);await db.query('INSERT INTO app.household_state(household_id) VALUES($1)',[h]);
 const input={request_id:'chat-trade-001',owner:'Jorge',message:'Compré 1 PETR4'};await sendChat(db,h,input);await sendChat(db,h,input);
 const result=await db.query('SELECT original_text,status FROM app.manual_intakes WHERE household_id=$1',[h]);assert.equal(result.rowCount,1);assert.equal(result.rows[0].original_text,input.message);assert.equal(result.rows[0].status,'awaiting_review');
 assert.equal((await db.query('SELECT facts_revision FROM app.household_state WHERE household_id=$1',[h])).rows[0].facts_revision,'0');
});
test('market outbox event is received once without publishing a portfolio revision',async()=>{
 const event={id:'1',event_id:randomUUID(),event_type:'market.observations.published',payload:{status:'succeeded',quotes:[{market_code:'B3' as const,symbol:'PETR4',currency:'BRL' as const,price:'39.99',provider:'fixture',observed_at:'2026-10-09T18:00:00-03:00'}],fx:[{pair:'USD/BRL' as const,rate:'5.25',provider:'fixture',observed_at:'2026-10-09'}]}};
 const first=await receiveMarketEvent(db,event),again=await receiveMarketEvent(db,event);assert.equal(first.quotes,1);assert.equal(again.replayed,true);
 assert.equal((await db.query('SELECT count(*)::int n FROM app.market_quote_observations')).rows[0].n,1);
 assert.equal((await db.query('SELECT count(*)::int n FROM app.market_fx_observations')).rows[0].n,1);
 assert.equal((await db.query('SELECT count(*)::int n FROM app.portfolio_versions')).rows[0].n,0);
});
async function fixture(){
 const h='fixture-'+randomUUID();const actor='actor-'+h;await db.query('INSERT INTO app.households VALUES($1)',[h]);await db.query('INSERT INTO app.actors VALUES($1,$2)',[actor,'Explicit fixture actor']);await db.query("INSERT INTO app.memberships VALUES($1,$2,'owner')",[h,actor]);await db.query("INSERT INTO app.owners VALUES($1,'owner1','Fixture')",[h]);await db.query("INSERT INTO app.accounts VALUES($1,'account1','owner1','fixture','known')",[h]);await db.query('INSERT INTO app.household_state(household_id) VALUES($1)',[h]);await db.query("INSERT INTO app.holdings VALUES($1,'account1','PETR4','BRL',10,'verified'),($1,'account1','BRL_CASH','BRL',1000,'verified')",[h]);
 const summary=summaryHash({owner_id:'owner1',account_id:'account1',instrument_code:'PETR4',side:'sell',quantity:'7',unit_price:'30',currency:'BRL',effective_date:'2026-08-02',fees_minor:'100'});
 for(const id of ['p1','p2'])await db.query("INSERT INTO app.proposals(household_id,id,owner_id,account_id,instrument_code,currency,side,quantity,unit_price,fees_minor,effective_date,summary_hash,status) VALUES($1,$2,'owner1','account1','PETR4','BRL','sell',7,30,100,'2026-08-02',$3,'pending')",[h,id,summary]);
 return {h,actor,body:{version:1,summary_hash:summary,expected_facts_revision:'0'}};
}
test('real PostgreSQL serializes concurrent sales, replay and ledger/cash/audit in one commit',async()=>{
 const f=await fixture();const results=await Promise.allSettled(['p1','p2'].map(id=>approve(db,f.h,f.actor,id,'command-'+id,f.body)));assert.equal(results.filter(r=>r.status==='fulfilled').length,1);const winner=results[0].status==='fulfilled'?'p1':'p2';const loser=winner==='p1'?'p2':'p1';const failed=results.find(r=>r.status==='rejected') as PromiseRejectedResult;assert.equal(failed.reason.code,'STALE_PORTFOLIO');
 const replay=await approve(db,f.h,f.actor,winner,'command-'+winner,f.body);assert.equal(replay.replayed,true);await assert.rejects(()=>approve(db,f.h,f.actor,winner,'command-'+winner,{...f.body,version:2}),(e:unknown)=>e instanceof Conflict&&e.code==='IDEMPOTENCY_MISMATCH');
 await assert.rejects(()=>approve(db,f.h,f.actor,loser,'new-key-'+loser,{...f.body,expected_facts_revision:'1'}),(e:unknown)=>e instanceof Conflict&&e.code==='INSUFFICIENT_POSITION');
 const rows=await db.query('SELECT instrument_code,quantity FROM app.holdings WHERE household_id=$1',[f.h]);assert.equal(rows.rows.find(r=>r.instrument_code==='PETR4').quantity,'3');assert.equal(rows.rows.find(r=>r.instrument_code==='BRL_CASH').quantity,'1209');
 for(const [table,count] of [['events','1'],['event_legs','3'],['audit_log','1']])assert.equal((await db.query('SELECT count(*) FROM app.'+table+' WHERE household_id=$1',[f.h])).rows[0].count,count);
});
test('failed audit rolls back event, cash, revision, proposal and idempotency result',async()=>{
 const f=await fixture();await db.query(`CREATE OR REPLACE FUNCTION app.test_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.household_id='${f.h}' THEN RAISE EXCEPTION 'fixture failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fixture_audit_failure BEFORE INSERT ON app.audit_log FOR EACH ROW EXECUTE FUNCTION app.test_fail_audit()`);
 try{await assert.rejects(()=>approve(db,f.h,f.actor,'p1','rollback01',f.body));assert.equal((await db.query('SELECT facts_revision FROM app.household_state WHERE household_id=$1',[f.h])).rows[0].facts_revision,'0');assert.equal((await db.query('SELECT count(*) FROM app.events WHERE household_id=$1',[f.h])).rows[0].count,'0');assert.equal((await db.query("SELECT quantity FROM app.holdings WHERE household_id=$1 AND instrument_code='PETR4'",[f.h])).rows[0].quantity,'10');assert.equal((await db.query("SELECT quantity FROM app.holdings WHERE household_id=$1 AND instrument_code='BRL_CASH'",[f.h])).rows[0].quantity,'1000');assert.equal((await db.query('SELECT count(*) FROM app.command_results WHERE household_id=$1',[f.h])).rows[0].count,'0');assert.equal((await db.query("SELECT status FROM app.proposals WHERE household_id=$1 AND id='p1'",[f.h])).rows[0].status,'pending');}finally{await db.query('DROP TRIGGER fixture_audit_failure ON app.audit_log; DROP FUNCTION app.test_fail_audit()');}
});
test('unknown cash/account and changed summary block approval; family membership scopes the actor',async()=>{
 const f=await fixture();await assert.rejects(()=>approve(db,f.h,'foreign','p1','foreign01',f.body),(e:unknown)=>e instanceof Conflict&&e.code==='FORBIDDEN');await assert.rejects(()=>approve(db,f.h,f.actor,'p1','changed01',{...f.body,summary_hash:'other'}),(e:unknown)=>e instanceof Conflict&&e.code==='PROPOSAL_CHANGED');await db.query("UPDATE app.holdings SET coverage_status='unresolved' WHERE household_id=$1 AND instrument_code='BRL_CASH'",[f.h]);await assert.rejects(()=>approve(db,f.h,f.actor,'p1','unknown01',f.body),(e:unknown)=>e instanceof Conflict&&e.code==='UNKNOWN_CASH');await db.query("UPDATE app.accounts SET identity_status='unresolved' WHERE household_id=$1",[f.h]);await assert.rejects(()=>approve(db,f.h,f.actor,'p1','unknown02',f.body),(e:unknown)=>e instanceof Conflict&&e.code==='UNRESOLVED_ACCOUNT');
});
test('database rejects excess scale and NaN; application role cannot read other service schemas',async()=>{
 for(const value of ['0.00000000001','NaN','1000000000000000000'])await assert.rejects(()=>db.query('SELECT $1::app.exact_decimal',[value]));const other=pool('juanca_market',database);try{await assert.rejects(()=>other.query('SELECT * FROM app.households'));await assert.rejects(()=>db.query('CREATE TABLE market.invalid(id int)'));}finally{await other.end();}
});
test('immutable portfolio cursor fixes its version across refresh and rejects other households and tampering',async()=>{
 const f=await fixture();const version=hash('first'+f.h);const newer=hash('next'+f.h);const view={positions:[{owner:'Fixture',instrument_code:'PETR4'},{owner:'Fixture',instrument_code:'VALE3'}],total_value_cents:'30000'};
 for(const id of [version,newer])await db.query("INSERT INTO app.portfolio_versions(household_id,id,facts_revision,market_revision,calculation_version,effective_as_of,known_at,view) VALUES($1,$2,0,'fixture','fixture','2026-08-01',now(),$3)",[f.h,id,view]);await db.query('UPDATE app.household_state SET latest_version=$2 WHERE household_id=$1',[f.h,version]);
 const first=await positionPage(db,f.h,'fixture-secret',{limit:1});await db.query('UPDATE app.household_state SET latest_version=$2 WHERE household_id=$1',[f.h,newer]);const next=await positionPage(db,f.h,'fixture-secret',{cursor:first.next_cursor!,limit:1});assert.equal(next.portfolio_version,version);assert.equal(next.positions[0].instrument_code,'VALE3');await assert.rejects(()=>positionPage(db,f.h,'fixture-secret',{cursor:first.next_cursor!+'x'}));const other=await fixture();await assert.rejects(()=>positionPage(db,other.h,'fixture-secret',{cursor:first.next_cursor!}));await assert.rejects(()=>portfolio(db,other.h,version),(e:unknown)=>e instanceof Conflict&&e.code==='NOT_FOUND');
});

test('evidence migration is atomic, hash-checked and idempotent; historic publication keeps current pointer',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'juanca-fixture-import-'));
 try{
  const h='migration-fixture-'+randomUUID();
  const tables={imports:[{id:'fixture-import',user_id:h,owner:'Fixture',status:'processed',file_type:'positions',reference_date:'2026-08-01',created_at:'2026-08-02 00:00:00'}],import_records:[{id:1,import_id:'fixture-import',record_kind:'position',payload:JSON.stringify({owner:'Fixture',currency:'BRL',instrument_code:'PETR4',quantity:'0.3',unit_price:'30',market_value_cents:'900',reference_date:'2026-08-01'})}],market_quotes:[],fx_observations:[],portfolio_revisions:[{user_id:h,revision:0}],transaction_proposals:[],review_decisions:[],cost_basis:[],chat_messages:[],proposal_applications:[]};
  const content={format:1,tables,conversation_archive:[]};const canonical=JSON.stringify(content);const envelope={source_sha256:hash(canonical),exported_at:'2026-08-03T00:00:00.000Z',canonical_content:canonical,content};const path=join(dir,'fixture.json');await writeFile(path,JSON.stringify(envelope),{mode:0o600});
  const first=await importEnvelope(db,path);assert.equal(first.replayed,false);assert.equal((await importEnvelope(db,path)).replayed,true);assert.equal((await db.query('SELECT count(*) FROM app.received_sources WHERE run_id=$1',[first.run_id])).rows[0].count,'3');assert.equal((await db.query('SELECT source_envelope FROM app.migration_runs WHERE id=$1',[first.run_id])).rows[0].source_envelope,canonical);
  const published=await publish(db,first.run_id,h,'2026-08-03',envelope.exported_at);assert.equal(published.view.positions[0].quantity,'0.3');assert.equal(published.view.identity_complete,false);await publish(db,first.run_id,h,'2026-08-01',envelope.exported_at);assert.equal((await portfolio(db,h)).portfolio_version,published.portfolio_version);
  await writeFile(path,JSON.stringify({...envelope,source_sha256:'invalid'}));await assert.rejects(()=>importEnvelope(db,path),/SOURCE_HASH_MISMATCH/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('HTTP contract validates authenticated immutable views, cursor pages, errors and read-only shadow writes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'juanca-fixture-http-'));const h='http-fixture-'+randomUUID();
 const content={format:1,tables:{imports:[{id:'fixture',user_id:h,owner:'Fixture',status:'processed',file_type:'positions',reference_date:'2026-08-01',created_at:'2026-08-02 00:00:00'}],import_records:[1,2].map(id=>({id,import_id:'fixture',record_kind:'position',payload:JSON.stringify({owner:'Fixture',account:'fixture-account',currency:'BRL',instrument_code:'FIXTURE'+id,quantity:'0.3',unit_price:'30',market_value_cents:'900',reference_date:'2026-08-01'})})),market_quotes:[],fx_observations:[],portfolio_revisions:[{user_id:h,revision:0}],transaction_proposals:[],review_decisions:[],cost_basis:[],chat_messages:[],proposal_applications:[]},conversation_archive:[]};const canonical=JSON.stringify(content);const path=join(dir,'fixture.json');await writeFile(path,JSON.stringify({source_sha256:hash(canonical),exported_at:'2026-08-03T00:00:00.000Z',canonical_content:canonical,content}));const run=await importEnvelope(db,path);await publish(db,run.run_id,h,'2026-08-03','2026-08-03T00:00:00.000Z');
 const ownerId=(await db.query('SELECT id FROM app.owners WHERE household_id=$1 LIMIT 1',[h])).rows[0].id,reviewer='http-reviewer-'+randomUUID();await db.query('INSERT INTO app.actors VALUES($1,$2)',[reviewer,'HTTP review fixture']);await db.query("INSERT INTO app.memberships VALUES($1,$2,'reviewer')",[h,reviewer]);
 for(const [id,name,digest] of [['http-doc-a','http-movement-a.xlsx','c'.repeat(64)],['http-doc-b','http-movement-b.xlsx','d'.repeat(64)]])await db.query('INSERT INTO app.source_documents(household_id,id,owner_id,source_system,report_kind,original_name,content_sha256,storage_key,coverage_start,coverage_end,date_basis) VALUES($1,$2,$3,\'B3\',\'movement\',$4,$5,$2,\'2026-07-01\',\'2026-08-01\',\'report_window\')',[h,id,ownerId,name,digest]);
 for(const [id,doc] of [['http-assert-a','http-doc-a'],['http-assert-b','http-doc-b']])await db.query("INSERT INTO app.source_assertions(household_id,id,document_id,owner_id,source_sheet,source_row,assertion_kind,asserted_on,direction,quantity,raw_row,interpretation_status) VALUES($1,$2,$3,$4,'Movimentação',2,'movement','2026-07-15','Crédito',3,'{\"Ativo\":\"HTTP11\",\"Quantidade\":\"3\"}'::jsonb,'observed')",[h,id,doc,ownerId]);
 const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=(reservation.address() as {port:number}).port;await new Promise<void>(resolve=>reservation.close(()=>resolve()));const token=randomUUID()+randomUUID();const config=join(dir,'config.json');await writeFile(config,JSON.stringify({household_id:h,token,cursor_key:randomUUID()+randomUUID(),port}),{mode:0o600});
 const child=spawn(process.execPath,['--experimental-strip-types',new URL('../src/server.ts',import.meta.url).pathname],{env:{...process.env,JUANCA_DATABASE:database,JUANCA_SHADOW_CONFIG:config},stdio:'ignore'});
 try{
  const base='http://127.0.0.1:'+port;let ready=false;for(let i=0;i<50;i++){try{if((await fetch(base+'/health/ready')).ok){ready=true;break;}}catch{}await delay(100);}assert.ok(ready,'Synthetic HTTP service must start');
  const schema=JSON.parse(await readFile(new URL('../../../packages/contracts/portfolio-v1.schema.json',import.meta.url),'utf8'));const ajv=new Ajv2020({strict:true});ajv.addSchema(schema);const validate=(name:string,body:unknown)=>{const validator=ajv.getSchema(schema.$id+'#/$defs/'+name)!;assert.ok(validator(body),JSON.stringify(validator.errors));};
  const unauthorized=await fetch(base+'/v1/portfolio');assert.equal(unauthorized.status,401);validate('Error',await unauthorized.json());
  const headers={Authorization:'Bearer '+token};const reviewHeaders={...headers,'x-juanca-actor':reviewer};const response=await fetch(base+'/v1/portfolio',{headers});assert.equal(response.status,200);const view=await response.json() as {portfolio_version:string};validate('Portfolio',view);
  const candidatesResponse=await fetch(base+'/v1/reconciliation/b3/duplicate-movements',{headers});assert.equal(candidatesResponse.status,200);const candidatesBody=await candidatesResponse.json() as {candidates:Array<{candidate_key:string;review_status:string;evidence:Array<{assertion_id:string}>}>;portfolio_published:boolean};assert.equal(candidatesBody.candidates.length,1);assert.equal(candidatesBody.candidates[0].review_status,'needs_review');assert.equal(candidatesBody.portfolio_published,false);
  const pair=candidatesBody.candidates[0],decisionResponse=await fetch(base+'/v1/reconciliation/b3/duplicate-movement-decisions',{method:'POST',headers:{...reviewHeaders,'Content-Type':'application/json'},body:JSON.stringify({request_key:'http-review-pair-001',left_assertion_id:pair.evidence[0].assertion_id,right_assertion_id:pair.evidence[1].assertion_id,candidate_key:pair.candidate_key,decision:'same_event'})});assert.equal(decisionResponse.status,201);const decisionBody=await decisionResponse.json() as {decision_id:string;decision:string;revision:number;portfolio_changed:boolean};assert.equal(decisionBody.decision,'same_event');assert.equal(decisionBody.revision,1);assert.equal(decisionBody.portfolio_changed,false);
  const reviewedResponse=await fetch(base+'/v1/reconciliation/b3/duplicate-movements',{headers});const reviewedBody=await reviewedResponse.json() as typeof candidatesBody;assert.equal(reviewedBody.candidates[0].review_status,'reviewed');assert.equal((await db.query('SELECT facts_revision FROM app.household_state WHERE household_id=$1',[h])).rows[0].facts_revision,'0');
  const page=await fetch(base+'/v1/positions?limit=1',{headers});assert.equal(page.status,200);const body=await page.json() as {next_cursor:string;portfolio_version:string};validate('PositionPage',body);assert.equal(body.portfolio_version,view.portfolio_version);assert.ok(body.next_cursor);
  const next=await fetch(base+'/v1/positions?cursor='+encodeURIComponent(body.next_cursor),{headers});validate('PositionPage',await next.json());
  for(const [path,status] of [['/v1/positions?limit=0',422],['/v1/positions?cursor=invalid',422],['/v1/portfolio?portfolio_version='+hash('foreign'),404]]){const r=await fetch(base+path,{headers});assert.equal(r.status,status);validate('Error',await r.json());}
  const chatPath='/v1/conversations/family/messages';const chatBody={request_id:'httpchat01',message:'Qual o patrimônio?',owner:'family'};
  const send=()=>fetch(base+chatPath,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(chatBody)});
  const chat=await send();assert.equal(chat.status,200);const reply=await chat.json() as {messages:Array<{role:string;content:string}>;replayed:boolean};assert.equal(reply.replayed,false);validate('ChatResponse',reply);assert.equal(reply.messages.length,2);assert.match(reply.messages[1].content,/sombra|Cobertura incompleta/);
  const replay=await send();assert.equal(replay.status,200);const replayBody=await replay.json() as {replayed:boolean};validate('ChatResponse',replayBody);assert.equal(replayBody.replayed,true);
  const history=await fetch(base+chatPath,{headers});const historyBody=await history.json() as {messages:unknown[]};validate('ChatResponse',historyBody);assert.equal(historyBody.messages.length,2);
  const forged=await fetch(base+chatPath,{method:'POST',headers:{...headers,'Content-Type':'application/json',Origin:'http://evil.local'},body:JSON.stringify(chatBody)});assert.equal(forged.status,403);
  const financial=(await db.query('SELECT count(*) FROM app.events WHERE household_id=$1',[h])).rows[0].count;assert.equal(financial,'0');
  const write=await fetch(base+'/v1/proposals/p1/approve',{method:'POST',headers});assert.equal(write.status,405);const error=await write.json() as {code:string};validate('Error',error);assert.equal(error.code,'SHADOW_READ_ONLY');
 }finally{child.kill('SIGTERM');await once(child,'exit');await rm(dir,{recursive:true,force:true});}
});

test('relational identities reject an account belonging to another owner even within the same household',async()=>{
 const f=await fixture();await db.query("INSERT INTO app.owners VALUES($1,'owner2','Other fixture')",[f.h]);await assert.rejects(()=>db.query("UPDATE app.proposals SET owner_id='owner2' WHERE household_id=$1 AND id='p1'",[f.h]));assert.equal((await db.query("SELECT owner_id FROM app.proposals WHERE household_id=$1 AND id='p1'",[f.h])).rows[0].owner_id,'owner1');
});

test('guided conversation stores idempotent requests without modifying financial tables',async()=>{
 const f=await fixture();
 assert.equal(classify('Compré 2 PETR4'),'transaction');assert.equal(classify('Aprobar proposta'),'decision');
 const request={request_id:'decision01',message:'Aprobar proposta',owner:'Jorge'};
 const first=await sendChat(db,f.h,request);assert.equal(first.replayed,false);assert.equal(first.messages.length,2);assert.equal(first.messages[1].role,'assistant');assert.equal(first.messages[1].actions?.[0]?.type,'open_transactions');
 const replay=await sendChat(db,f.h,request);assert.equal(replay.replayed,true);assert.equal(replay.messages.length,2);
 await assert.rejects(()=>sendChat(db,f.h,{...request,message:'Outro'}),(e:unknown)=>e instanceof Conflict&&e.code==='IDEMPOTENCY_MISMATCH');
 assert.equal((await db.query('SELECT count(*) FROM app.events WHERE household_id=$1',[f.h])).rows[0].count,'0');
 assert.equal((await db.query('SELECT count(*) FROM app.audit_log WHERE household_id=$1',[f.h])).rows[0].count,'0');
 assert.equal((await db.query('SELECT facts_revision FROM app.household_state WHERE household_id=$1',[f.h])).rows[0].facts_revision,'0');
});
test('guided financial answer uses immutable shadow evidence, exact strings and incomplete-coverage wording',async()=>{
 const f=await fixture();const version=hash('conversation-view-'+f.h);
 await db.query("INSERT INTO app.portfolio_versions(household_id,id,facts_revision,market_revision,calculation_version,effective_as_of,known_at,view) VALUES($1,$2,0,'fixture','fixture','2026-08-01',now(),$3)",[f.h,version,{positions:[{owner:'Jorge',instrument_code:'FIXTURE',quantity:'0.3',currency:'BRL',market_value_cents:'9007199254740993',market_value_minor:'9007199254740993',price_as_of:'2026-08-01'},{owner:'Julia',instrument_code:'USD_CASH',quantity:'1',currency:'USD',market_value_cents:null,market_value_minor:'100',price_as_of:'2026-08-01'}],valuation_complete:false,identity_complete:false,issues:[{code:'missing_fx'}]}]);
 await db.query('UPDATE app.household_state SET latest_version=$2 WHERE household_id=$1',[f.h,version]);
 const result=await answerGuided(db,f.h,{request_id:'wealth001',message:'Qual o patrimônio?',owner:'family'});
 assert.equal(result.evidence?.portfolio_version,version);assert.match(result.content,/Cobertura incompleta/);assert.match(result.content,/90\.071\.992\.547\.409,93/);
 const action=await answerGuided(db,f.h,{request_id:'action01',message:'Vendi 2 FIXTURE a R$ 30 em 02/08/2026',owner:'Jorge'});
 assert.equal(action.actions[0]?.type,'prepare_transaction');assert.match(action.content,/sombra/);
 const costs=await answerGuided(db,f.h,{request_id:'costs001',message:'Qual o custo de FIXTURE?',owner:'Jorge'});assert.match(costs.content,/ainda não foram migrados/);
});
test('expired conversation lease cannot duplicate an answer and archive retains only conversational history',async()=>{
 const f=await fixture();await db.query("INSERT INTO app.conversations VALUES($1,'family',now())",[f.h]);
 await db.query("INSERT INTO app.conversation_requests(household_id,id,conversation_id,request_hash,status,lease_token,started_at) VALUES($1,'stale001','family',$2,'processing','old-lease',now()-interval '2 minutes')",[f.h,hash(JSON.stringify(['ajuda','family']))]);
 const answer=await sendChat(db,f.h,{request_id:'stale001',message:'ajuda',owner:'family'});assert.equal(answer.messages.filter(m=>m.role==='assistant').length,1);
 const run=hash('archive-'+f.h);await db.query("INSERT INTO app.migration_runs(id,source_sha256,exported_at,source_counts,source_envelope) VALUES($1,$1,now(),'{}','{}')",[run]);
 await db.query("INSERT INTO app.conversation_archives(run_id,household_id,id,origin,original) VALUES($1,$2,'legacy1','hermes_archive',$3),($1,$2,'legacy2','hermes_archive',$4)",[run,f.h,JSON.stringify({id:'legacy1',role:'assistant',content:'Arquivo',origin:'hermes_archive',metadata:'{}',created_at:1}),JSON.stringify({id:'legacy2',role:'tool',content:'não visível',origin:'hermes_archive',metadata:'{}',created_at:2})]);
 const history=await chatHistory(db,f.h);assert.ok(history.some(m=>m.content==='Arquivo'&&m.origin==='hermes_archive'));assert.ok(!history.some(m=>m.content==='não visível'));
});

test('explicit account confirmation is scoped, audited, idempotent and changes only a new shadow version',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'juanca-account-confirm-'));
 try{
  const h='account-confirm-'+randomUUID();const imports=[{id:'snapshot-import',user_id:h,owner:'Jorge',status:'processed',file_type:'positions',reference_date:'2026-08-01',created_at:'2026-08-02 00:00:00'},{id:'trade-import',user_id:h,owner:'Jorge',status:'processed',file_type:'chat_transaction',reference_date:'2026-10-05',created_at:'2026-10-06 00:00:00'}];
  const position={owner:'Jorge',account:'evidence-account',currency:'BRL',instrument_code:'SMAL11',quantity:'10',unit_price:'30',market_value_cents:'30000',reference_date:'2026-08-01'};
  const trade={owner:'Jorge',account:null,currency:'BRL',instrument_code:'SMAL11',quantity:'2',unit_price:'30',side:'sell',trade_date:'2026-10-05'};
  const tables={imports,import_records:[{id:1,import_id:'snapshot-import',record_kind:'position',payload:JSON.stringify(position)},{id:2,import_id:'trade-import',record_kind:'trade',payload:JSON.stringify(trade)}],market_quotes:[],fx_observations:[],portfolio_revisions:[{user_id:h,revision:0}],transaction_proposals:[],review_decisions:[],cost_basis:[],chat_messages:[],proposal_applications:[]};const content={format:1,tables,conversation_archive:[]};const canonical=JSON.stringify(content);const file=join(dir,'fixture.json');await writeFile(file,JSON.stringify({source_sha256:hash(canonical),exported_at:'2026-10-09T00:00:00.000Z',canonical_content:canonical,content}));
  const run=await importEnvelope(db,file);const original=await publish(db,run.run_id,h,'2026-10-09','2026-10-09T00:00:00.000Z');assert.equal(original.view.positions[0].quantity,'10');assert.ok(original.view.issues.some(i=>i.code==='unresolved_trade_account'));
  const command={run:run.run_id,household:h,trade_record_id:'2',snapshot_id:'snapshot-import:1'};
  await assert.rejects(()=>confirmSameAccount(db,{...command,snapshot_id:'wrong'}),(e:unknown)=>e instanceof Conflict&&e.code==='NOT_FOUND');
  assert.equal((await confirmSameAccount(db,command)).replayed,false);assert.equal((await confirmSameAccount(db,command)).replayed,true);
  const reconciled=await publish(db,run.run_id,h,'2026-10-09','2026-10-09T00:00:00.000Z');assert.equal(reconciled.view.positions[0].quantity,'8');assert.notEqual(reconciled.portfolio_version,original.portfolio_version);assert.equal((await portfolio(db,h,original.portfolio_version)).positions[0].quantity,'10');
  assert.equal((await db.query('SELECT count(*) FROM app.account_resolutions WHERE household_id=$1',[h])).rows[0].count,'1');
  assert.equal((await db.query('SELECT count(*) FROM app.audit_log WHERE household_id=$1 AND action=$2',[h,'account_resolution_confirmed'])).rows[0].count,'1');
  assert.equal((await db.query('SELECT facts_revision FROM app.household_state WHERE household_id=$1',[h])).rows[0].facts_revision,'1');
  assert.equal((await db.query('SELECT count(*) FROM app.events WHERE household_id=$1 AND application_status=$2',[h,'applied'])).rows[0].count,'0');
 }finally{await rm(dir,{recursive:true,force:true});}
});
