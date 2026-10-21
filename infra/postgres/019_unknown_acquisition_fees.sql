-- An absent fee in source evidence means unknown, not zero.
ALTER TABLE app.acquisition_lots ALTER COLUMN fees_minor DROP NOT NULL;
ALTER TABLE app.acquisition_lots ALTER COLUMN fees_minor DROP DEFAULT;
