import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyB3DiCalendar2026} from '../src/b3-di-calendar-2026.ts';
import type {fetchB3Di} from '../src/b3-di.ts';
const source=(from:string,to:string,dates:string[])=>({provider:'B3_DI_FTP',source_uri:'ftp://example.test',requested_from:from,requested_to:to,version:'a'.repeat(64),observations:dates.map(date=>({date,rate_pct:'14.90',unit:'annual_effective_252',indexer:'CDI',source_uri:'ftp://example.test',version:'a'.repeat(64)}))}) as Awaited<ReturnType<typeof fetchB3Di>>;
test('B3 closure and published rates jointly confirm calendar dates',async()=>{const result=await verifyB3DiCalendar2026({from:'2026-10-30',to:'2026-11-03',as_of:'2026-11-04'},async(a,b)=>source(a,b,['2026-10-30','2026-11-03']));assert.equal(result.status,'complete');if(result.status==='complete')assert.deepEqual(result.calendar.days.map(d=>d.business_day),[true,false,false,false,true]);});
test('a missing weekday or unexpected holiday rate blocks confirmation',async()=>{const missing=await verifyB3DiCalendar2026({from:'2026-11-03',to:'2026-11-03',as_of:'2026-11-04'},async(a,b)=>source(a,b,[]));assert.equal(missing.status,'blocked');if(missing.status==='blocked')assert.deepEqual(missing.missing_rates,['2026-11-03']);const unexpected=await verifyB3DiCalendar2026({from:'2026-11-02',to:'2026-11-02',as_of:'2026-11-04'},async(a,b)=>source(a,b,['2026-11-02']));assert.equal(unexpected.status,'blocked');if(unexpected.status==='blocked')assert.deepEqual(unexpected.unexpected_rates,['2026-11-02']);});
test('December 31 is not assumed closed for DI',async()=>{const result=await verifyB3DiCalendar2026({from:'2026-12-31',to:'2026-12-31',as_of:'2027-01-01'},async(a,b)=>source(a,b,['2026-12-31']));assert.equal(result.status,'complete');if(result.status==='complete')assert.equal(result.calendar.days[0].business_day,true);});
test('future and unverified years are rejected',async()=>{await assert.rejects(()=>verifyB3DiCalendar2026({from:'2027-01-01',to:'2027-01-01',as_of:'2027-01-02'}),/INVALID_B3_2026/);await assert.rejects(()=>verifyB3DiCalendar2026({from:'2026-11-01',to:'2026-11-01',as_of:'2026-11-01'}),/INVALID_B3_2026/);});

test('cross-year windows require an independent source for every year before fetching',async()=>{
 const {dailyDiWindow,verifyB3DiCalendars}=await import('../src/b3-di-calendar-2026.ts');let calls=0;
 for(const now of ['2027-01-02T15:00:00Z','2027-01-15T15:00:00Z']){const window=dailyDiWindow(new Date(now));const result=await verifyB3DiCalendars(window,{fetcher:async(a,b)=>{calls++;return source(a,b,[]);}});assert.equal(result.status,'blocked');if(result.status==='blocked'&&result.reason==='calendar_source_unavailable')assert.deepEqual(result.missing_years,[2027]);}
 assert.equal(calls,0);
 assert.deepEqual(dailyDiWindow(new Date('2026-12-31T15:00:00Z')),{from:'2026-12-17',to:'2026-12-30',as_of:'2026-12-31'});
 assert.deepEqual(dailyDiWindow(new Date('2027-01-01T15:00:00Z')),{from:'2026-12-18',to:'2026-12-31',as_of:'2027-01-01'});
});

test('independent yearly sources are composed and disagreement blocks the whole interval',async()=>{
 const {verifyB3DiCalendars,CONFIRMED_CALENDARS}=await import('../src/b3-di-calendar-2026.ts');
 const calendars={...CONFIRMED_CALENDARS,2027:{year:2027,source_uri:'https://example.test/2027',source_revision:'test-only',closed:new Set(['2027-01-01'])}};
 const input={from:'2026-12-31',to:'2027-01-04',as_of:'2027-01-05'};
 const result=await verifyB3DiCalendars(input,{calendars,fetcher:async(a,b)=>source(a,b,a.startsWith('2026')?['2026-12-31']:['2027-01-04'])});
 assert.equal(result.status,'complete');if(result.status==='complete'){assert.equal(result.batches.length,2);assert.equal(result.batches[1].calendar.source_uri,'https://example.test/2027');assert.equal(result.batches[1].calendar.coverage_kind,'confirmed');}
 const blocked=await verifyB3DiCalendars(input,{calendars,fetcher:async(a,b)=>source(a,b,a.startsWith('2026')?['2026-12-31']:[])});assert.equal(blocked.status,'blocked');if(blocked.status==='blocked')assert.equal(blocked.reason,'calendar_index_disagreement');
});
