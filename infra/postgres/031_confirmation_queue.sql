CREATE TABLE app.confirmation_items (
  household_id TEXT NOT NULL REFERENCES app.households,
  id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  owner TEXT NOT NULL CHECK(owner IN ('Jorge','Julia','Sin identificar')),
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  context JSONB NOT NULL,
  evidence JSONB NOT NULL CHECK(jsonb_typeof(evidence)='array'),
  actions JSONB NOT NULL CHECK(jsonb_typeof(actions)='array'),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(household_id,id),
  UNIQUE(household_id,source_key)
);
CREATE TABLE app.confirmation_decisions (
  household_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  ordinal BIGINT NOT NULL,
  action_key TEXT NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(household_id,item_id,ordinal),
  FOREIGN KEY(household_id,item_id) REFERENCES app.confirmation_items(household_id,id)
);
CREATE INDEX confirmation_items_status ON app.confirmation_items(household_id,status,created_at DESC);
CREATE INDEX confirmation_decisions_recent ON app.confirmation_decisions(household_id,item_id,ordinal DESC);
