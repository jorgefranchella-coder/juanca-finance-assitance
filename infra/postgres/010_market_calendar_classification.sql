ALTER TABLE market.calendar_imports ADD COLUMN coverage_kind TEXT NOT NULL DEFAULT 'confirmed' CHECK (coverage_kind IN ('confirmed','estimated'));
