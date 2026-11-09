CREATE TABLE app.alert_evaluations (
 household_id TEXT NOT NULL REFERENCES app.households(id),
 id UUID NOT NULL,
 actor_id TEXT NOT NULL,
 evaluated_on DATE NOT NULL,
 rule_version TEXT NOT NULL,
 portfolio_version TEXT NOT NULL,
 input_sha256 TEXT NOT NULL CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
 evidence JSONB NOT NULL,
 alerts JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY (household_id,id),
 UNIQUE (household_id,input_sha256),
 FOREIGN KEY (household_id,actor_id) REFERENCES app.memberships(household_id,actor_id),
 FOREIGN KEY (household_id,portfolio_version) REFERENCES app.portfolio_versions(household_id,id)
);
CREATE FUNCTION app.reject_alert_evaluation_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'ALERT_EVALUATION_IMMUTABLE'; END $$;
CREATE TRIGGER alert_evaluation_immutable BEFORE UPDATE OR DELETE ON app.alert_evaluations FOR EACH ROW EXECUTE FUNCTION app.reject_alert_evaluation_mutation();
