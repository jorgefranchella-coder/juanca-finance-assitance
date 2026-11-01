-- Immutable provider snapshots of economic indices, kept in the market service boundary.
CREATE TABLE market.index_imports (
  id UUID PRIMARY KEY,
  provider TEXT NOT NULL,
  indexer TEXT NOT NULL CHECK (indexer IN ('SELIC')),
  source_uri TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  requested_from DATE NOT NULL,
  requested_to DATE NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (requested_from<=requested_to),
  UNIQUE (provider,indexer,content_sha256,requested_from,requested_to)
);
CREATE TABLE market.index_observations (
  import_id UUID NOT NULL REFERENCES market.index_imports(id),
  observed_on DATE NOT NULL,
  rate_pct NUMERIC NOT NULL CHECK (rate_pct>=0 AND rate_pct<100 AND trunc(rate_pct,10)=rate_pct),
  unit TEXT NOT NULL CHECK (unit='daily_percent'),
  PRIMARY KEY (import_id,observed_on)
);
CREATE INDEX market_index_observations_date ON market.index_observations(observed_on,import_id);
CREATE FUNCTION market.reject_index_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'MARKET_INDEX_EVIDENCE_IMMUTABLE'; END $$;
CREATE TRIGGER market_index_imports_immutable BEFORE UPDATE OR DELETE ON market.index_imports FOR EACH ROW EXECUTE FUNCTION market.reject_index_mutation();
CREATE TRIGGER market_index_observations_immutable BEFORE UPDATE OR DELETE ON market.index_observations FOR EACH ROW EXECUTE FUNCTION market.reject_index_mutation();
