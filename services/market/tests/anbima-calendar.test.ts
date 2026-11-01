import test from 'node:test';
import assert from 'node:assert/strict';
import xlsx from 'xlsx';
import {fetchAnbimaCalendarScenario} from '../src/anbima-calendar.ts';

test('ANBIMA scenario excludes listed holidays and weekends, and keeps other days explicitly estimated',async()=>{
 const book=xlsx.utils.book_new(),sheet=xlsx.utils.aoa_to_sheet([['Data','Dia','Feriado'],[new Date('2027-01-01T12:00:00Z'),'','Ano Novo'],[new Date('2027-12-25T12:00:00Z'),'','Natal']]);
 xlsx.utils.book_append_sheet(book,sheet,'Feriados');const buffer=xlsx.write(book,{type:'buffer',bookType:'xls'});
 const calendar=await fetchAnbimaCalendarScenario('2027-12-24','2027-12-27',async()=>new Response(buffer));assert.equal(calendar.coverage_kind,'estimated');assert.deepEqual(calendar.days.map(d=>d.business_day),[true,false,false,true]);
});
test('ANBIMA scenario rejects dates in the past',async()=>{await assert.rejects(()=>fetchAnbimaCalendarScenario('2002-01-01','2002-01-31'),/INVALID_CALENDAR_SCENARIO_INTERVAL/);});
