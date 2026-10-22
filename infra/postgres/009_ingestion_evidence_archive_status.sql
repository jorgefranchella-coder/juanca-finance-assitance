-- The application bridge archives parser output as source evidence. That is
-- not publication of a financial portfolio version.
ALTER TABLE ingestion.import_jobs DROP CONSTRAINT IF EXISTS import_jobs_status_check;
UPDATE ingestion.import_jobs SET status='evidence_archived',updated_at=now() WHERE status='published';
ALTER TABLE ingestion.import_jobs ADD CONSTRAINT import_jobs_status_check
  CHECK(status IN ('queued','parsing','awaiting_review','ready','publishing','published','evidence_archived','failed_retryable','failed_terminal'));
