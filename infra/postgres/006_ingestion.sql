CREATE SCHEMA IF NOT EXISTS ingestion AUTHORIZATION juanca_ingestion;
CREATE TABLE IF NOT EXISTS ingestion.schema_migrations(id TEXT PRIMARY KEY,sha256 TEXT NOT NULL,applied_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE ingestion.documents(
  id UUID PRIMARY KEY,
  content_sha256 TEXT NOT NULL UNIQUE CHECK(content_sha256 ~ '^[0-9a-f]{64}$'),
  byte_size BIGINT NOT NULL CHECK(byte_size>0 AND byte_size<=30000000),
  content_type TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE ingestion.document_assignments(
  id UUID PRIMARY KEY,
  document_id UUID NOT NULL REFERENCES ingestion.documents(id),
  household_ref TEXT NOT NULL,
  owner_ref TEXT NOT NULL,
  account_ref TEXT,
  source TEXT NOT NULL CHECK(source IN ('b3','avenue','pension','manual')),
  file_type TEXT NOT NULL CHECK(file_type IN ('positions','movements','avenue_statement','avenue_confirmation','pension_statement','manual_evidence')),
  reference_date DATE,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX document_assignment_identity ON ingestion.document_assignments(document_id,household_ref,owner_ref,source,file_type,COALESCE(reference_date,'0001-01-01'::date),COALESCE(account_ref,''));
CREATE INDEX document_assignments_scope ON ingestion.document_assignments(household_ref,owner_ref,assigned_at DESC);
CREATE TABLE ingestion.upload_jobs(
  id UUID PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
  household_ref TEXT NOT NULL,
  owner_ref TEXT NOT NULL,
  account_ref TEXT,
  source TEXT NOT NULL,
  file_type TEXT NOT NULL,
  reference_date DATE,
  file_name TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK(content_sha256 ~ '^[0-9a-f]{64}$'),
  expected_size BIGINT NOT NULL CHECK(expected_size>0 AND expected_size<=30000000),
  content_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('awaiting_upload','receiving','stored','failed_retryable','failed_terminal')),
  document_id UUID REFERENCES ingestion.documents(id),
  assignment_id UUID REFERENCES ingestion.document_assignments(id),
  lease_until TIMESTAMPTZ,
  lease_token UUID,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE ingestion.import_jobs(
  id UUID PRIMARY KEY,
  upload_job_id UUID NOT NULL REFERENCES ingestion.upload_jobs(id),
  document_id UUID NOT NULL REFERENCES ingestion.documents(id),
  assignment_id UUID NOT NULL REFERENCES ingestion.document_assignments(id),
  status TEXT NOT NULL CHECK(status IN ('queued','parsing','awaiting_review','ready','publishing','published','failed_retryable','failed_terminal')),
  parser_version TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_until TIMESTAMPTZ,
  lease_token UUID,
  result JSONB,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX import_jobs_claim ON ingestion.import_jobs(available_at,created_at) WHERE status IN ('queued','parsing','failed_retryable');
CREATE TABLE ingestion.raw_records(
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  import_job_id UUID NOT NULL REFERENCES ingestion.import_jobs(id),
  source_ordinal BIGINT NOT NULL CHECK(source_ordinal>=0),
  record_kind TEXT NOT NULL,
  original JSONB NOT NULL,
  original_sha256 TEXT NOT NULL CHECK(original_sha256 ~ '^[0-9a-f]{64}$'),
  parser_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(import_job_id,source_ordinal,parser_version)
);
CREATE UNIQUE INDEX import_job_document_revision ON ingestion.import_jobs(document_id,assignment_id,parser_version);
CREATE TABLE ingestion.published_batches(
  id UUID PRIMARY KEY,
  import_job_id UUID NOT NULL REFERENCES ingestion.import_jobs(id),
  household_ref TEXT NOT NULL,
  record_count BIGINT NOT NULL CHECK(record_count>=0),
  manifest JSONB NOT NULL,
  manifest_sha256 TEXT NOT NULL CHECK(manifest_sha256 ~ '^[0-9a-f]{64}$'),
  parser_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('published','superseded')),
  supersedes_batch_id UUID REFERENCES ingestion.published_batches(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(import_job_id,parser_version)
);
CREATE TABLE ingestion.outbox(
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id UUID NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_until TIMESTAMPTZ,
  lease_token UUID,
  last_error TEXT
);
CREATE INDEX outbox_pending ON ingestion.outbox(available_at,id) WHERE published_at IS NULL;
REVOKE ALL ON SCHEMA ingestion FROM PUBLIC;
GRANT USAGE ON SCHEMA ingestion TO juanca_ingestion;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ingestion TO juanca_ingestion;
