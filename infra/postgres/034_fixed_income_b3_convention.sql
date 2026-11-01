ALTER TABLE app.fixed_income_contract_terms
 ADD COLUMN calculation_basis TEXT NOT NULL DEFAULT 'act_365_25' CHECK (calculation_basis IN ('act_365_25','b3_di')),
 ADD COLUMN calendar_code TEXT,
 ADD COLUMN scenario_source TEXT,
 ADD COLUMN scenario_as_of DATE,
 ADD CONSTRAINT fixed_income_b3_convention_valid CHECK (
  (calculation_basis='act_365_25' AND calendar_code IS NULL AND scenario_source IS NULL AND scenario_as_of IS NULL)
  OR (calculation_basis='b3_di' AND method='indexed' AND indexer='CDI' AND indexer_relation='multiplier' AND interest_treatment='capitalize'
      AND calendar_code IS NOT NULL AND scenario_source IS NOT NULL AND calendar_code ~ '^[a-z0-9_-]{1,60}$' AND length(trim(scenario_source)) BETWEEN 1 AND 240 AND scenario_as_of IS NOT NULL)
 );
