-- A provider can revise a quote within one reported day. Preserve each fetch run.
ALTER TABLE market.quote_observations DROP CONSTRAINT IF EXISTS quote_observations_market_code_symbol_provider_observed_at_key;
ALTER TABLE market.fx_observations DROP CONSTRAINT IF EXISTS fx_observations_pair_provider_observed_at_key;
CREATE UNIQUE INDEX quote_observation_run_identity ON market.quote_observations(provider_run_id,market_code,symbol);
CREATE UNIQUE INDEX fx_observation_run_identity ON market.fx_observations(provider_run_id,pair);
