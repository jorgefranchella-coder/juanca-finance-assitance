CREATE TABLE app.pension_identity_decisions (
 household_id TEXT NOT NULL, id UUID NOT NULL, assertion_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0), plan_number TEXT NOT NULL CHECK(length(trim(plan_number)) BETWEEN 1 AND 100),
 fund_name TEXT NOT NULL CHECK(length(trim(fund_name)) BETWEEN 1 AND 180),
 fund_cnpj TEXT NOT NULL CHECK(fund_cnpj ~ '^[0-9]{14}$'), source_locator TEXT NOT NULL CHECK(length(trim(source_locator)) BETWEEN 1 AND 240),
 actor_id TEXT NOT NULL, request_key TEXT NOT NULL, request_hash TEXT NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'), supersedes_id UUID, decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(household_id,id), UNIQUE(household_id,assertion_id,revision), UNIQUE(household_id,actor_id,request_key),
 FOREIGN KEY(household_id,assertion_id) REFERENCES app.source_assertions(household_id,id),
 FOREIGN KEY(household_id,actor_id) REFERENCES app.memberships(household_id,actor_id),
 FOREIGN KEY(household_id,supersedes_id) REFERENCES app.pension_identity_decisions(household_id,id),
 CHECK((revision=1 AND supersedes_id IS NULL) OR (revision>1 AND supersedes_id IS NOT NULL))
);
CREATE INDEX pension_identity_decisions_latest ON app.pension_identity_decisions(household_id,assertion_id,revision DESC);
CREATE FUNCTION app.reject_pension_identity_decision_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PENSION_IDENTITY_DECISION_IMMUTABLE'; END $$;
CREATE TRIGGER pension_identity_decision_immutable BEFORE UPDATE OR DELETE ON app.pension_identity_decisions FOR EACH ROW EXECUTE FUNCTION app.reject_pension_identity_decision_mutation();
