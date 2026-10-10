-- Conversation belongs to the application; replies never write financial facts.
CREATE TABLE app.conversations (
  household_id TEXT NOT NULL REFERENCES app.households(id),
  id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(household_id,id)
);
CREATE TABLE app.conversation_requests (
  household_id TEXT NOT NULL,
  id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('processing','done','failed')),
  lease_token TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  result JSONB,
  PRIMARY KEY(household_id,id),
  FOREIGN KEY(household_id,conversation_id) REFERENCES app.conversations(household_id,id)
);
CREATE UNIQUE INDEX conversation_one_processing_per_household
  ON app.conversation_requests(household_id) WHERE status='processing';
CREATE TABLE app.conversation_messages (
  household_id TEXT NOT NULL,
  id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  content TEXT NOT NULL CHECK(length(content)<=16000),
  origin TEXT NOT NULL DEFAULT 'application',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(household_id,id),
  FOREIGN KEY(household_id,conversation_id) REFERENCES app.conversations(household_id,id)
);
CREATE INDEX conversation_messages_recent ON app.conversation_messages(household_id,conversation_id,created_at,id);
