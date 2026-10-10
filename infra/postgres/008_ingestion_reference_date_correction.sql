-- Correct parser metadata produced before DATE values were kept as ISO strings.
-- Raw source rows and the original DocumentParsed event remain immutable.
WITH corrected AS (
  UPDATE ingestion.import_jobs j
  SET result=jsonb_set(j.result,'{reference_date}',to_jsonb(a.reference_date::text)),updated_at=now()
  FROM ingestion.document_assignments a
  WHERE j.assignment_id=a.id AND a.source='b3' AND a.file_type='positions'
    AND a.reference_date IS NOT NULL AND j.result IS NOT NULL
    AND j.result->>'reference_date' IS DISTINCT FROM a.reference_date::text
  RETURNING j.id,j.document_id,j.assignment_id,a.household_ref,a.reference_date
)
INSERT INTO ingestion.outbox(event_id,event_type,payload)
SELECT gen_random_uuid(),'DocumentParseMetadataCorrected',jsonb_build_object(
  'import_job_id',id,'document_id',document_id,'assignment_id',assignment_id,
  'household_ref',household_ref,'reference_date',reference_date::text)
FROM corrected;
