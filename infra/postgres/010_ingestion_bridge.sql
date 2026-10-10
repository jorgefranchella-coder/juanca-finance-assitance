-- Idempotent receipt of parsed batches from the independent ingestion service.
CREATE TABLE app.ingested_import_jobs (
  household_id TEXT NOT NULL,
  import_job_id UUID NOT NULL,
  document_id TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  parser_version TEXT NOT NULL,
  row_count INTEGER NOT NULL CHECK (row_count>=0),
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (household_id,import_job_id),
  FOREIGN KEY (household_id,document_id) REFERENCES app.source_documents(household_id,id)
);
