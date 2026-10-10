/** Register B3 workbooks as immutable custody evidence in the shadow database. */
import * as XLSX from 'xlsx';
import {createHash} from 'node:crypto';
import {basename,join} from 'node:path';
import {chmod,copyFile,mkdir,readFile} from 'node:fs/promises';
import {pool,migrate} from '../../services/application/src/db.ts';
import {exact} from '../../services/application/src/money.ts';

type Row=Record<string,unknown>;
type Assertion={id:string;sheet:string;row:number;kind:'position'|'movement';institution:string|null;account:string|null;code:string|null;date:string|null;event:string|null;tentative:string|null;direction:string|null;quantity:string|null;raw:Row;review:boolean};
const evidenceRoot='/home/jorge/.local/share/juanca-shadow/evidence/b3';
const aliases:Record<string,{id:string;name:string;kind:'custodian'}>={
 'ITAU CORRETORA DE VALORES S A':{id:'itau-corretora',name:'Itaú Corretora de Valores',kind:'custodian'},
 'ITAU CV S A':{id:'itau-corretora',name:'Itaú Corretora de Valores',kind:'custodian'},
 'ITAU UNIBANCO S A':{id:'itau-unibanco',name:'Itaú Unibanco',kind:'custodian'},
 'BANCO BTG PACTUAL S A':{id:'btg-pactual',name:'BTG Pactual',kind:'custodian'},
 'XP INVESTIMENTOS CCTVM S A':{id:'xp-investimentos',name:'XP Investimentos',kind:'custodian'}
};
function sha(value:string|Buffer){return createHash('sha256').update(value).digest('hex');}
function norm(value:unknown){return String(value??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/[^A-Z0-9]+/g,' ').trim().replace(/\s+/g,' ');}
function clean(value:unknown){return String(value??'').trim().replace(/\s+/g,' ');}
function iso(value:unknown):string|null{if(value instanceof Date&&!Number.isNaN(value.getTime()))return value.toISOString().slice(0,10);const m=/^(\d{2})\/(\d{2})\/(\d{4})$/.exec(clean(value));return m?`${m[3]}-${m[2]}-${m[1]}`:/^\d{4}-\d{2}-\d{2}$/.test(clean(value))?clean(value):null;}
function qty(value:unknown){if(value===null||value===undefined||clean(value)===''||clean(value)==='-')return null;return exact(String(value)).toFixed();}
function code(row:Row,position:boolean){const explicit=position?row.Código??row['Código de Negociação']??row['Código ISIN']??row['Código ISIN / Distribuição']:null;if(clean(explicit)&&clean(explicit)!=='-')return clean(explicit).split(' - ')[0];const first=clean(row.Produto).split(' - ')[0];return /^[A-Z0-9]{4,30}$/.test(first)?first:null;}
function tentativeMovement(value:unknown){const s=norm(value);if(s==='TRANSFERENCIA LIQUIDACAO')return 'settlement_observation';if(s.includes('TRANSFERENCIA SEM FINANCEIRO')||s.includes('RETIRADA DE CUSTODIA'))return 'custody_transfer_observation';if(s.includes('ATUALIZACAO')||s.includes('BONIFICACAO')||s.includes('SUBSCRICAO'))return 'corporate_action_observation';if(s.includes('EXCLUIDO')||s.includes('REATIVADO'))return 'correction_observation';if(s.includes('JUROS')||s.includes('DIVIDENDO')||s.includes('RENDIMENTO'))return 'income_observation';if(s.includes('VENCIMENTO')||s.includes('RESGATE'))return 'redemption_observation';if(s.includes('APLICACAO')||s==='COMPRA')return 'acquisition_observation';if(s.includes('COMPRA')||s.includes('VENDA'))return 'trade_observation';return 'unclassified_observation';}
function rowsOf(workbook:XLSX.WorkBook,kind:'position'|'movement'){
 const result:Assertion[]=[];
 for(const sheet of workbook.SheetNames){if(kind==='movement'&&sheet!=='Movimentação')continue;if(kind==='position'&&sheet==='Movimentação')continue;
  for(const raw of XLSX.utils.sheet_to_json<Row>(workbook.Sheets[sheet],{defval:null})){
   const row=Number((raw as Row&{__rowNum__?:number}).__rowNum__??NaN)+1;
   if(!Number.isInteger(row)||row<2)throw new Error('INVALID_SOURCE_ROW');
   if(!clean(raw.Produto)||!clean(raw.Instituição))continue;
   const institution=aliases[norm(raw.Instituição)]?.id??null;
   const date=kind==='movement'?iso(raw.Data):null;if(kind==='movement'&&!date)throw new Error('INVALID_MOVEMENT_DATE');
   const movement=kind==='movement'?clean(raw.Movimentação):null;
   result.push({id:'',sheet,row,kind,institution,account:kind==='position'?clean(raw.Conta)||null:null,code:code(raw,kind==='position'),date,event:movement,tentative:movement?tentativeMovement(movement):null,direction:kind==='movement'?clean(raw['Entrada/Saída']):null,quantity:qty(raw.Quantidade),raw,review:!institution||kind==='movement'&&(!code(raw,false)||tentativeMovement(movement)==='unclassified_observation')});
  }
 }
 return result;
}

