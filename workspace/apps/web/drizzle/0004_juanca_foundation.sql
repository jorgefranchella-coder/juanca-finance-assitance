-- Incremental foundation: legacy facts are preserved. No historical attribution is guessed.
ALTER TABLE transaction_proposals ADD COLUMN source_message_id TEXT REFERENCES chat_messages(id);
CREATE TABLE portfolio_revisions (user_id TEXT PRIMARY KEY NOT NULL, revision INTEGER NOT NULL DEFAULT 0);
INSERT INTO portfolio_revisions(user_id) SELECT DISTINCT user_id FROM imports WHERE 1 ON CONFLICT DO NOTHING;
CREATE TABLE proposal_applications (
  proposal_id TEXT PRIMARY KEY NOT NULL REFERENCES transaction_proposals(id),
  user_id TEXT NOT NULL, import_id TEXT NOT NULL UNIQUE,
  expected_revision INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE fx_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL,
  pair TEXT NOT NULL, rate REAL NOT NULL CHECK(rate > 0),
  quoted_at TEXT NOT NULL, provider TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, pair, quoted_at, provider)
);
CREATE TRIGGER application_revision AFTER INSERT ON proposal_applications BEGIN
  INSERT INTO portfolio_revisions(user_id,revision) VALUES(NEW.user_id,1)
  ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER imports_revision_insert AFTER INSERT ON imports BEGIN
  INSERT INTO portfolio_revisions(user_id,revision) VALUES(NEW.user_id,1)
  ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER imports_revision_update AFTER UPDATE ON imports BEGIN
  INSERT INTO portfolio_revisions(user_id,revision) VALUES(NEW.user_id,1)
  ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER imports_revision_delete AFTER DELETE ON imports BEGIN
  INSERT INTO portfolio_revisions(user_id,revision) VALUES(OLD.user_id,1)
  ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER records_revision_insert AFTER INSERT ON import_records BEGIN
  INSERT INTO portfolio_revisions(user_id,revision) SELECT user_id,1 FROM imports WHERE id=NEW.import_id
  ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER records_revision_update AFTER UPDATE ON import_records BEGIN
  INSERT INTO portfolio_revisions(user_id,revision) SELECT user_id,1 FROM imports WHERE id=NEW.import_id
  ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER records_revision_delete AFTER DELETE ON import_records BEGIN
  INSERT INTO portfolio_revisions(user_id,revision) SELECT user_id,1 FROM imports WHERE id=OLD.import_id
  ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER reviews_revision_insert AFTER INSERT ON review_decisions BEGIN
  INSERT INTO portfolio_revisions(user_id,revision) VALUES(NEW.user_id,1)
  ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER reviews_revision_update AFTER UPDATE ON review_decisions BEGIN
  INSERT INTO portfolio_revisions(user_id,revision) VALUES(NEW.user_id,1)
  ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER costs_revision_insert AFTER INSERT ON cost_basis BEGIN
  INSERT INTO portfolio_revisions(user_id,revision) VALUES(NEW.user_id,1)
  ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER costs_revision_update AFTER UPDATE ON cost_basis BEGIN
  INSERT INTO portfolio_revisions(user_id,revision) VALUES(NEW.user_id,1)
  ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
END;
