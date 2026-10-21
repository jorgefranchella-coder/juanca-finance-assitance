-- Stable position identity and append-only acquisition lots.
-- This migration stores evidence; it does not rewrite legacy cost_basis or publish holdings.
CREATE TABLE app.position_identities (
  household_id TEXT NOT NULL,
  id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  institution_id TEXT NOT NULL REFERENCES app.custody_institutions(id),
  custody_account_id TEXT,
  instrument_code TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('BRL','USD')),
  identity_status TEXT NOT NULL CHECK (identity_status IN ('resolved','provisional')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (household_id,id),
  FOREIGN KEY (household_id,owner_id) REFERENCES app.owners(household_id,id),
  FOREIGN KEY (household_id,custody_account_id) REFERENCES app.custody_accounts(household_id,id),
  CHECK ((identity_status='resolved' AND custody_account_id IS NOT NULL) OR
         (identity_status='provisional' AND custody_account_id IS NULL))
);
CREATE INDEX position_identity_lookup ON app.position_identities
  (household_id,owner_id,institution_id,instrument_code,currency);
CREATE UNIQUE INDEX position_identity_resolved_unique ON app.position_identities
  (household_id,owner_id,custody_account_id,instrument_code,currency)
  WHERE identity_status='resolved';
CREATE OR REPLACE FUNCTION app.reject_position_identity_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'POSITION_IDENTITIES_IMMUTABLE'; END $$;
CREATE TRIGGER position_identities_immutable
  BEFORE UPDATE OR DELETE ON app.position_identities
  FOR EACH ROW EXECUTE FUNCTION app.reject_position_identity_mutation();

CREATE TABLE app.position_identity_resolutions (
  household_id TEXT NOT NULL,
  id UUID NOT NULL,
  position_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision>0),
  custody_account_id TEXT NOT NULL,
  assertion_id TEXT,
  decision TEXT NOT NULL CHECK (decision IN ('user_confirmed','institution_uniqueness_confirmed')),
  actor_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  supersedes_id UUID,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (household_id,id),
  UNIQUE (household_id,position_id,revision),
  UNIQUE (household_id,actor_id,request_key),
  FOREIGN KEY (household_id,position_id) REFERENCES app.position_identities(household_id,id),
  FOREIGN KEY (household_id,custody_account_id) REFERENCES app.custody_accounts(household_id,id),
  FOREIGN KEY (household_id,assertion_id) REFERENCES app.source_assertions(household_id,id),
  FOREIGN KEY (household_id,actor_id) REFERENCES app.memberships(household_id,actor_id),
  FOREIGN KEY (household_id,supersedes_id) REFERENCES app.position_identity_resolutions(household_id,id)
);
CREATE INDEX position_identity_resolution_latest ON app.position_identity_resolutions
  (household_id,position_id,revision DESC);

CREATE TABLE app.acquisition_lots (
  household_id TEXT NOT NULL,
  id TEXT NOT NULL,
  position_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision>0),
  effective_date DATE NOT NULL,
  quantity app.exact_decimal NOT NULL CHECK (quantity>0),
  unit_price app.exact_decimal NOT NULL CHECK (unit_price>0),
  fees_minor BIGINT NOT NULL DEFAULT 0 CHECK (fees_minor>=0),
  currency TEXT NOT NULL CHECK (currency IN ('BRL','USD')),
  evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('source_assertion','event','manual','legacy_review')),
  evidence_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  actor_id TEXT NOT NULL,
  supersedes_id TEXT,
  supersedes_revision INTEGER,
  voided BOOLEAN NOT NULL DEFAULT false,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (household_id,id,revision),
  UNIQUE (household_id,actor_id,request_key),
  FOREIGN KEY (household_id,position_id) REFERENCES app.position_identities(household_id,id),
  FOREIGN KEY (household_id,actor_id) REFERENCES app.memberships(household_id,actor_id),
  FOREIGN KEY (household_id,supersedes_id,supersedes_revision)
    REFERENCES app.acquisition_lots(household_id,id,revision),
  CHECK ((revision=1 AND supersedes_id IS NULL AND supersedes_revision IS NULL) OR
         (revision>1 AND supersedes_id=id AND supersedes_revision=revision-1))
);
CREATE INDEX acquisition_lot_history ON app.acquisition_lots
  (household_id,position_id,effective_date,recorded_at);

CREATE OR REPLACE FUNCTION app.validate_position_identity_resolution() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE position_owner TEXT; position_institution TEXT; account_owner TEXT; account_institution TEXT;
BEGIN
  SELECT owner_id,institution_id INTO position_owner,position_institution
    FROM app.position_identities WHERE household_id=NEW.household_id AND id=NEW.position_id;
  SELECT owner_id,institution_id INTO account_owner,account_institution
    FROM app.custody_accounts WHERE household_id=NEW.household_id AND id=NEW.custody_account_id;
  IF position_owner IS DISTINCT FROM account_owner OR position_institution IS DISTINCT FROM account_institution THEN
    RAISE EXCEPTION 'POSITION_ACCOUNT_IDENTITY_MISMATCH';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER position_identity_resolution_valid
  BEFORE INSERT ON app.position_identity_resolutions
  FOR EACH ROW EXECUTE FUNCTION app.validate_position_identity_resolution();

CREATE OR REPLACE FUNCTION app.validate_acquisition_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.evidence_kind='source_assertion' AND NOT EXISTS (
    SELECT 1 FROM app.source_assertions WHERE household_id=NEW.household_id AND id=NEW.evidence_id
  ) THEN RAISE EXCEPTION 'ACQUISITION_EVIDENCE_NOT_FOUND'; END IF;
  IF NEW.evidence_kind='event' AND NOT EXISTS (
    SELECT 1 FROM app.events WHERE household_id=NEW.household_id AND id=NEW.evidence_id
      AND side='buy' AND instrument_code=(SELECT instrument_code FROM app.position_identities WHERE household_id=NEW.household_id AND id=NEW.position_id)
  ) THEN RAISE EXCEPTION 'ACQUISITION_EVIDENCE_NOT_FOUND'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER acquisition_evidence_valid
  BEFORE INSERT ON app.acquisition_lots
  FOR EACH ROW EXECUTE FUNCTION app.validate_acquisition_evidence();

CREATE OR REPLACE FUNCTION app.reject_position_lot_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'POSITION_ACQUISITION_HISTORY_APPEND_ONLY'; END $$;
CREATE TRIGGER acquisition_lots_append_only
  BEFORE UPDATE OR DELETE ON app.acquisition_lots
  FOR EACH ROW EXECUTE FUNCTION app.reject_position_lot_mutation();
CREATE TRIGGER position_identity_resolutions_append_only
  BEFORE UPDATE OR DELETE ON app.position_identity_resolutions
  FOR EACH ROW EXECUTE FUNCTION app.reject_position_lot_mutation();