const [ownerName,positionPath,movementPath]=process.argv.slice(2);
if(!ownerName||!positionPath||!movementPath)throw new Error('Usage: register_b3_documents.ts owner position.xlsx movement.xlsx');
const inputs=[{kind:'position' as const,path:positionPath},{kind:'movement' as const,path:movementPath}];
const prepared=[];
for(const input of inputs){const bytes=await readFile(input.path),name=basename(input.path),fileHash=sha(bytes);
 const fileDate=/-(\d{4}-\d{2}-\d{2})-/.exec(name)?.[1];if(!fileDate)throw new Error('FILENAME_DATE_REQUIRED');
 const workbook=XLSX.read(bytes,{type:'buffer',cellDates:true});const rows=rowsOf(workbook,input.kind);
 if(input.kind==='position'&&!rows.length||input.kind==='movement'&&!rows.length)throw new Error('EMPTY_B3_REPORT');
 const dates=rows.map(x=>x.date).filter((x):x is string=>!!x).sort();
 prepared.push({...input,name,fileHash,fileDate,rows,coverageStart:dates[0]??null,coverageEnd:dates.at(-1)??null,bytes});
}
const db=pool();
try{
 await migrate(db);
 const owners=await db.query('SELECT household_id,id FROM app.owners WHERE display_name=$1',[ownerName]);if(owners.rowCount!==1)throw new Error('OWNER_NOT_UNIQUE');
 const h=String(owners.rows[0].household_id),owner=String(owners.rows[0].id),actor='legacy-shared:'+h;
 await mkdir(evidenceRoot,{recursive:true,mode:0o700});await chmod(evidenceRoot,0o700);
 for(const item of prepared){const dest=join(evidenceRoot,item.fileHash+'.xlsx');try{const prior=await readFile(dest);if(sha(prior)!==item.fileHash)throw new Error('EVIDENCE_HASH_CONFLICT');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;await copyFile(item.path,dest);await chmod(dest,0o600);const copied=await readFile(dest);if(sha(copied)!==item.fileHash)throw new Error('EVIDENCE_COPY_MISMATCH');}}
 const c=await db.connect();try{
  await c.query('BEGIN');
  for(const [alias,canonical] of Object.entries(aliases)){
   await c.query('INSERT INTO app.custody_institutions(id,canonical_name,kind) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING',[canonical.id,canonical.name,canonical.kind]);
   await c.query('INSERT INTO app.custody_institution_aliases(normalized_alias,institution_id) VALUES($1,$2) ON CONFLICT(normalized_alias) DO NOTHING',[alias,canonical.id]);
  }
  const refs=new Map<string,Set<string>>();for(const item of prepared)for(const row of item.rows)if(row.institution&&row.account)(refs.get(row.institution)??refs.set(row.institution,new Set()).get(row.institution)!).add(row.account);
  for(const [inst,values] of refs)if(values.size>1)throw new Error('MULTIPLE_ACCOUNTS_PER_INSTITUTION');
  const accountIds=new Map<string,string>();for(const inst of ['itau-corretora','itau-unibanco','btg-pactual']){
   const ref=[...(refs.get(inst)??[])][0]??null,id='custody-'+sha([h,owner,inst].join('|')).slice(0,24);accountIds.set(inst,id);
   const existing=await c.query('SELECT external_reference FROM app.custody_accounts WHERE household_id=$1 AND id=$2',[h,id]);
   if(existing.rowCount&&ref&&existing.rows[0].external_reference&&existing.rows[0].external_reference!==ref)throw new Error('ACCOUNT_REFERENCE_CONFLICT');
   await c.query(`INSERT INTO app.custody_accounts(household_id,id,owner_id,institution_id,external_reference,identity_basis) VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT(household_id,id) DO UPDATE SET external_reference=COALESCE(app.custody_accounts.external_reference,EXCLUDED.external_reference),identity_basis=CASE WHEN EXCLUDED.external_reference IS NOT NULL THEN 'observed_reference' ELSE app.custody_accounts.identity_basis END`,[h,id,owner,inst,ref,ref?'observed_reference':'user_confirmed_unique']);
  }
  const results=[];
  for(const item of prepared){const documentId='b3-'+sha([h,owner,item.kind,item.fileHash].join('|')).slice(0,32);
   await c.query(`INSERT INTO app.source_documents(household_id,id,owner_id,source_system,report_kind,original_name,content_sha256,storage_key,effective_as_of,coverage_start,coverage_end,date_basis)
    VALUES($1,$2,$3,'B3',$4,$5,$6,$7,$8,$9,$10,'user_confirmed_filename') ON CONFLICT(household_id,id) DO NOTHING`,[h,documentId,owner,item.kind,item.name,item.fileHash,item.fileHash+'.xlsx',item.kind==='position'?item.fileDate:null,item.coverageStart,item.coverageEnd]);
   let inserted=0,review=0;
   for(const row of item.rows){const id='assertion-'+sha([documentId,row.sheet,row.row].join('|')).slice(0,32),account=row.institution?accountIds.get(row.institution)??null:null,status=row.review||!account?'needs_review':'observed';if(status==='needs_review')review++;
    const res=await c.query(`INSERT INTO app.source_assertions(household_id,id,document_id,owner_id,source_sheet,source_row,assertion_kind,institution_id,custody_account_id,instrument_code,asserted_on,source_event_type,tentative_event_type,direction,quantity,raw_row,interpretation_status)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) ON CONFLICT(household_id,id) DO NOTHING`,[h,id,documentId,owner,row.sheet,row.row,row.kind,row.institution,account,row.code,row.date??(row.kind==='position'?item.fileDate:null),row.event,row.tentative,row.direction,row.quantity,JSON.stringify(row.raw),status]);inserted+=res.rowCount??0;
   }
   if(inserted)await c.query("INSERT INTO app.audit_log(household_id,actor_id,action,resource_id,details) VALUES($1,$2,'b3_evidence_registered',$3,$4)",[h,actor,documentId,{report_kind:item.kind,source_sha256:item.fileHash,rows:item.rows.length,inserted,source_owner_confirmation:'user_in_work_session',account_cardinality_confirmation:'one_per_institution_user_in_work_session',financial_live_system_modified:false}]);
   results.push({kind:item.kind,document_id:documentId,rows:item.rows.length,new_rows:inserted,initial_parse_needs_review:review,coverage_start:item.coverageStart,coverage_end:item.coverageEnd,effective_as_of:item.kind==='position'?item.fileDate:null});
  }
  await c.query('COMMIT');console.log(JSON.stringify({registered:results,financial_live_system_modified:false,portfolio_published:false}));
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}finally{await db.end();}
