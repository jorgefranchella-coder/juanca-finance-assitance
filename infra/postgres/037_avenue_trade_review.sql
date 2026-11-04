-- An Avenue confirmation contains independent immutable source rows.
CREATE TABLE app.avenue_trade_proposal_links (
 household_id TEXT NOT NULL,
 assertion_id TEXT NOT NULL,
 proposal_id TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY (household_id,assertion_id),
 UNIQUE (household_id,proposal_id),
 FOREIGN KEY (household_id,assertion_id) REFERENCES app.source_assertions(household_id,id),
 FOREIGN KEY (household_id,proposal_id) REFERENCES app.proposals(household_id,id)
);
