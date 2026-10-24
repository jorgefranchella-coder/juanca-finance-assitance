ALTER TABLE app.confirmation_items ADD COLUMN legacy_user_id TEXT;
ALTER TABLE app.confirmation_decisions ADD COLUMN legacy_user_id TEXT;
CREATE TABLE app.confirmation_transfers (
  household_id TEXT NOT NULL REFERENCES app.households,
  source_key TEXT NOT NULL,
  export_sha256 TEXT NOT NULL CHECK(export_sha256 ~ '^[0-9a-f]{64}$'),
  item_count INTEGER NOT NULL CHECK(item_count>=0),
  decision_count INTEGER NOT NULL CHECK(decision_count>=0),
  transferred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(household_id,source_key)
);
