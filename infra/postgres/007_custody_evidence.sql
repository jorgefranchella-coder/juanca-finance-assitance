-- F3 shadow: canonical custody identity and immutable observations from new sources.
-- These tables do not change the published portfolio until a reconciliation is approved.
CREATE TABLE app.custody_institutions (
  id TEXT PRIMARY KEY,
  canonical_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('custodian','pension_provider'))
);
CREATE TABLE app.custody_institution_aliases (
  normalized_alias TEXT PRIMARY KEY,
  institution_id TEXT NOT NULL REFERENCES app.custody_institutions(id)
);
CREATE TABLE app.custody_accounts (
  household_id TEXT NOT NULL,
  id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  institution_id TEXT NOT NULL REFERENCES app.custody_institutions(id),
  external_reference TEXT,
  identity_basis TEXT NOT NULL CHECK (identity_basis IN ('observed_reference','user_confirmed_unique','pending')),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (household_id,id),
  FOREIGN KEY (household_id,owner_id) REFERENCES app.owners(household_id,id)
);
CREATE UNIQUE INDEX custody_account_external_ref ON app.custody_accounts(household_id,owner_id,institution_id,external_reference) WHERE external_reference IS NOT NULL;
CREATE TABLE app.source_documents (
  household_id TEXT NOT NULL,
  id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  source_system TEXT NOT NULL,
  report_kind TEXT NOT NULL CHECK (report_kind IN ('position','movement','photo','manual_text')),
  original_name TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256)=64),
  storage_key TEXT NOT NULL,
  effective_as_of DATE,
  coverage_start DATE,
  coverage_end DATE,
  date_basis TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'evidence_only' CHECK (status IN ('evidence_only','reconciled','applied','superseded')),
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (household_id,id),
  UNIQUE (household_id,owner_id,source_system,report_kind,content_sha256),
  FOREIGN KEY (household_id,owner_id) REFERENCES app.owners(household_id,id)
);
CREATE TABLE app.source_assertions (
  household_id TEXT NOT NULL,
  id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  source_sheet TEXT NOT NULL,
  source_row INTEGER NOT NULL CHECK (source_row>1),
  assertion_kind TEXT NOT NULL CHECK (assertion_kind IN ('position','movement')),
  institution_id TEXT REFERENCES app.custody_institutions(id),
  custody_account_id TEXT,
  instrument_code TEXT,
  asserted_on DATE,
  source_event_type TEXT,
  tentative_event_type TEXT,
  direction TEXT,
  quantity app.exact_decimal,
  raw_row JSONB NOT NULL,
  interpretation_status TEXT NOT NULL CHECK (interpretation_status IN ('observed','needs_review')),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (household_id,id),
  UNIQUE (household_id,document_id,source_sheet,source_row),
  FOREIGN KEY (household_id,document_id) REFERENCES app.source_documents(household_id,id),
  FOREIGN KEY (household_id,owner_id) REFERENCES app.owners(household_id,id),
  FOREIGN KEY (household_id,custody_account_id) REFERENCES app.custody_accounts(household_id,id)
);
CREATE INDEX source_assertions_account_date ON app.source_assertions(household_id,custody_account_id,asserted_on);
