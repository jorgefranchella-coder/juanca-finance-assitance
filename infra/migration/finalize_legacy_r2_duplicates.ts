import {pool} from '../../services/application/src/db.ts';

const db=pool('juanca_ingestion');
const duplicateError='duplicate key value violates unique constraint "import_job_document_revision"%';
try{
  await db.query('BEGIN');
  const updated=await db.query(`UPDATE ingestion.import_jobs duplicate
    SET status='failed_terminal',last_error='DUPLICATE_DOCUMENT_ALREADY_PARSED',
        lease_token=NULL,lease_until=NULL,updated_at=now()
    FROM ingestion.upload_jobs upload
    WHERE upload.id=duplicate.upload_job_id AND upload.request_key LIKE 'legacy-r2:%'
      AND duplicate.status='failed_retryable' AND duplicate.last_error LIKE $1
      AND EXISTS(SELECT 1 FROM ingestion.import_jobs prior
        WHERE prior.id<>duplicate.id AND prior.document_id=duplicate.document_id
          AND prior.assignment_id=duplicate.assignment_id AND prior.status='awaiting_review'
          AND prior.parser_version<>'pending'
          AND EXISTS(SELECT 1 FROM ingestion.raw_records raw WHERE raw.import_job_id=prior.id))
    RETURNING duplicate.id`,[duplicateError]);
  const unresolved=await db.query(`SELECT count(*)::int AS count FROM ingestion.import_jobs duplicate
    JOIN ingestion.upload_jobs upload ON upload.id=duplicate.upload_job_id
    WHERE upload.request_key LIKE 'legacy-r2:%' AND duplicate.status='failed_retryable'
      AND duplicate.last_error LIKE $1`,[duplicateError]);
  if(Number(unresolved.rows[0].count)!==0)throw new Error('UNRESOLVED_DUPLICATE_PARSER_JOBS');
  await db.query('COMMIT');
  console.log(JSON.stringify({duplicate_jobs_closed:updated.rowCount??0,existing_parsed_documents_reused:true}));
}catch(error){await db.query('ROLLBACK');throw error;}finally{await db.end();}
