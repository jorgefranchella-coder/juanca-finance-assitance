import {readFile} from 'node:fs/promises';
import {pool} from './db.ts';
import {acknowledgeImportJob,ingestAvenueBatch,ingestAvenueConfirmationBatch,ingestB3Batch,ingestPensionBatch,interpretReadyManualPhotos,readyImportJobs} from './ingestion-bridge.ts';
import {generateB3CandidateReports} from './b3-candidate-reports.ts';

const config=JSON.parse(await readFile(process.env.JUANCA_SHADOW_CONFIG??'/home/jorge/.local/share/juanca-shadow/application.json','utf8')) as {household_id:string};
if(!config.household_id)throw new Error('INVALID_CONFIGURATION');
const db=pool();let stopping=false;const once=process.argv.includes('--once');
process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
try{while(!stopping){
 const jobs=await readyImportJobs(config.household_id);
 for(const job of jobs){if(stopping)break;const prior=await db.query('SELECT 1 FROM app.ingested_import_jobs WHERE household_id=$1 AND import_job_id=$2',[config.household_id,job.id]);
  try{if(prior.rowCount){await acknowledgeImportJob(config.household_id,job.id);continue;}const result=job.source==='avenue'&&job.file_type==='avenue_statement'?await ingestAvenueBatch(db,config.household_id,job.id):job.source==='avenue'&&job.file_type==='avenue_confirmation'?await ingestAvenueConfirmationBatch(db,config.household_id,job.id):job.source==='pension'&&job.file_type==='pension_statement'?await ingestPensionBatch(db,config.household_id,job.id):await ingestB3Batch(db,config.household_id,job.id);await acknowledgeImportJob(config.household_id,job.id);console.log(JSON.stringify({import_job_id:job.id,rows:result.rows,new_rows:result.new_rows,status:'evidence_only'}));}catch(error){console.error(JSON.stringify({import_job_id:job.id,error:error instanceof Error?error.message:'BRIDGE_FAILED'}));if(once)throw error;}
 }
 try{const photos=await interpretReadyManualPhotos(db,config.household_id);if(photos.inserted)console.log(JSON.stringify({manual_photo_interpretations_written:photos.inserted,scanned:photos.scanned}));}catch(error){console.error(JSON.stringify({manual_photo_interpretation_error:error instanceof Error?error.message:'PHOTO_INTERPRETATION_FAILED'}));if(once)throw error;}
 try{const reports=await generateB3CandidateReports(db,config.household_id);if(reports.length)console.log(JSON.stringify({b3_candidate_reports_written:reports.length}));}catch(error){console.error(JSON.stringify({b3_candidate_report_error:error instanceof Error?error.message:'REPORT_FAILED'}));if(once)throw error;}
 if(once)break;await new Promise(resolve=>setTimeout(resolve,30000));
}}finally{await db.end();}
