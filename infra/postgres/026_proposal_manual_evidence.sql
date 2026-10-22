-- Financial proposals created through the manual workflow must retain the exact
-- written intake that supplied their facts. Legacy imports remain nullable.
ALTER TABLE app.proposals
  ADD COLUMN source_evidence_kind TEXT,
  ADD COLUMN source_evidence_id UUID,
  ADD CONSTRAINT proposals_source_evidence_pair CHECK (
    (source_evidence_kind IS NULL AND source_evidence_id IS NULL) OR
    (source_evidence_kind = 'manual_text' AND source_evidence_id IS NOT NULL)
  ),
  ADD CONSTRAINT proposals_manual_evidence_fk
    FOREIGN KEY (household_id,source_evidence_id)
    REFERENCES app.manual_intakes(household_id,id);

CREATE UNIQUE INDEX proposals_one_live_use_per_manual_evidence
  ON app.proposals(household_id,source_evidence_kind,source_evidence_id)
  WHERE source_evidence_kind IS NOT NULL AND status IN ('pending','applied');
