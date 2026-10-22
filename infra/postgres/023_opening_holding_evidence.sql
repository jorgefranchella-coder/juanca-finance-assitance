-- Every verified command balance must retain its opening date and source evidence.
ALTER TABLE app.holdings
  ADD COLUMN opening_as_of DATE,
  ADD COLUMN opening_assertion_id TEXT,
  ADD COLUMN opening_document_id TEXT;

ALTER TABLE app.holdings
  ADD CONSTRAINT holdings_opening_assertion_fk
    FOREIGN KEY (household_id,opening_assertion_id)
    REFERENCES app.source_assertions(household_id,id),
  ADD CONSTRAINT holdings_opening_document_fk
    FOREIGN KEY (household_id,opening_document_id)
    REFERENCES app.source_documents(household_id,id),
  ADD CONSTRAINT holdings_verified_opening_evidence CHECK (
    coverage_status <> 'verified' OR
    (opening_as_of IS NOT NULL AND num_nonnulls(opening_assertion_id,opening_document_id)=1)
  );
