-- Historical position identity can be confirmed by the user even when the original source assertion is no longer available.
ALTER TABLE app.position_account_resolutions ALTER COLUMN assertion_id DROP NOT NULL;
ALTER TABLE app.position_account_resolutions DROP CONSTRAINT position_account_resolutions_decision_check;
ALTER TABLE app.position_account_resolutions ADD CONSTRAINT position_account_resolutions_decision_check CHECK (
  decision IN ('same_custody_account_confirmed_by_institution_uniqueness','user_confirmed_institution_uniqueness')
);
