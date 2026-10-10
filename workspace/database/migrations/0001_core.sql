CREATE TABLE households (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE people (
    id UUID PRIMARY KEY,
    household_id UUID NOT NULL REFERENCES households(id),
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (household_id, name)
);

CREATE TABLE institutions (
    id UUID PRIMARY KEY,
    canonical_name TEXT NOT NULL UNIQUE
);

CREATE TABLE accounts (
    id UUID PRIMARY KEY,
    person_id UUID NOT NULL REFERENCES people(id),
    institution_id UUID NOT NULL REFERENCES institutions(id),
    external_account_ref TEXT,
    currency CHAR(3) NOT NULL DEFAULT 'BRL',
    UNIQUE (person_id, institution_id, external_account_ref)
);

CREATE TABLE instruments (
    id UUID PRIMARY KEY,
    asset_class TEXT NOT NULL,
    canonical_name TEXT NOT NULL,
    ticker TEXT,
    isin TEXT,
    issuer_name TEXT,
    currency CHAR(3) NOT NULL DEFAULT 'BRL',
    maturity_date DATE,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX idx_instruments_isin ON instruments(isin) WHERE isin IS NOT NULL;

CREATE TABLE instrument_aliases (
    id UUID PRIMARY KEY,
    instrument_id UUID NOT NULL REFERENCES instruments(id),
    provider TEXT NOT NULL,
    alias TEXT NOT NULL,
    UNIQUE(provider, alias)
);

CREATE TABLE source_files (
    id UUID PRIMARY KEY,
    household_id UUID NOT NULL REFERENCES households(id),
    provider TEXT NOT NULL,
    file_name TEXT NOT NULL,
    content_sha256 CHAR(64) NOT NULL UNIQUE,
    reference_date DATE,
    imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    object_key TEXT,
    status TEXT NOT NULL,
    error_message TEXT
);

CREATE TABLE raw_records (
    id UUID PRIMARY KEY,
    source_file_id UUID NOT NULL REFERENCES source_files(id),
    sheet_name TEXT NOT NULL,
    row_number INTEGER NOT NULL,
    payload JSONB NOT NULL,
    UNIQUE(source_file_id, sheet_name, row_number)
);

CREATE TABLE events (
    id UUID PRIMARY KEY,
    person_id UUID NOT NULL REFERENCES people(id),
    account_id UUID REFERENCES accounts(id),
    instrument_id UUID REFERENCES instruments(id),
    source_file_id UUID REFERENCES source_files(id),
    occurred_on DATE NOT NULL,
    event_type TEXT NOT NULL,
    description TEXT NOT NULL,
    requires_review BOOLEAN NOT NULL DEFAULT false,
    classification_version TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_events_person_date ON events(person_id, occurred_on);
CREATE INDEX idx_events_review ON events(requires_review) WHERE requires_review;

CREATE TABLE event_legs (
    id UUID PRIMARY KEY,
    event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    leg_type TEXT NOT NULL,
    amount NUMERIC(24, 8) NOT NULL,
    currency CHAR(3) NOT NULL DEFAULT 'BRL',
    note TEXT
);

CREATE TABLE position_snapshots (
    id UUID PRIMARY KEY,
    person_id UUID NOT NULL REFERENCES people(id),
    account_id UUID REFERENCES accounts(id),
    instrument_id UUID NOT NULL REFERENCES instruments(id),
    source_file_id UUID REFERENCES source_files(id),
    reference_date DATE NOT NULL,
    quantity NUMERIC(24, 8),
    unit_price NUMERIC(24, 8),
    market_value NUMERIC(24, 2) NOT NULL,
    currency CHAR(3) NOT NULL DEFAULT 'BRL',
    UNIQUE(person_id, account_id, instrument_id, reference_date)
);

CREATE INDEX idx_positions_person_date ON position_snapshots(person_id, reference_date);

CREATE TABLE reconciliation_issues (
    id UUID PRIMARY KEY,
    person_id UUID NOT NULL REFERENCES people(id),
    source_file_id UUID REFERENCES source_files(id),
    issue_type TEXT NOT NULL,
    severity TEXT NOT NULL,
    natural_key TEXT NOT NULL,
    expected_value NUMERIC(24, 8),
    observed_value NUMERIC(24, 8),
    difference NUMERIC(24, 8),
    explanation TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    resolved_at TIMESTAMPTZ,
    resolution_note TEXT
);

CREATE INDEX idx_reconciliation_open ON reconciliation_issues(person_id, status) WHERE status = 'open';

CREATE TABLE scenarios (
    id UUID PRIMARY KEY,
    household_id UUID NOT NULL REFERENCES households(id),
    name TEXT NOT NULL,
    version INTEGER NOT NULL,
    assumptions JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(household_id, name, version)
);

CREATE TABLE projection_runs (
    id UUID PRIMARY KEY,
    scenario_id UUID NOT NULL REFERENCES scenarios(id),
    data_as_of DATE NOT NULL,
    engine_version TEXT NOT NULL,
    result JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE recommendations (
    id UUID PRIMARY KEY,
    household_id UUID NOT NULL REFERENCES households(id),
    projection_run_id UUID REFERENCES projection_runs(id),
    code TEXT NOT NULL,
    severity TEXT NOT NULL,
    title TEXT NOT NULL,
    explanation TEXT NOT NULL,
    evidence JSONB NOT NULL,
    policy_version TEXT NOT NULL,
    blocked_by_data_quality BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
