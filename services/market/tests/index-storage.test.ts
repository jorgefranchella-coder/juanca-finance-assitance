import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {pool as appPool} from '../../application/src/db.ts';
import {pool as marketPool} from '../src/db.ts';
import {fetchBcbSelicDaily} from '../src/bcb-selic.ts';
import {listSelicObservations,storeSelicImport,listDiObservations,storeDiImport} from '../src/index-storage.ts';
import {listCalendar,storeCalendar} from '../src/calendar-storage.ts';
import {accumulateBusiness252} from '../../application/src/business-252.ts';

const database='juanca_test_'+randomUUID().replaceAll('-',''),admin=appPool('jorge','postgres'),migrator=appPool('jorge',database),db=marketPool('juanca_market',database);
before(async()=>{assert.match(database,/^juanca_test_[0-9a-f]+$/);await admin.query('CREATE DATABASE "'+database+'"');await migrator.query(await readFile(new URL('../../../infra/postgres/roles.sql',import.meta.url),'utf8'));await migrator.query('GRANT CREATE ON DATABASE "'+database+'" TO juanca_market');for(const id of ['005_market','006_market_run_identity','007_market_index_observations','008_market_calendars','009_market_di'])await db.query(await readFile(new URL('../../../infra/postgres/'+id+'.sql',import.meta.url),'utf8'));});
after(async()=>{await db.end();await migrator.end();await admin.query('DROP DATABASE "'+database+'"');await admin.end();});

test('SELIC imports are idempotent, versioned, and immutable within the market database',async()=>{
 const fetchRate=(rate:string)=>fetchBcbSelicDaily('2026-01-02','2026-01-02',async()=>new Response(JSON.stringify([{data:'02/01/2026',valor:rate}])));
 const firstData=await fetchRate('0.055131'),first=await storeSelicImport(db,firstData),replay=await storeSelicImport(db,firstData);
 assert.equal(replay.replayed,true);assert.equal(replay.import_id,first.import_id);
 const revised=await storeSelicImport(db,await fetchRate('0.055132'));assert.notEqual(revised.import_id,first.import_id);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM market.index_observations')).rows[0].n,2);
 const listed=await listSelicObservations(db,'2026-01-02','2026-01-03');assert.equal(listed.coverage,'not_assessed_without_calendar');assert.equal(listed.observations.length,1);assert.equal(listed.observations[0].rate_pct,'0.055132');
 await assert.rejects(()=>listSelicObservations(db,'2026-02-30','2026-03-01'),/INVALID_SGS_INTERVAL/);
 await assert.rejects(()=>db.query('UPDATE market.index_observations SET rate_pct=0 WHERE import_id=$1',[first.import_id]));
});

test('calendar evidence requires every civil date, preserves revisions and feeds the 252-day model',async()=>{
 const fixture={calendar_code:'fixture-b3',source_uri:'https://example.test/calendar',source_revision:'fixture-v1',coverage_start:'2026-01-02',coverage_end:'2026-01-05',days:[{date:'2026-01-02',business_day:true},{date:'2026-01-03',business_day:false},{date:'2026-01-04',business_day:false},{date:'2026-01-05',business_day:true}]};
 await assert.rejects(()=>storeCalendar(db,{...fixture,days:fixture.days.slice(1)}),/CALENDAR_DATES_MISSING/);
 const first=await storeCalendar(db,fixture),replay=await storeCalendar(db,fixture);assert.equal(replay.replayed,true);assert.equal(first.calendar_id,replay.calendar_id);
 const missing=await listCalendar(db,fixture.calendar_code,'2026-01-02','2026-01-06');assert.equal(missing.coverage,'missing');
 const result=await listCalendar(db,fixture.calendar_code,'2026-01-02','2026-01-05');assert.equal(result.coverage,'declared');assert.ok(result.calendar);
 const index=await listSelicObservations(db,'2026-01-02','2026-01-02');
 const scenario=accumulateBusiness252({from:'2026-01-01',to:'2026-01-05',observed_through:'2026-01-02',calendar:result.calendar!,observations:index.observations,relation:'multiplier',contract_rate_pct:'100',future_assumption:{annual_rate_pct:'12',source:'fixture:scenario',as_of:'2026-01-02'}});
 assert.equal(scenario.status,'complete');assert.equal(scenario.days.length,2);
 await assert.rejects(()=>db.query('DELETE FROM market.calendar_days WHERE import_id=$1',[first.calendar_id]));
});

test('DI observations retain annual units and revisions independently of Selic',async()=>{
 const data={provider:'B3_DI_FTP' as const,source_uri:'ftp://ftp.cetip.com.br/MediaCDI',requested_from:'2026-01-02',requested_to:'2026-01-02',version:'a'.repeat(64),observations:[{date:'2026-01-02',rate_pct:'14.90',unit:'annual_effective_252' as const,indexer:'CDI' as const,source_uri:'ftp://ftp.cetip.com.br/MediaCDI',version:'a'.repeat(64)}]};
 const first=await storeDiImport(db,data),replay=await storeDiImport(db,data);assert.equal(replay.replayed,true);assert.equal(replay.import_id,first.import_id);
 const listed=await listDiObservations(db,'2026-01-02','2026-01-02');assert.equal(listed.observations[0].rate_pct,'14.90');assert.equal(listed.observations[0].unit,'annual_effective_252');assert.equal(listed.coverage,'not_assessed_without_calendar');
 await assert.rejects(()=>storeDiImport(db,{...data,observations:[]}),/B3_DI_EMPTY_IMPORT/);
});

test('calendar coverage composes adjacent versions and honors the latest correction without inventing gaps',async()=>{
 const common={calendar_code:'composite-di',source_uri:'https://example.test/b3'};
 await storeCalendar(db,{...common,source_revision:'first',coverage_start:'2026-01-01',coverage_end:'2026-01-02',days:[{date:'2026-01-01',business_day:false},{date:'2026-01-02',business_day:true}]});
 await storeCalendar(db,{...common,source_revision:'second',coverage_start:'2026-01-03',coverage_end:'2026-01-04',days:[{date:'2026-01-03',business_day:false},{date:'2026-01-04',business_day:false}]});
 let result=await listCalendar(db,'composite-di','2026-01-01','2026-01-04');assert.equal(result.coverage,'declared');assert.equal(result.calendar?.sources.length,2);assert.deepEqual(result.calendar?.days.map(d=>d.business_day),[false,true,false,false]);
 const version=result.calendar?.version;await storeCalendar(db,{...common,source_revision:'correction',coverage_start:'2026-01-02',coverage_end:'2026-01-02',days:[{date:'2026-01-02',business_day:false}]});
 result=await listCalendar(db,'composite-di','2026-01-01','2026-01-04');assert.equal(result.calendar?.days[1].business_day,false);assert.notEqual(result.calendar?.version,version);assert.equal(result.calendar?.sources.length,3);
 assert.equal((await listCalendar(db,'composite-di','2026-01-01','2026-01-05')).coverage,'missing');
});
