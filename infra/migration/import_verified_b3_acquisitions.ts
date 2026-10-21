import {readFile} from 'node:fs/promises';
import {pool,migrate} from '../../services/application/src/db.ts';
import {localized} from '../../services/application/src/money.ts';
import {recordAcquisitionLot} from '../../services/application/src/acquisition-lots.ts';

const application=JSON.parse(await readFile(process.env.JUANCA_SHADOW_CONFIG??'/home/jorge/.local/share/juanca-shadow/application.json','utf8')) as {household_id:string};
const web=JSON.parse(await readFile(process.env.JUANCA_WEB_CREDENTIALS??'/home/jorge/.hermes/profiles/juanca/workspace/patrimonio-familiar-source/integration/credentials.json','utf8')) as {user_id:string};
if(!application.household_id||!web.user_id)throw new Error('MIGRATION_CONFIG_INVALID');
const db=pool();
try{
 await migrate(db);
 const candidates=await db.query(`SELECT a.id AS assertion_id,a.owner_id,a.asserted_on::text AS effective_date,a.quantity::text AS quantity,
   a.raw_row->>'Preço unitário' AS unit_price,p.id AS position_id,p.currency
   FROM app.source_assertions a JOIN app.source_documents d ON d.household_id=a.household_id AND d.id=a.document_id
   JOIN LATERAL (SELECT instrument_code,tentative_event_type,status FROM app.source_interpretations i
     WHERE i.household_id=a.household_id AND i.assertion_id=a.id ORDER BY interpreted_at DESC,parser_version DESC LIMIT 1) i ON true
   JOIN app.position_identities p ON p.household_id=a.household_id AND p.owner_id=a.owner_id AND p.institution_id=a.institution_id
     AND p.instrument_code=i.instrument_code AND p.currency='BRL'
   LEFT JOIN LATERAL (SELECT custody_account_id FROM app.position_identity_resolutions r
     WHERE r.household_id=p.household_id AND r.position_id=p.id ORDER BY revision DESC LIMIT 1) r ON true
   WHERE a.household_id=$1 AND d.source_system='B3' AND d.report_kind='movement'
     AND a.assertion_kind='movement' AND i.status='parsed'
     AND i.tentative_event_type='acquisition_observation' AND a.direction='Credito'
     AND COALESCE(r.custody_account_id,p.custody_account_id)=a.custody_account_id
   ORDER BY a.asserted_on,a.id`,[application.household_id]);
 if(!candidates.rowCount)throw new Error('NO_VERIFIED_B3_ACQUISITIONS');
 const feesUnknown=candidates.rows.filter(row=>!row.unit_price||localized(row.unit_price)===null).length;
 let recorded=0,replayed=0;
 for(const row of candidates.rows){
  const price=localized(row.unit_price);if(!price)continue;
  const result=await recordAcquisitionLot(db,application.household_id,web.user_id,String(row.position_id),{
   request_key:`b3-acquisition-${row.assertion_id}`,
   effective_date:String(row.effective_date),quantity:String(row.quantity),unit_price:price.toFixed(),fees_minor:null,
   currency:String(row.currency),evidence_kind:'source_assertion',evidence_id:String(row.assertion_id)
  });
  if(result.replayed)replayed++;else recorded++;
 }
 console.log(JSON.stringify({matched_b3_acquisitions:candidates.rowCount,recorded,replayed,excluded_missing_unit_price:feesUnknown,fees_minor:'unknown',portfolio_changed:false}));
}finally{await db.end();}
