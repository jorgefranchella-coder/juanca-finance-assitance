import {createHash} from 'node:crypto';
import type pg from 'pg';
import {exact} from './money.ts';
import {Conflict} from './commands.ts';
import {ingestionCall} from './manual-intake.ts';
import {interpretManualTrade} from './manual-trade-parse.ts';
import {PENSION_PARSER_VERSION} from '../../ingestion/src/pension-parser.ts';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PARSER='b3-bridge-v1-2026-10-10';
type Raw=Record<string,unknown>;
type IngestRecord={source_sheet:string;source_ordinal:number|string;record_kind:string;original:Raw;original_sha256:string};
type IngestJob={id:string;document_id:string;parser_version:string;result:{record_count:number;coverage_start:string|null;coverage_end:string|null;reference_date?:string|null};content_sha256:string;owner_ref:string;source?:string;file_type:string;reference_date:string|null;file_name:string};
function sha(value:string){return createHash('sha256').update(value).digest('hex');}
function clean(value:unknown){return String(value??'').trim().replace(/\s+/g,' ');}
function norm(value:unknown){return clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/[^A-Z0-9]+/g,' ').trim().replace(/\s+/g,' ');}
function refNorm(value:unknown){return clean(value).toUpperCase().replace(/[^A-Z0-9]/g,'');}
async function resolveAvenueAccount(db:pg.Pool,household:string,ownerId:string,ownerName:string,observedRef:string){
 const unresolvedScope=JSON.stringify([ownerName,'unresolved:chat_transaction:Avenue']);
 const aliases=await db.query(`SELECT canonical.source_scope,canonical.id FROM app.accounts unresolved
  JOIN LATERAL(SELECT canonical_account_id,decision,evidence FROM app.command_account_identity_resolutions r WHERE r.household_id=unresolved.household_id AND r.account_id=unresolved.id ORDER BY revision DESC LIMIT 1) resolution ON true
  JOIN app.accounts canonical ON canonical.household_id=unresolved.household_id AND canonical.id=resolution.canonical_account_id
  WHERE unresolved.household_id=$1 AND unresolved.owner_id=$2 AND unresolved.source_scope=$3 AND unresolved.identity_status='unresolved'
    AND resolution.decision='user_confirmed_avenue_account_alias' AND regexp_replace(upper(resolution.evidence->>'confirmed_reference'),'[^A-Z0-9]','','g')=$4 AND canonical.identity_status='known'`,[household,ownerId,unresolvedScope,refNorm(observedRef)]);
 if(aliases.rows.length>1)throw new Conflict('AVENUE_ACCOUNT_ALIAS_AMBIGUOUS');
 if(aliases.rowCount){const scope=JSON.parse(String(aliases.rows[0].source_scope)) as string[],prefix='account:';if(scope[0]!==ownerName||!scope[1]?.startsWith(prefix))throw new Conflict('AVENUE_CANONICAL_ACCOUNT_SCOPE_INVALID');return{id:String(aliases.rows[0].id),reference:scope[1].slice(prefix.length)};}
 const scope=JSON.stringify([ownerName,`account:${observedRef}`]);const found=await db.query("SELECT id FROM app.accounts WHERE household_id=$1 AND owner_id=$2 AND source_scope=$3 AND identity_status='known'",[household,ownerId,scope]);if(found.rowCount!==1)throw new Conflict('AVENUE_ACCOUNT_IDENTITY_NOT_VERIFIED');return{id:String(found.rows[0].id),reference:observedRef};
}
function date(value:unknown){if(value instanceof Date&&!Number.isNaN(value.getTime()))return value.toISOString().slice(0,10);const text=clean(value),m=/^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);return m?`${m[3]}-${m[2]}-${m[1]}`:/^\d{4}-\d{2}-\d{2}$/.test(text)?text:null;}
function code(raw:Raw,treasury:Map<string,string|null>){const explicit=raw.Código??raw['Código de Negociação']??raw['Código ISIN']??raw['Código ISIN / Distribuição'];if(clean(explicit)&&clean(explicit)!=='-')return clean(explicit).split(' - ')[0];const parts=clean(raw.Produto).split(' - ').map(clean);if(/^[A-Z0-9]{4,30}$/.test(parts[0]??''))return parts[0];if(['CDB','CRI','CRA','LCA','LCI','LIG','DEB','CFF','CPR','LF','LC'].includes(parts[0]??'')&&/^[A-Z0-9]{4,30}$/.test(parts[1]??''))return parts[1];return treasury.get(norm(raw.Produto))??null;}
function tentative(value:unknown){const s=norm(value);if(s==='TRANSFERENCIA LIQUIDACAO')return 'settlement_observation';if(s.includes('TRANSFERENCIA SEM FINANCEIRO')||s.includes('RETIRADA DE CUSTODIA'))return 'custody_transfer_observation';if(s.includes('EXCLUIDO')||s.includes('REATIVADO'))return 'correction_observation';if(s.includes('ATUALIZACAO')||s.includes('BONIFICACAO')||s.includes('SUBSCRICAO'))return 'corporate_action_observation';if(s.includes('JUROS')||s.includes('DIVIDENDO')||s.includes('RENDIMENTO'))return 'income_observation';if(s.includes('VENCIMENTO')||s.includes('RESGATE'))return 'redemption_observation';if(s.includes('APLICACAO')||s==='COMPRA')return 'acquisition_observation';if(s.includes('COMPRA')||s.includes('VENDA'))return 'trade_observation';return 'unclassified_observation';}
function validBatch(value:Record<string,unknown>,id:string){const job=value.job as IngestJob,records=value.records as IngestRecord[];if(!job||job.id!==id||!UUID.test(job.id)||!UUID.test(job.document_id)||!['positions','movements'].includes(job.file_type)||!Array.isArray(records)||!Number.isInteger(job.result?.record_count)||records.length!==job.result.record_count||!/^[0-9a-f]{64}$/.test(job.content_sha256)||typeof job.owner_ref!=='string'||typeof job.file_name!=='string'||!job.file_name||typeof job.parser_version!=='string')throw new Conflict('INVALID_INGESTION_BATCH',422);return{job,records};}
export async function readyImportJobs(household:string){const jobs:IngestJob[]=[];for(let offset=0;offset<=1_000_000;offset+=100){const response=await ingestionCall(`/v1/import-jobs/ready?offset=${offset}`,'GET',undefined,{'X-Household-Ref':household}),page=response.jobs as IngestJob[]??[];jobs.push(...page);if(page.length<100)break;}return jobs.map(job=>({id:job.id,source:job.source,file_type:job.file_type,status:'awaiting_review'}));}
export async function acknowledgeImportJob(household:string,id:string){if(!UUID.test(id))throw new Conflict('NOT_FOUND',404);return ingestionCall(`/v1/import-jobs/${id}/acknowledge`,'POST',undefined,{'X-Household-Ref':household});}
export async function ingestAvenueBatch(db:pg.Pool,household:string,id:string){
 if(!UUID.test(id))throw new Conflict('NOT_FOUND',404);
 const value=await ingestionCall(`/v1/import-jobs/${id}/records`,'GET',undefined,{'X-Household-Ref':household});
 const job=value.job as IngestJob,records=value.records as IngestRecord[];
 if(!job||job.id!==id||!UUID.test(job.document_id)||job.file_type!=='avenue_statement'||!Array.isArray(records)||records.length!==job.result?.record_count||!/^[0-9a-f]{64}$/.test(job.content_sha256)||!['avenue-statement-v1-2026-10-22'].includes(job.parser_version))throw new Conflict('INVALID_INGESTION_BATCH',422);
 const owner=await db.query('SELECT display_name FROM app.owners WHERE household_id=$1 AND id=$2',[household,job.owner_ref]);if(!owner.rowCount)throw new Conflict('UNKNOWN_OWNER',422);
 const ownerName=String(owner.rows[0].display_name),accountRef=String((records[0]?.original as Raw)?.account??'');
 if(!accountRef||records.some(row=>row.record_kind!=='position'||String(row.original.account??'')!==accountRef||String(row.original.reference_date??'')!==String(job.reference_date).slice(0,10)))throw new Conflict('AVENUE_ACCOUNT_OR_DATE_MISMATCH',422);
 const account=await resolveAvenueAccount(db,household,job.owner_ref,ownerName,accountRef);
 const proposedDocumentId='avenue-'+sha([household,job.owner_ref,job.content_sha256].join('|')).slice(0,32),custodyAccountId='custody-'+sha([household,job.owner_ref,'avenue-securities',account.reference].join('|')).slice(0,32);
 const c=await db.connect();try{await c.query('BEGIN');
  await c.query(`INSERT INTO app.custody_accounts(household_id,id,owner_id,institution_id,external_reference,identity_basis) VALUES($1,$2,$3,'avenue-securities',$4,'observed_reference') ON CONFLICT(household_id,id) DO NOTHING`,[household,custodyAccountId,job.owner_ref,account.reference]);
  const custody=await c.query('SELECT owner_id,institution_id,external_reference FROM app.custody_accounts WHERE household_id=$1 AND id=$2',[household,custodyAccountId]);if(custody.rows[0]?.owner_id!==job.owner_ref||custody.rows[0]?.institution_id!=='avenue-securities'||custody.rows[0]?.external_reference!==account.reference)throw new Conflict('CUSTODY_ACCOUNT_CONFLICT');
  const priorDoc=await c.query(`SELECT id,owner_id,content_sha256,report_kind FROM app.source_documents WHERE household_id=$1 AND owner_id=$2 AND source_system='Avenue' AND report_kind='position' AND content_sha256=$3 FOR UPDATE`,[household,job.owner_ref,job.content_sha256]);
  const documentId=priorDoc.rowCount?String(priorDoc.rows[0].id):proposedDocumentId;
  const prior=await c.query('SELECT document_id,content_sha256,row_count FROM app.ingested_import_jobs WHERE household_id=$1 AND import_job_id=$2 FOR UPDATE',[household,id]);if(prior.rowCount){if(prior.rows[0].document_id!==documentId||prior.rows[0].content_sha256!==job.content_sha256||Number(prior.rows[0].row_count)!==records.length)throw new Conflict('INGESTION_BATCH_CHANGED');await c.query('COMMIT');return{document_id:documentId,rows:records.length,new_rows:0,replayed:true,portfolio_published:false};}
  if(priorDoc.rowCount&&(priorDoc.rows[0].owner_id!==job.owner_ref||priorDoc.rows[0].content_sha256!==job.content_sha256||priorDoc.rows[0].report_kind!=='position'))throw new Conflict('SOURCE_DOCUMENT_CONFLICT');
  await c.query(`INSERT INTO app.source_documents(household_id,id,owner_id,source_system,report_kind,original_name,content_sha256,storage_key,effective_as_of,date_basis)
   VALUES($1,$2,$3,'Avenue','position',$4,$5,$6,$7,'statement_reference_date') ON CONFLICT(household_id,id) DO NOTHING`,[household,documentId,job.owner_ref,job.file_name,job.content_sha256,'ingestion:'+job.document_id,job.reference_date]);
  const doc=await c.query('SELECT content_sha256,owner_id,report_kind FROM app.source_documents WHERE household_id=$1 AND id=$2',[household,documentId]);if(doc.rows[0]?.content_sha256!==job.content_sha256||doc.rows[0]?.owner_id!==job.owner_ref||doc.rows[0]?.report_kind!=='position')throw new Conflict('SOURCE_DOCUMENT_CONFLICT');
  let inserted=0,needsReview=0;
  for(const row of records){const ordinal=Number(row.source_ordinal),raw=row.original,code=String(raw.instrument_code??'').trim(),quantity=String(raw.quantity??''),date=String(raw.reference_date??'');if(!Number.isSafeInteger(ordinal)||ordinal<2||!code||!quantity||!date||!/^[0-9a-f]{64}$/.test(row.original_sha256))throw new Conflict('INVALID_AVENUE_POSITION',422);
   const status='observed',assertionId='assertion-'+sha([documentId,row.source_sheet,ordinal].join('|')).slice(0,32);
   const added=await c.query(`INSERT INTO app.source_assertions(household_id,id,document_id,owner_id,source_sheet,source_row,assertion_kind,institution_id,custody_account_id,instrument_code,asserted_on,quantity,raw_row,interpretation_status)
    VALUES($1,$2,$3,$4,$5,$6,'position','avenue-securities',$7,$8,$9,$10,$11,$12) ON CONFLICT(household_id,document_id,source_sheet,source_row) DO NOTHING RETURNING id`,[household,assertionId,documentId,job.owner_ref,row.source_sheet,ordinal,custodyAccountId,code,date,exact(quantity).toFixed(),JSON.stringify(raw),status]);inserted+=added.rowCount??0;
   const actual=added.rows[0]?.id??(await c.query('SELECT id FROM app.source_assertions WHERE household_id=$1 AND document_id=$2 AND source_sheet=$3 AND source_row=$4',[household,documentId,row.source_sheet,ordinal])).rows[0]?.id;
   const original=await c.query('SELECT raw_row=$3::jsonb AS same FROM app.source_assertions WHERE household_id=$1 AND id=$2',[household,actual,JSON.stringify(raw)]);if(!actual||original.rows[0]?.same!==true)throw new Conflict('SOURCE_ROW_CONFLICT');
   await c.query(`INSERT INTO app.source_interpretations(household_id,assertion_id,parser_version,instrument_code,status,review_reasons) VALUES($1,$2,$3,$4,'parsed','{}') ON CONFLICT DO NOTHING`,[household,actual,job.parser_version,code]);
  }
  await c.query('INSERT INTO app.ingested_import_jobs(household_id,import_job_id,document_id,content_sha256,parser_version,row_count) VALUES($1,$2,$3,$4,$5,$6)',[household,id,documentId,job.content_sha256,job.parser_version,records.length]);
  await c.query('COMMIT');return{document_id:documentId,rows:records.length,new_rows:inserted,needs_review:needsReview,replayed:false,portfolio_published:false};
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
export async function ingestAvenueConfirmationBatch(db:pg.Pool,household:string,id:string){
 if(!UUID.test(id))throw new Conflict('NOT_FOUND',404);
 const value=await ingestionCall(`/v1/import-jobs/${id}/records`,'GET',undefined,{'X-Household-Ref':household});
 const job=value.job as IngestJob,records=value.records as IngestRecord[];
 if(!job||job.id!==id||!UUID.test(job.document_id)||job.file_type!=='avenue_confirmation'||!Array.isArray(records)||records.length!==job.result?.record_count||!/^[0-9a-f]{64}$/.test(job.content_sha256)||job.parser_version!=='avenue-confirmation-v1-2026-10-22')throw new Conflict('INVALID_INGESTION_BATCH',422);
 const owner=await db.query('SELECT display_name FROM app.owners WHERE household_id=$1 AND id=$2',[household,job.owner_ref]);if(!owner.rowCount)throw new Conflict('UNKNOWN_OWNER',422);
 const ownerName=String(owner.rows[0].display_name),accountRef=String(records[0]?.original.account??'');
 if(!accountRef||records.some(row=>row.record_kind!=='movement'||String(row.original.account??'')!==accountRef||!['buy','sell'].includes(String(row.original.side))))throw new Conflict('AVENUE_ACCOUNT_OR_TRADE_MISMATCH',422);
 const account=await resolveAvenueAccount(db,household,job.owner_ref,ownerName,accountRef);
 const proposedDocumentId='avenue-'+sha([household,job.owner_ref,'movement',job.content_sha256].join('|')).slice(0,32),custodyAccountId='custody-'+sha([household,job.owner_ref,'avenue-securities',account.reference].join('|')).slice(0,32);
 const c=await db.connect();try{await c.query('BEGIN');
  await c.query(`INSERT INTO app.custody_accounts(household_id,id,owner_id,institution_id,external_reference,identity_basis) VALUES($1,$2,$3,'avenue-securities',$4,'observed_reference') ON CONFLICT(household_id,id) DO NOTHING`,[household,custodyAccountId,job.owner_ref,account.reference]);
  const custody=await c.query('SELECT owner_id,institution_id,external_reference FROM app.custody_accounts WHERE household_id=$1 AND id=$2',[household,custodyAccountId]);if(custody.rows[0]?.owner_id!==job.owner_ref||custody.rows[0]?.institution_id!=='avenue-securities'||custody.rows[0]?.external_reference!==account.reference)throw new Conflict('CUSTODY_ACCOUNT_CONFLICT');
  const priorDoc=await c.query(`SELECT id,owner_id,content_sha256,report_kind FROM app.source_documents WHERE household_id=$1 AND owner_id=$2 AND source_system='Avenue' AND report_kind='movement' AND content_sha256=$3 FOR UPDATE`,[household,job.owner_ref,job.content_sha256]);const documentId=priorDoc.rowCount?String(priorDoc.rows[0].id):proposedDocumentId;
  const prior=await c.query('SELECT document_id,content_sha256,row_count FROM app.ingested_import_jobs WHERE household_id=$1 AND import_job_id=$2 FOR UPDATE',[household,id]);if(prior.rowCount){if(prior.rows[0].document_id!==documentId||prior.rows[0].content_sha256!==job.content_sha256||Number(prior.rows[0].row_count)!==records.length)throw new Conflict('INGESTION_BATCH_CHANGED');await c.query('COMMIT');return{document_id:documentId,rows:records.length,new_rows:0,replayed:true,portfolio_published:false};}
  if(priorDoc.rowCount&&(priorDoc.rows[0].owner_id!==job.owner_ref||priorDoc.rows[0].content_sha256!==job.content_sha256||priorDoc.rows[0].report_kind!=='movement'))throw new Conflict('SOURCE_DOCUMENT_CONFLICT');
  await c.query(`INSERT INTO app.source_documents(household_id,id,owner_id,source_system,report_kind,original_name,content_sha256,storage_key,coverage_start,coverage_end,date_basis)
   VALUES($1,$2,$3,'Avenue','movement',$4,$5,$6,$7,$8,'trade_date') ON CONFLICT(household_id,id) DO NOTHING`,[household,documentId,job.owner_ref,job.file_name,job.content_sha256,'ingestion:'+job.document_id,job.result.coverage_start,job.result.coverage_end]);
  const doc=await c.query('SELECT content_sha256,owner_id,report_kind FROM app.source_documents WHERE household_id=$1 AND id=$2',[household,documentId]);if(doc.rows[0]?.content_sha256!==job.content_sha256||doc.rows[0]?.owner_id!==job.owner_ref||doc.rows[0]?.report_kind!=='movement')throw new Conflict('SOURCE_DOCUMENT_CONFLICT');
  let inserted=0;
  for(const row of records){const ordinal=Number(row.source_ordinal),raw=row.original,code=String(raw.instrument_code??'').trim(),quantity=exact(String(raw.quantity??'0')),tradeDate=String(raw.trade_date??''),side=String(raw.side);if(!Number.isSafeInteger(ordinal)||ordinal<2||!code||quantity.lte(0)||!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)||!['buy','sell'].includes(side)||!exact(String(raw.unit_price??'0')).gt(0))throw new Conflict('INVALID_AVENUE_TRADE',422);
   const assertionId='assertion-'+sha([documentId,row.source_sheet,ordinal].join('|')).slice(0,32);
   const added=await c.query(`INSERT INTO app.source_assertions(household_id,id,document_id,owner_id,source_sheet,source_row,assertion_kind,institution_id,custody_account_id,instrument_code,asserted_on,source_event_type,tentative_event_type,direction,quantity,raw_row,interpretation_status)
    VALUES($1,$2,$3,$4,$5,$6,'movement','avenue-securities',$7,$8,$9,$10,'trade_observation',$11,$12,$13,'observed') ON CONFLICT(household_id,document_id,source_sheet,source_row) DO NOTHING RETURNING id`,[household,assertionId,documentId,job.owner_ref,row.source_sheet,ordinal,custodyAccountId,code,tradeDate,side,side,quantity.toFixed(),JSON.stringify(raw)]);inserted+=added.rowCount??0;
   const actual=added.rows[0]?.id??(await c.query('SELECT id FROM app.source_assertions WHERE household_id=$1 AND document_id=$2 AND source_sheet=$3 AND source_row=$4',[household,documentId,row.source_sheet,ordinal])).rows[0]?.id;const original=await c.query('SELECT raw_row=$3::jsonb AS same FROM app.source_assertions WHERE household_id=$1 AND id=$2',[household,actual,JSON.stringify(raw)]);if(!actual||original.rows[0]?.same!==true)throw new Conflict('SOURCE_ROW_CONFLICT');
   await c.query(`INSERT INTO app.source_interpretations(household_id,assertion_id,parser_version,instrument_code,tentative_event_type,status,review_reasons) VALUES($1,$2,$3,$4,'trade_observation','parsed','{}') ON CONFLICT DO NOTHING`,[household,actual,job.parser_version,code]);
  }
  await c.query('INSERT INTO app.ingested_import_jobs(household_id,import_job_id,document_id,content_sha256,parser_version,row_count) VALUES($1,$2,$3,$4,$5,$6)',[household,id,documentId,job.content_sha256,job.parser_version,records.length]);await c.query('COMMIT');return{document_id:documentId,rows:records.length,new_rows:inserted,needs_review:0,replayed:false,portfolio_published:false};
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
export async function ingestPensionBatch(db:pg.Pool,household:string,id:string){
 if(!UUID.test(id))throw new Conflict('NOT_FOUND',404);
 const value=await ingestionCall(`/v1/import-jobs/${id}/records`,'GET',undefined,{'X-Household-Ref':household});const job=value.job as IngestJob,records=value.records as IngestRecord[];
 if(!job||job.id!==id||!UUID.test(job.document_id)||job.file_type!=='pension_statement'||!Array.isArray(records)||records.length!==job.result?.record_count||!/^[0-9a-f]{64}$/.test(job.content_sha256)||job.parser_version!==PENSION_PARSER_VERSION)throw new Conflict('INVALID_INGESTION_BATCH',422);
 const owner=await db.query('SELECT display_name FROM app.owners WHERE household_id=$1 AND id=$2',[household,job.owner_ref]);if(!owner.rowCount)throw new Conflict('UNKNOWN_OWNER',422);
 const provider=String(records[0]?.original.institution??''),referenceDate=String(job.result.reference_date??'');
 if(!provider||!/^\d{4}-\d{2}-\d{2}$/.test(referenceDate)||records.some(row=>row.original.owner_ref!==job.owner_ref||row.original.institution!==provider||row.original.reference_date!==referenceDate&&row.record_kind==='position'))throw new Conflict('PENSION_OWNER_OR_DATE_MISMATCH',422);
 const proposedDocumentId='pension-'+sha([household,job.owner_ref,job.content_sha256].join('|')).slice(0,32),c=await db.connect();try{await c.query('BEGIN');
  const priorDoc=await c.query(`SELECT id,owner_id,content_sha256,report_kind FROM app.source_documents WHERE household_id=$1 AND owner_id=$2 AND source_system=$3 AND report_kind='position' AND content_sha256=$4 FOR UPDATE`,[household,job.owner_ref,provider,job.content_sha256]);const documentId=priorDoc.rowCount?String(priorDoc.rows[0].id):proposedDocumentId;
  if(priorDoc.rowCount&&(priorDoc.rows[0].owner_id!==job.owner_ref||priorDoc.rows[0].content_sha256!==job.content_sha256||priorDoc.rows[0].report_kind!=='position'))throw new Conflict('SOURCE_DOCUMENT_CONFLICT');
  const existingJob=await c.query('SELECT document_id,content_sha256,row_count FROM app.ingested_import_jobs WHERE household_id=$1 AND import_job_id=$2 FOR UPDATE',[household,id]);if(existingJob.rowCount){if(existingJob.rows[0].document_id!==documentId||existingJob.rows[0].content_sha256!==job.content_sha256||Number(existingJob.rows[0].row_count)!==records.length)throw new Conflict('INGESTION_BATCH_CHANGED');await c.query('COMMIT');return{document_id:documentId,rows:records.length,new_rows:0,replayed:true,portfolio_published:false};}
  await c.query(`INSERT INTO app.source_documents(household_id,id,owner_id,source_system,report_kind,original_name,content_sha256,storage_key,effective_as_of,coverage_start,coverage_end,date_basis)
   VALUES($1,$2,$3,$4,'position',$5,$6,$7,$8,$9,$10,'statement_reference_date') ON CONFLICT(household_id,id) DO NOTHING`,[household,documentId,job.owner_ref,provider,job.file_name,job.content_sha256,'ingestion:'+job.document_id,referenceDate,job.result.coverage_start,job.result.coverage_end]);
  const doc=await c.query('SELECT owner_id,source_system,content_sha256 FROM app.source_documents WHERE household_id=$1 AND id=$2',[household,documentId]);if(doc.rowCount!==1||doc.rows[0].owner_id!==job.owner_ref||doc.rows[0].source_system!==provider||doc.rows[0].content_sha256!==job.content_sha256)throw new Conflict('SOURCE_DOCUMENT_CONFLICT');
  const providerId='pension-provider-'+sha(provider.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase()).slice(0,24);
  const providerExists=await c.query('SELECT canonical_name,kind FROM app.custody_institutions WHERE id=$1 FOR SHARE',[providerId]);
  if(providerExists.rowCount&&(providerExists.rows[0].canonical_name!==provider||providerExists.rows[0].kind!=='pension_provider'))throw new Conflict('PENSION_PROVIDER_ID_CONFLICT');
  await c.query("INSERT INTO app.custody_institutions(id,canonical_name,kind) VALUES($1,$2,'pension_provider') ON CONFLICT(id) DO NOTHING",[providerId,provider]);
  const pensionAccounts=new Map<string,string>();
  for(const row of records.filter(item=>item.record_kind==='position')){
   const cnpj=String(row.original.fund_cnpj??'').replace(/\D/g,'');if(!/^\d{14}$/.test(cnpj))throw new Conflict('PENSION_FUND_IDENTITY_INVALID',422);
   const custodyId='custody-'+sha([household,job.owner_ref,providerId,cnpj].join('|')).slice(0,32);
   await c.query(`INSERT INTO app.custody_accounts(household_id,id,owner_id,institution_id,external_reference,identity_basis)
    VALUES($1,$2,$3,$4,$5,'observed_reference') ON CONFLICT(household_id,id) DO NOTHING`,[household,custodyId,job.owner_ref,providerId,cnpj]);
   const account=await c.query('SELECT owner_id,institution_id,external_reference FROM app.custody_accounts WHERE household_id=$1 AND id=$2',[household,custodyId]);
   if(account.rows[0]?.owner_id!==job.owner_ref||account.rows[0]?.institution_id!==providerId||account.rows[0]?.external_reference!==cnpj)throw new Conflict('PENSION_CUSTODY_ACCOUNT_CONFLICT');
   pensionAccounts.set(cnpj,custodyId);
  }
  let inserted=0;for(const row of records){const ordinal=Number(row.source_ordinal),raw=row.original,kind=row.record_kind,code=String(raw.instrument_code??''),date=String(kind==='position'?raw.reference_date:raw.trade_date??'');if(!Number.isSafeInteger(ordinal)||ordinal<2||!code||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!exact(String(raw.quantity??'0')).gt(0)||!['position','movement'].includes(kind))throw new Conflict('INVALID_PENSION_RECORD',422);
   const assertionId='assertion-'+sha([documentId,row.source_sheet,ordinal].join('|')),event=kind==='movement'?String(raw.event_type):null,direction=kind==='movement'?String(raw.direction):null;
   const cnpj=String(raw.fund_cnpj??'').replace(/\D/g,'');const custodyId=kind==='position'?pensionAccounts.get(cnpj)??null:null;
   const added=await c.query(`INSERT INTO app.source_assertions(household_id,id,document_id,owner_id,source_sheet,source_row,assertion_kind,institution_id,custody_account_id,instrument_code,asserted_on,source_event_type,tentative_event_type,direction,quantity,raw_row,interpretation_status)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'observed') ON CONFLICT(household_id,document_id,source_sheet,source_row) DO NOTHING RETURNING id`,[household,assertionId,documentId,job.owner_ref,row.source_sheet,ordinal,kind,kind==='position'?providerId:null,custodyId,code,date,event,kind==='movement'?'pension_contribution_observation':'opening_position_observation',direction,exact(String(raw.quantity)).toFixed(),JSON.stringify(raw)]);inserted+=added.rowCount??0;
   const actual=added.rows[0]?.id??(await c.query('SELECT id FROM app.source_assertions WHERE household_id=$1 AND document_id=$2 AND source_sheet=$3 AND source_row=$4',[household,documentId,row.source_sheet,ordinal])).rows[0]?.id;const same=await c.query('SELECT raw_row=$3::jsonb AS same FROM app.source_assertions WHERE household_id=$1 AND id=$2',[household,actual,JSON.stringify(raw)]);if(!actual||same.rows[0]?.same!==true)throw new Conflict('SOURCE_ROW_CONFLICT');
   await c.query(`INSERT INTO app.source_interpretations(household_id,assertion_id,parser_version,instrument_code,tentative_event_type,status,review_reasons) VALUES($1,$2,$3,$4,$5,'parsed','{}') ON CONFLICT DO NOTHING`,[household,actual,job.parser_version,code,kind==='movement'?'pension_contribution_observation':'opening_position_observation']);
  }
  await c.query('INSERT INTO app.ingested_import_jobs(household_id,import_job_id,document_id,content_sha256,parser_version,row_count) VALUES($1,$2,$3,$4,$5,$6)',[household,id,documentId,job.content_sha256,job.parser_version,records.length]);await c.query('COMMIT');return{document_id:documentId,rows:records.length,new_rows:inserted,replayed:false,portfolio_published:false};
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
export async function interpretReadyManualPhotos(db:pg.Pool,household:string){
 let scanned=0,inserted=0;
 for(let offset=0;offset<=1_000_000;offset+=100){
 const response=await ingestionCall(`/v1/manual-evidence/photos?limit=100&offset=${offset}`,'GET',undefined,{'X-Household-Ref':household});
 const items=Array.isArray(response.items)?response.items as Array<Record<string,unknown>>:[];scanned+=items.length;
 for(const item of items){
  if(item.ocr_status!=='completed'||typeof item.upload_id!=='string'||!UUID.test(item.upload_id)||typeof item.owner_ref!=='string'||typeof item.ocr_text!=='string'||typeof item.ocr_text_sha256!=='string'||!/^[0-9a-f]{64}$/.test(item.ocr_text_sha256))continue;
  const owner=await db.query('SELECT 1 FROM app.owners WHERE household_id=$1 AND id=$2',[household,item.owner_ref]);if(!owner.rowCount)continue;
  const parsed=interpretManualTrade(item.ocr_text,typeof item.occurred_on==='string'?item.occurred_on:null);
  const result=await db.query(`INSERT INTO app.manual_photo_trade_interpretations(household_id,upload_id,owner_id,ocr_text_sha256,parser_version,interpretation_status,fields,review_reasons)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(household_id,upload_id,ocr_text_sha256,parser_version) DO NOTHING RETURNING upload_id`,[household,item.upload_id,item.owner_ref,item.ocr_text_sha256,parsed.parser_version,parsed.status,JSON.stringify(parsed.fields),parsed.review_reasons]);
  inserted+=result.rowCount??0;
 }
 if(items.length<100)break;
 }
 return{scanned,inserted};
}
export async function ingestB3Batch(db:pg.Pool,household:string,id:string){
 if(!UUID.test(id))throw new Conflict('NOT_FOUND',404);
 const {job,records}=validBatch(await ingestionCall(`/v1/import-jobs/${id}/records`,'GET',undefined,{'X-Household-Ref':household}),id);
 const owner=await db.query('SELECT 1 FROM app.owners WHERE household_id=$1 AND id=$2',[household,job.owner_ref]);if(!owner.rowCount)throw new Conflict('UNKNOWN_OWNER',422);
 const reportKind=job.file_type==='positions'?'position':'movement';if(reportKind==='position'&&!date(job.reference_date))throw new Conflict('REFERENCE_DATE_REQUIRED',422);
 const documentId='b3-'+sha([household,job.owner_ref,reportKind,job.content_sha256].join('|')).slice(0,32);
 const aliases=await db.query('SELECT normalized_alias,institution_id FROM app.custody_institution_aliases');const byAlias=new Map<string,string>(aliases.rows.map(row=>[String(row.normalized_alias),String(row.institution_id)]));
 const accounts=await db.query("SELECT id,institution_id,external_reference FROM app.custody_accounts WHERE household_id=$1 AND owner_id=$2 AND identity_basis<>'pending'",[household,job.owner_ref]);const byInstitution=new Map<string,Array<{id:string;external_reference:string|null}>>();for(const row of accounts.rows){const key=String(row.institution_id),list=byInstitution.get(key)??[];list.push({id:String(row.id),external_reference:row.external_reference});byInstitution.set(key,list);}
 const treasury=new Map<string,string|null>();const known=await db.query("SELECT raw_row FROM app.source_assertions WHERE household_id=$1 AND owner_id=$2 AND source_sheet='Tesouro Direto' AND assertion_kind='position'",[household,job.owner_ref]);
 for(const item of [...known.rows.map(row=>row.raw_row as Raw),...records.filter(row=>row.source_sheet==='Tesouro Direto'&&row.record_kind==='position').map(row=>row.original)]){const name=norm(item.Produto),isin=clean(item['Código ISIN']);if(isin)treasury.set(name,treasury.has(name)&&treasury.get(name)!==isin?null:isin);}
 const c=await db.connect();try{await c.query('BEGIN');
  const prior=await c.query('SELECT document_id,content_sha256,row_count FROM app.ingested_import_jobs WHERE household_id=$1 AND import_job_id=$2 FOR UPDATE',[household,id]);if(prior.rowCount){if(prior.rows[0].document_id!==documentId||prior.rows[0].content_sha256!==job.content_sha256||Number(prior.rows[0].row_count)!==records.length)throw new Conflict('INGESTION_BATCH_CHANGED');await c.query('COMMIT');return{document_id:documentId,rows:records.length,new_rows:0,replayed:true,portfolio_published:false};}
  await c.query(`INSERT INTO app.source_documents(household_id,id,owner_id,source_system,report_kind,original_name,content_sha256,storage_key,effective_as_of,coverage_start,coverage_end,date_basis) VALUES($1,$2,$3,'B3',$4,$5,$6,$7,$8,$9,$10,'ingestion_declared') ON CONFLICT(household_id,id) DO NOTHING`,[household,documentId,job.owner_ref,reportKind,job.file_name,job.content_sha256,'ingestion:'+job.document_id,reportKind==='position'?job.reference_date:null,job.result.coverage_start,job.result.coverage_end]);
  const document=await c.query('SELECT content_sha256,owner_id,report_kind FROM app.source_documents WHERE household_id=$1 AND id=$2',[household,documentId]);if(document.rows[0]?.content_sha256!==job.content_sha256||document.rows[0]?.owner_id!==job.owner_ref||document.rows[0]?.report_kind!==reportKind)throw new Conflict('SOURCE_DOCUMENT_CONFLICT');
  let inserted=0,needsReview=0;
  for(const row of records){const ordinal=Number(row?.source_ordinal);if(!row||row.record_kind!==reportKind||!row.original||typeof row.original!=='object'||!Number.isSafeInteger(ordinal)||ordinal<2||!row.source_sheet||typeof row.original_sha256!=='string')throw new Conflict('INVALID_INGESTION_ROW',422);
   const raw=row.original,inst=byAlias.get(norm(raw.Instituição))??null,accountCandidates=inst?byInstitution.get(inst)??[]:[],ref=clean(raw.Conta),account=accountCandidates.length===1&&(!ref||!accountCandidates[0].external_reference||accountCandidates[0].external_reference===ref)?accountCandidates[0].id:null,instrument=code(raw,treasury),event=reportKind==='movement'?tentative(raw.Movimentação):null,assertedOn=reportKind==='movement'?date(raw.Data):date(job.reference_date);
   const reasons:string[]=[];if(!inst||!account)reasons.push('custody_account_pending');if(!instrument)reasons.push('instrument_pending');if(!assertedOn)reasons.push('date_pending');if(event==='unclassified_observation'||event==='correction_observation')reasons.push('event_semantics_pending');if(event==='custody_transfer_observation')reasons.push('transfer_counterparty_pending');if(reasons.length)needsReview++;
   const quantity=clean(raw.Quantidade)&&clean(raw.Quantidade)!=='-'?exact(String(raw.Quantidade)).toFixed():null,assertionId='assertion-'+sha([documentId,row.source_sheet,ordinal].join('|')).slice(0,32);
   const added=await c.query(`INSERT INTO app.source_assertions(household_id,id,document_id,owner_id,source_sheet,source_row,assertion_kind,institution_id,custody_account_id,instrument_code,asserted_on,source_event_type,tentative_event_type,direction,quantity,raw_row,interpretation_status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) ON CONFLICT(household_id,id) DO NOTHING`,[household,assertionId,documentId,job.owner_ref,row.source_sheet,ordinal,reportKind,inst,account,instrument,assertedOn,reportKind==='movement'?clean(raw.Movimentação):null,event,reportKind==='movement'?clean(raw['Entrada/Saída']):null,quantity,raw,reasons.length?'needs_review':'observed']);inserted+=added.rowCount??0;
   const original=await c.query('SELECT raw_row=$3::jsonb AS same FROM app.source_assertions WHERE household_id=$1 AND id=$2',[household,assertionId,JSON.stringify(raw)]);if(original.rows[0]?.same!==true)throw new Conflict('SOURCE_ROW_CONFLICT');
   await c.query(`INSERT INTO app.source_interpretations(household_id,assertion_id,parser_version,instrument_code,tentative_event_type,status,review_reasons) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,[household,assertionId,PARSER,instrument,event,reasons.length?'needs_review':'parsed',reasons]);
  }
  await c.query('INSERT INTO app.ingested_import_jobs(household_id,import_job_id,document_id,content_sha256,parser_version,row_count) VALUES($1,$2,$3,$4,$5,$6)',[household,id,documentId,job.content_sha256,job.parser_version,records.length]);
  await c.query('COMMIT');return{document_id:documentId,rows:records.length,new_rows:inserted,needs_review:needsReview,replayed:false,portfolio_published:false};
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
