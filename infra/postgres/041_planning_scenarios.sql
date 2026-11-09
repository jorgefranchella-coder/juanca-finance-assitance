CREATE TABLE app.planning_scenario_versions (
 household_id TEXT NOT NULL REFERENCES app.households(id),
 id UUID NOT NULL, scenario_id UUID NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0),
 name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120),
 actor_id TEXT NOT NULL, request_key TEXT NOT NULL, request_hash TEXT NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
 currency TEXT NOT NULL CHECK(currency='BRL'), method_version TEXT NOT NULL, assumptions JSONB NOT NULL, result JSONB NOT NULL,
 source_kind TEXT NOT NULL CHECK(source_kind IN ('manual','portfolio')), portfolio_version TEXT,
 coverage TEXT NOT NULL CHECK(coverage IN ('manual_unverified','portfolio_complete')),
 supersedes_id UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(household_id,id), UNIQUE(household_id,scenario_id,revision), UNIQUE(household_id,actor_id,request_key),
 FOREIGN KEY(household_id,actor_id) REFERENCES app.memberships(household_id,actor_id),
 FOREIGN KEY(household_id,portfolio_version) REFERENCES app.portfolio_versions(household_id,id),
 FOREIGN KEY(household_id,supersedes_id) REFERENCES app.planning_scenario_versions(household_id,id),
 CHECK((source_kind='manual' AND portfolio_version IS NULL AND coverage='manual_unverified') OR (source_kind='portfolio' AND portfolio_version IS NOT NULL AND coverage='portfolio_complete')),
 CHECK((revision=1 AND supersedes_id IS NULL) OR (revision>1 AND supersedes_id IS NOT NULL))
);
CREATE FUNCTION app.reject_scenario_version_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PLANNING_SCENARIO_IMMUTABLE'; END $$;
CREATE TRIGGER planning_scenario_immutable BEFORE UPDATE OR DELETE ON app.planning_scenario_versions FOR EACH ROW EXECUTE FUNCTION app.reject_scenario_version_mutation();
