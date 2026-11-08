CREATE TABLE app.photo_evidence_clarifications (
 household_id TEXT NOT NULL, id UUID NOT NULL, upload_id UUID NOT NULL, scope TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0), metadata JSONB NOT NULL,
 provenance TEXT NOT NULL CHECK(length(trim(provenance)) BETWEEN 1 AND 1000),
 actor_id TEXT NOT NULL, request_key TEXT NOT NULL, request_hash TEXT NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
 supersedes_id UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(household_id,id), UNIQUE(household_id,upload_id,scope,revision), UNIQUE(household_id,actor_id,request_key),
 FOREIGN KEY(household_id,upload_id) REFERENCES app.manual_photo_evidence(household_id,upload_id),
 FOREIGN KEY(household_id,actor_id) REFERENCES app.memberships(household_id,actor_id),
 FOREIGN KEY(household_id,supersedes_id) REFERENCES app.photo_evidence_clarifications(household_id,id),
 CHECK((revision=1 AND supersedes_id IS NULL) OR (revision>1 AND supersedes_id IS NOT NULL))
);
CREATE FUNCTION app.reject_photo_clarification_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PHOTO_CLARIFICATION_IMMUTABLE'; END $$;
CREATE TRIGGER photo_clarification_immutable BEFORE UPDATE OR DELETE ON app.photo_evidence_clarifications FOR EACH ROW EXECUTE FUNCTION app.reject_photo_clarification_mutation();
