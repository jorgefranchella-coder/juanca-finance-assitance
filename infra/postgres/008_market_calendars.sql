CREATE TABLE market.calendar_imports (
  id UUID PRIMARY KEY,
  calendar_code TEXT NOT NULL CHECK (calendar_code ~ '^[a-z0-9_-]{1,60}$'),
  source_uri TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  coverage_start DATE NOT NULL,
  coverage_end DATE NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (coverage_start<=coverage_end),
  UNIQUE (calendar_code,content_sha256)
);
CREATE TABLE market.calendar_days (
  import_id UUID NOT NULL REFERENCES market.calendar_imports(id),
  civil_date DATE NOT NULL,
  business_day BOOLEAN NOT NULL,
  PRIMARY KEY (import_id,civil_date)
);
CREATE INDEX market_calendar_coverage ON market.calendar_imports(calendar_code,coverage_start,coverage_end,received_at DESC);
CREATE TRIGGER market_calendar_imports_immutable BEFORE UPDATE OR DELETE ON market.calendar_imports FOR EACH ROW EXECUTE FUNCTION market.reject_index_mutation();
CREATE TRIGGER market_calendar_days_immutable BEFORE UPDATE OR DELETE ON market.calendar_days FOR EACH ROW EXECUTE FUNCTION market.reject_index_mutation();
