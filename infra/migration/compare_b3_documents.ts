/** Read-only candidate comparison: old B3 snapshot vs newly registered B3 evidence. */
import {readFile,writeFile} from 'node:fs/promises';
import {pool} from '../../services/application/src/db.ts';
import {exact} from '../../services/application/src/money.ts';
const [sourcePath,reportPath]=process.argv.slice(2);if(!sourcePath||!reportPath)throw new Error('Usage: compare_b3_documents.ts source-f3.json private-report.json');
const envelope=JSON.parse(await readFile(sourcePath,'utf8')) as {content:{tables:Record<string,Array<Record<string,unknown>>>}};
const t=envelope.content.tables,imports=t.imports.filter(x=>x.owner==='Jorge'&&x.file_type==='positions'&&x.status==='processed').sort((a,b)=>String(b.reference_date).localeCompare(String(a.reference_date))||String(b.created_at).localeCompare(String(a.created_at)));
const priorImport=imports[0];if(!priorImport)throw new Error('PRIOR_JORGE_SNAPSHOT_MISSING');
const prior=t.import_records.filter(x=>x.import_id===priorImport.id&&x.record_kind==='position').map(x=>JSON.parse(String(x.payload)) as Record<string,unknown>);
const db=pool();try{
 const positions=await db.query(`SELECT a.id,a.source_sheet,a.raw_row,i.instrument_code,i.status FROM app.source_assertions a
  JOIN app.source_documents d ON d.household_id=a.household_id AND d.id=a.document_id
  JOIN app.source_interpretations i ON i.household_id=a.household_id AND i.assertion_id=a.id AND i.parser_version='b3-v3-2026-10-09'
  WHERE d.original_name='posicao-2026-10-09-19-28-14.xlsx' AND d.report_kind='position' ORDER BY a.source_sheet,a.source_row`);
 const movement=await db.query(`SELECT a.id,a.asserted_on,a.direction,a.quantity::text AS quantity,a.source_event_type,a.raw_row,i.instrument_code,i.tentative_event_type FROM app.source_assertions a
  JOIN app.source_documents d ON d.household_id=a.household_id AND d.id=a.document_id
  JOIN app.source_interpretations i ON i.household_id=a.household_id AND i.assertion_id=a.id AND i.parser_version='b3-v3-2026-10-09'
  WHERE d.original_name='movimentacao-2026-10-09-19-28-45.xlsx' AND d.report_kind='movement' ORDER BY a.asserted_on,a.source_row`);
 const norm=(x:unknown)=>String(x??'').trim().replace(/\s+/g,' ').toUpperCase();
 const key=(sheet:unknown,name:unknown,code:unknown,inst:unknown)=>[norm(sheet),norm(name),norm(code),norm(inst)].join('|');
 const previous=new Map(prior.map(p=>[key(p.source_sheet,p.product_name,p.instrument_code,p.institution),p]));
 const current=new Map(positions.rows.map(r=>{const raw=r.raw_row as Record<string,unknown>;return[key(r.source_sheet,raw.Produto,r.instrument_code,raw.Instituição),r];}));
 if(previous.size!==prior.length||current.size!==positions.rowCount)throw new Error('DUPLICATE_POSITION_KEY');
 const differences:Array<Record<string,unknown>>=[];
 for(const [k,r] of current){const raw=r.raw_row as Record<string,unknown>,old=previous.get(k);
  if(!old){differences.push({kind:'added',source_assertion_id:r.id,sheet:r.source_sheet,instrument_code:r.instrument_code,institution:raw.Instituição});continue;}
  if(!exact(String(old.quantity)).eq(exact(String(raw.Quantidade))))differences.push({kind:'quantity_changed',source_assertion_id:r.id,sheet:r.source_sheet,instrument_code:r.instrument_code,institution:raw.Instituição});
 }
 for(const [k,old] of previous)if(!current.has(k))differences.push({kind:'removed',source_sheet:old.source_sheet,instrument_code:old.instrument_code,institution:old.institution});
 const changedCodes=new Set(differences.map(d=>String(d.instrument_code)));
 const recentMovements=movement.rows.filter(m=>String(m.asserted_on)>'2026-09-19'&&String(m.asserted_on)<='2026-10-09');
 const candidates=recentMovements.filter(m=>changedCodes.has(String(m.instrument_code))).map(m=>({source_assertion_id:m.id,instrument_code:m.instrument_code,date:m.asserted_on,source_event_type:m.source_event_type,tentative_event_type:m.tentative_event_type,direction:m.direction}));
 const timingReviews=differences.filter(d=>d.kind==='removed'&&!candidates.some(m=>m.instrument_code===d.instrument_code)).map(d=>{
  const earlier=movement.rows.filter(m=>m.instrument_code===d.instrument_code&&String(m.asserted_on)<=String(priorImport.reference_date)).sort((a,b)=>String(b.asserted_on).localeCompare(String(a.asserted_on)));
  return {instrument_code:d.instrument_code,prior_snapshot_date:priorImport.reference_date,latest_documented_movement:earlier[0]?{date:earlier[0].asserted_on,source_event_type:earlier[0].source_event_type,direction:earlier[0].direction}:null,reason:'removed_without_post_snapshot_movement'};
 });
 const smalTrade=t.import_records.filter(x=>x.record_kind==='trade').map(x=>JSON.parse(String(x.payload)) as Record<string,unknown>).find(x=>x.owner==='Jorge'&&x.instrument_code==='SMAL11'&&x.trade_date==='2026-10-05');
 const smalSettlement=movement.rows.find(m=>m.instrument_code==='SMAL11'&&String(m.asserted_on)==='2026-10-07'&&m.tentative_event_type==='settlement_observation'&&m.direction==='Debito');
 const report={status:'candidate_only',prior_snapshot_date:priorImport.reference_date,new_snapshot_date:'2026-10-09',prior_positions:prior.length,new_positions:positions.rowCount,movement_coverage:{start:movement.rows[0]?.asserted_on,end:movement.rows.at(-1)?.asserted_on,rows:movement.rowCount},differences,candidate_movements:candidates,timing_reviews:timingReviews,smal11:{manual_trade_2026_10_05_found:!!smalTrade,b3_settlement_2026_10_07_found:!!smalSettlement,quantity_matches:!!smalTrade&&!!smalSettlement&&exact(String(smalTrade.quantity)).eq(exact(String(smalSettlement.quantity))),link_status:'candidate_not_applied'}};
 await writeFile(reportPath,JSON.stringify(report,null,2),{mode:0o600});
 console.log(JSON.stringify({prior_positions:report.prior_positions,new_positions:report.new_positions,differences:Object.fromEntries(['added','removed','quantity_changed'].map(x=>[x,differences.filter(d=>d.kind===x).length])),recent_movements:recentMovements.length,candidate_movements:candidates.length,timing_reviews:timingReviews.length,smal11_quantity_matches:report.smal11.quantity_matches,portfolio_published:false}));
}finally{await db.end();}
