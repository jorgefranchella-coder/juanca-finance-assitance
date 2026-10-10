-- Versioned local readings of immutable OCR text; never portfolio facts.
CREATE TABLE app.manual_photo_trade_interpretations (
  household_id TEXT NOT NULL REFERENCES app.households(id),
  upload_id UUID NOT NULL,
  owner_id TEXT NOT NULL,
  ocr_text_sha256 TEXT NOT NULL CHECK (ocr_text_sha256 ~ '^[0-9a-f]{64}$'),
  parser_version TEXT NOT NULL,
  interpretation_status TEXT NOT NULL CHECK (interpretation_status IN ('parsed_review','needs_manual_review','not_detected')),
  fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  review_reasons TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (household_id,upload_id,ocr_text_sha256,parser_version),
  FOREIGN KEY (household_id,owner_id) REFERENCES app.owners(household_id,id)
);
CREATE INDEX manual_photo_trade_interpretations_recent
  ON app.manual_photo_trade_interpretations(household_id,created_at DESC,upload_id);
CREATE FUNCTION app.prevent_manual_photo_trade_interpretation_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'MANUAL_PHOTO_INTERPRETATION_APPEND_ONLY';
END;
$$;
CREATE TRIGGER manual_photo_trade_interpretation_append_only
  BEFORE UPDATE OR DELETE ON app.manual_photo_trade_interpretations
  FOR EACH ROW EXECUTE FUNCTION app.prevent_manual_photo_trade_interpretation_mutation();
