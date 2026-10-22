-- A reviewed, applied buy can establish a verified invested-asset opening balance.
ALTER TABLE app.holdings ADD COLUMN opening_event_id TEXT;

ALTER TABLE app.holdings
  DROP CONSTRAINT holdings_verified_opening_evidence,
  ADD CONSTRAINT holdings_opening_event_fk
    FOREIGN KEY (household_id,opening_event_id)
    REFERENCES app.events(household_id,id),
  ADD CONSTRAINT holdings_verified_opening_evidence CHECK (
    coverage_status <> 'verified' OR
    (opening_as_of IS NOT NULL AND num_nonnulls(opening_assertion_id,opening_document_id,opening_event_id)=1)
  ),
  ADD CONSTRAINT holdings_opening_event_date CHECK (
    opening_event_id IS NULL OR opening_as_of IS NOT NULL
  );
