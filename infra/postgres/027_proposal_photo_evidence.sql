-- Photo uploads belong to ingestion; this shadow-owned mapping records the
-- verified owner and workflow state needed to reference them from proposals.
ALTER TABLE app.proposals
  DROP CONSTRAINT proposals_manual_evidence_fk,
  DROP CONSTRAINT proposals_source_evidence_pair;

ALTER TABLE app.proposals
  ADD CONSTRAINT proposals_source_evidence_pair CHECK (
    (source_evidence_kind IS NULL AND source_evidence_id IS NULL) OR
    (source_evidence_kind IN ('manual_text','manual_photo') AND source_evidence_id IS NOT NULL)
  );

CREATE TABLE app.manual_photo_evidence (
  household_id TEXT NOT NULL REFERENCES app.households(id),
  upload_id UUID NOT NULL,
  owner_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL DEFAULT 'awaiting_review' CHECK (status IN ('awaiting_review','linked')),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (household_id,upload_id),
  FOREIGN KEY (household_id,owner_id) REFERENCES app.owners(household_id,id)
);

CREATE FUNCTION app.validate_proposal_source_evidence() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE evidence_owner TEXT;
BEGIN
  IF NEW.source_evidence_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.source_evidence_kind='manual_text' THEN
    SELECT owner_id INTO evidence_owner FROM app.manual_intakes
      WHERE household_id=NEW.household_id AND id=NEW.source_evidence_id;
  ELSIF NEW.source_evidence_kind='manual_photo' THEN
    SELECT owner_id INTO evidence_owner FROM app.manual_photo_evidence
      WHERE household_id=NEW.household_id AND upload_id=NEW.source_evidence_id;
  END IF;
  IF evidence_owner IS NULL OR evidence_owner<>NEW.owner_id THEN
    RAISE EXCEPTION 'PROPOSAL_SOURCE_EVIDENCE_OWNER_MISMATCH' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER proposals_source_evidence_owner
  BEFORE INSERT OR UPDATE OF owner_id,source_evidence_kind,source_evidence_id
  ON app.proposals FOR EACH ROW EXECUTE FUNCTION app.validate_proposal_source_evidence();
