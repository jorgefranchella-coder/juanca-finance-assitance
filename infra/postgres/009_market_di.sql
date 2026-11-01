ALTER TABLE market.index_imports DROP CONSTRAINT index_imports_indexer_check;
ALTER TABLE market.index_imports ADD CONSTRAINT index_imports_indexer_check CHECK(indexer IN ('SELIC','CDI'));
ALTER TABLE market.index_observations DROP CONSTRAINT index_observations_unit_check;
ALTER TABLE market.index_observations ADD CONSTRAINT index_observations_unit_check CHECK(unit IN ('daily_percent','annual_effective_252'));
