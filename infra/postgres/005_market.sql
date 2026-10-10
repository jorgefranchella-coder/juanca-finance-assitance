CREATE SCHEMA IF NOT EXISTS market AUTHORIZATION juanca_market;
CREATE TABLE IF NOT EXISTS market.schema_migrations(
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE market.provider_runs(
  id UUID PRIMARY KEY,
  provider TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK(status IN ('running','succeeded','partial','failed')),
  requested_count INTEGER NOT NULL CHECK(requested_count>=0),
  received_count INTEGER NOT NULL DEFAULT 0 CHECK(received_count>=0),
  error_code TEXT
);
CREATE TABLE market.quote_observations(
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  market_code TEXT NOT NULL CHECK(market_code IN ('B3','US')),
  symbol TEXT NOT NULL,
  currency TEXT NOT NULL CHECK(currency IN ('BRL','USD')),
  price NUMERIC NOT NULL CHECK(price>0 AND price<1000000000000000000 AND trunc(price,10)=price),
  provider TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  provider_run_id UUID NOT NULL REFERENCES market.provider_runs(id),
  UNIQUE(market_code,symbol,provider,observed_at)
);
CREATE INDEX quote_observations_latest ON market.quote_observations(market_code,symbol,observed_at DESC,received_at DESC);
CREATE TABLE market.fx_observations(
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pair TEXT NOT NULL CHECK(pair='USD/BRL'),
  rate NUMERIC NOT NULL CHECK(rate>0 AND rate<1000000000000000000 AND trunc(rate,10)=rate),
  provider TEXT NOT NULL,
  observed_at DATE NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  provider_run_id UUID NOT NULL REFERENCES market.provider_runs(id),
  UNIQUE(pair,provider,observed_at)
);
CREATE INDEX fx_observations_latest ON market.fx_observations(pair,observed_at DESC,received_at DESC);
CREATE TABLE market.refresh_jobs(
  id UUID PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  symbols JSONB NOT NULL,
  include_fx BOOLEAN NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','partial','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_until TIMESTAMPTZ,
  lease_token UUID,
  provider_run_id UUID REFERENCES market.provider_runs(id),
  result JSONB,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX refresh_jobs_claim ON market.refresh_jobs(available_at,created_at) WHERE status IN ('queued','running');
CREATE TABLE market.outbox(
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id UUID NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT
);
CREATE INDEX outbox_pending ON market.outbox(available_at,id) WHERE published_at IS NULL;
REVOKE ALL ON SCHEMA market FROM PUBLIC;
GRANT USAGE ON SCHEMA market TO juanca_market;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA market TO juanca_market;
