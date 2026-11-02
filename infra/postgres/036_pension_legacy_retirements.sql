-- Append-only record of explicitly reviewed replacements of legacy fund accounts.
CREATE TABLE app.pension_legacy_retirements (
 household_id TEXT NOT NULL, account_id TEXT NOT NULL, instrument_code TEXT NOT NULL,
 currency TEXT NOT NULL, previous_quantity app.exact_decimal NOT NULL CHECK(previous_quantity > 0),
 replacement_document_id TEXT NOT NULL, effective_as_of DATE NOT NULL,
 actor_id TEXT NOT NULL, recorded_at TIMESTAMPTZ NOT NULL,
 PRIMARY KEY(household_id,account_id,instrument_code,currency),
 FOREIGN KEY(household_id,account_id) REFERENCES app.accounts(household_id,id),
 FOREIGN KEY(household_id,replacement_document_id) REFERENCES app.source_documents(household_id,id),
 FOREIGN KEY(household_id,actor_id) REFERENCES app.memberships(household_id,actor_id)
);
CREATE FUNCTION app.reject_pension_legacy_retirement_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PENSION_LEGACY_RETIREMENT_IMMUTABLE'; END $$;
CREATE TRIGGER pension_legacy_retirement_immutable BEFORE UPDATE OR DELETE ON app.pension_legacy_retirements FOR EACH ROW EXECUTE FUNCTION app.reject_pension_legacy_retirement_mutation();
