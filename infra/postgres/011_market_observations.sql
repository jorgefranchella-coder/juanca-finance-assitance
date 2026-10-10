-- Market facts received through the market service API; no valuation is published here.
CREATE TABLE app.market_feed_state (
  feed TEXT PRIMARY KEY,
  last_outbox_id BIGINT NOT NULL DEFAULT 0 CHECK (last_outbox_id>=0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO app.market_feed_state(feed) VALUES('market') ON CONFLICT DO NOTHING;
CREATE TABLE app.market_inbox (
  event_id UUID PRIMARY KEY,
  outbox_id BIGINT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE app.market_quote_observations (
  market_code TEXT NOT NULL CHECK (market_code IN ('B3','US')),
  symbol TEXT NOT NULL,
  provider TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('BRL','USD')),
  price app.exact_decimal NOT NULL CHECK (price>0),
  event_id UUID NOT NULL REFERENCES app.market_inbox(event_id),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id,market_code,symbol)
);
CREATE INDEX market_quote_latest ON app.market_quote_observations(market_code,symbol,observed_at DESC);
CREATE TABLE app.market_fx_observations (
  pair TEXT NOT NULL CHECK (pair='USD/BRL'),
  provider TEXT NOT NULL,
  observed_on DATE NOT NULL,
  rate app.exact_decimal NOT NULL CHECK (rate>0),
  event_id UUID NOT NULL REFERENCES app.market_inbox(event_id),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id,pair)
);
