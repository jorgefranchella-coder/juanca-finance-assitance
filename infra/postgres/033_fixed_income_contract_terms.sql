-- Versioned, evidence-linked contract terms for account-scoped fixed-income positions.
CREATE TABLE app.fixed_income_contract_terms (
  household_id TEXT NOT NULL,
  id UUID NOT NULL,
  position_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  method TEXT NOT NULL CHECK (method IN ('fixed','indexed')),
  interest_treatment TEXT NOT NULL CHECK (interest_treatment IN ('capitalize','cashflow')),
  indexer_relation TEXT NOT NULL CHECK (indexer_relation IN ('additive','compound','multiplier')),
  indexer TEXT NOT NULL CHECK (indexer IN ('none','CDI','IPCA','SELIC')),
  annual_rate_pct app.exact_decimal,
  indexer_assumption_pct app.exact_decimal,
  tax_rate_pct app.exact_decimal,
  schedule_confirmed BOOLEAN NOT NULL,
  payment_schedule JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(payment_schedule)='array'),
  source_document_id TEXT NOT NULL,
  source_assertion_id TEXT,
  source_locator TEXT NOT NULL CHECK (length(trim(source_locator)) BETWEEN 1 AND 240),
  recorded_by TEXT NOT NULL,
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  supersedes_id UUID,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (household_id,id),
  UNIQUE (household_id,position_id,revision),
  UNIQUE (household_id,recorded_by,request_key),
  FOREIGN KEY (household_id,position_id) REFERENCES app.position_identities(household_id,id),
  FOREIGN KEY (household_id,source_document_id) REFERENCES app.source_documents(household_id,id),
  FOREIGN KEY (household_id,source_assertion_id) REFERENCES app.source_assertions(household_id,id),
  FOREIGN KEY (household_id,recorded_by) REFERENCES app.memberships(household_id,actor_id),
  FOREIGN KEY (household_id,supersedes_id) REFERENCES app.fixed_income_contract_terms(household_id,id),
  CHECK ((method='fixed' AND indexer='none' AND indexer_relation='additive' AND annual_rate_pct IS NOT NULL AND indexer_assumption_pct IS NULL)
      OR (method='indexed' AND indexer IN ('CDI','IPCA','SELIC') AND annual_rate_pct IS NOT NULL AND indexer_assumption_pct IS NOT NULL)),
  CHECK (annual_rate_pct > -100 AND annual_rate_pct <= 1000),
  CHECK (indexer_assumption_pct IS NULL OR (indexer_assumption_pct > -100 AND indexer_assumption_pct <= 1000)),
  CHECK (tax_rate_pct IS NULL OR (tax_rate_pct >= 0 AND tax_rate_pct <= 100)),
  CHECK ((revision=1 AND supersedes_id IS NULL) OR (revision>1 AND supersedes_id IS NOT NULL))
);
CREATE INDEX fixed_income_contract_terms_latest ON app.fixed_income_contract_terms(household_id,position_id,revision DESC);

CREATE OR REPLACE FUNCTION app.reject_fixed_income_contract_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'FIXED_INCOME_CONTRACT_TERMS_IMMUTABLE'; END $$;
CREATE TRIGGER fixed_income_contract_terms_immutable
  BEFORE UPDATE OR DELETE ON app.fixed_income_contract_terms
  FOR EACH ROW EXECUTE FUNCTION app.reject_fixed_income_contract_mutation();

CREATE OR REPLACE FUNCTION app.validate_fixed_income_contract_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE position_owner TEXT; position_instrument TEXT; position_account TEXT; document_owner TEXT;
        assertion_document TEXT; assertion_owner TEXT; assertion_instrument TEXT; assertion_account TEXT; actor_role TEXT;
BEGIN
  SELECT role INTO actor_role FROM app.memberships WHERE household_id=NEW.household_id AND actor_id=NEW.recorded_by;
  IF actor_role IS NULL OR actor_role NOT IN ('owner','approver') THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  SELECT p.owner_id,p.instrument_code,COALESCE((SELECT r.custody_account_id FROM app.position_identity_resolutions r
      WHERE r.household_id=p.household_id AND r.position_id=p.id ORDER BY r.revision DESC LIMIT 1),p.custody_account_id)
    INTO position_owner,position_instrument,position_account FROM app.position_identities p
    WHERE p.household_id=NEW.household_id AND p.id=NEW.position_id;
  IF position_account IS NULL THEN RAISE EXCEPTION 'CUSTODY_ACCOUNT_IDENTITY_REQUIRED'; END IF;
  SELECT owner_id INTO document_owner FROM app.source_documents
    WHERE household_id=NEW.household_id AND id=NEW.source_document_id;
  IF position_owner IS DISTINCT FROM document_owner THEN RAISE EXCEPTION 'CONTRACT_EVIDENCE_OWNER_MISMATCH'; END IF;
  IF NEW.source_assertion_id IS NOT NULL THEN
    SELECT document_id,owner_id,instrument_code,custody_account_id INTO assertion_document,assertion_owner,assertion_instrument,assertion_account FROM app.source_assertions
      WHERE household_id=NEW.household_id AND id=NEW.source_assertion_id;
    IF assertion_document IS DISTINCT FROM NEW.source_document_id THEN RAISE EXCEPTION 'CONTRACT_ASSERTION_DOCUMENT_MISMATCH'; END IF;
    IF assertion_owner IS DISTINCT FROM position_owner OR assertion_instrument IS DISTINCT FROM position_instrument THEN RAISE EXCEPTION 'CONTRACT_ASSERTION_POSITION_MISMATCH'; END IF;
    IF assertion_account IS NOT NULL AND assertion_account IS DISTINCT FROM position_account THEN RAISE EXCEPTION 'CONTRACT_ASSERTION_ACCOUNT_MISMATCH'; END IF;
  END IF;
  IF NEW.revision > 1 AND NOT EXISTS (
    SELECT 1 FROM app.fixed_income_contract_terms p WHERE p.household_id=NEW.household_id
      AND p.id=NEW.supersedes_id AND p.position_id=NEW.position_id AND p.revision=NEW.revision-1
  ) THEN RAISE EXCEPTION 'CONTRACT_REVISION_CHAIN_INVALID'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fixed_income_contract_evidence_valid
  BEFORE INSERT ON app.fixed_income_contract_terms
  FOR EACH ROW EXECUTE FUNCTION app.validate_fixed_income_contract_evidence();
