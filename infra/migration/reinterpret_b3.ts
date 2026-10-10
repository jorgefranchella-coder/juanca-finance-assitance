/** Derive a new, versioned B3 interpretation without changing raw assertions. */
import {pool,migrate} from '../../services/application/src/db.ts';
const parserVersion='b3-v3-2026-10-09';
function clean(v:unknown){return String(v??'').trim().replace(/\s+/g,' ');}
function norm(v:unknown){return clean(v).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/[^A-Z0-9]+/g,' ').trim().replace(/\s+/g,' ');}
function code(raw:Record<string,unknown>,treasury:Map<string,string|null>){
 const explicit=raw.Código??raw['Código de Negociação']??raw['Código ISIN']??raw['Código ISIN / Distribuição'];
 if(clean(explicit)&&clean(explicit)!=='-')return clean(explicit).split(' - ')[0];
 const parts=clean(raw.Produto).split(' - ').map(clean);if(/^[A-Z0-9]{4,30}$/.test(parts[0]??''))return parts[0];
 if(['CDB','CRI','CRA','LCA','LCI','LIG','DEB','CFF','CPR','LF','LC'].includes(parts[0]??'')&&/^[A-Z0-9]{4,30}$/.test(parts[1]??''))return parts[1];
 return treasury.get(norm(raw.Produto))??null;
}
function tentative(value:unknown){const s=norm(value);if(s==='TRANSFERENCIA LIQUIDACAO')return 'settlement_observation';if(s.includes('TRANSFERENCIA SEM FINANCEIRO')||s.includes('RETIRADA DE CUSTODIA'))return 'custody_transfer_observation';if(s.includes('EXCLUIDO')||s.includes('REATIVADO'))return 'correction_observation';if(s.includes('ATUALIZACAO')||s.includes('BONIFICACAO')||s.includes('SUBSCRICAO'))return 'corporate_action_observation';if(s.includes('JUROS')||s.includes('DIVIDENDO')||s.includes('RENDIMENTO'))return 'income_observation';if(s.includes('VENCIMENTO')||s.includes('RESGATE'))return 'redemption_observation';if(s.includes('APLICACAO')||s==='COMPRA')return 'acquisition_observation';if(s.includes('COMPRA')||s.includes('VENDA'))return 'trade_observation';return 'unclassified_observation';}
const db=pool();try{
 await migrate(db);
 const rows=await db.query(`SELECT a.household_id,a.id,a.assertion_kind,a.source_sheet,a.raw_row,a.institution_id,a.custody_account_id,a.source_event_type
  FROM app.source_assertions a JOIN app.source_documents d ON d.household_id=a.household_id AND d.id=a.document_id
  WHERE d.source_system='B3' AND d.original_name IN ('posicao-2026-10-09-19-28-14.xlsx','movimentacao-2026-10-09-19-28-45.xlsx') ORDER BY a.assertion_kind,a.source_sheet,a.source_row`);
 if(rows.rowCount!==558)throw new Error('EXPECTED_B3_ROW_COUNT');
 const treasury=new Map<string,string|null>();for(const row of rows.rows){if(row.source_sheet!=='Tesouro Direto')continue;const raw=row.raw_row as Record<string,unknown>,name=norm(raw.Produto),isin=clean(raw['Código ISIN']);if(!isin)continue;treasury.set(name,treasury.has(name)&&treasury.get(name)!==isin?null:isin);}
 const c=await db.connect();try{await c.query('BEGIN');let inserted=0,review=0;const reasons:Record<string,number>={};
  for(const row of rows.rows){const raw=row.raw_row as Record<string,unknown>,instrument=code(raw,treasury),event=row.assertion_kind==='movement'?tentative(row.source_event_type):null,why:string[]=[];
   if(!row.institution_id||!row.custody_account_id)why.push('custody_account_pending');if(!instrument)why.push('instrument_pending');if(event==='unclassified_observation'||event==='correction_observation')why.push('event_semantics_pending');if(event==='custody_transfer_observation')why.push('transfer_counterparty_pending');
   for(const reason of why)reasons[reason]=(reasons[reason]??0)+1;
   const status=why.length?'needs_review':'parsed';if(why.length)review++;
   const r=await c.query(`INSERT INTO app.source_interpretations(household_id,assertion_id,parser_version,instrument_code,tentative_event_type,status,review_reasons) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,[row.household_id,row.id,parserVersion,instrument,event,status,why]);inserted+=r.rowCount??0;
  }
  await c.query('COMMIT');console.log(JSON.stringify({parser_version:parserVersion,assertions:rows.rowCount,new_interpretations:inserted,needs_review:review,review_reasons:reasons,portfolio_published:false}));
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}finally{await db.end();}
