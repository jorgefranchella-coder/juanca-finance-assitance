-- Resolve historical command-account aliases to canonical custody/account identities.
-- These records do not apply or reinterpret any financial event.
ALTER TABLE app.custody_accounts ADD CONSTRAINT custody_account_owner_identity UNIQUE(household_id,id,owner_id);
CREATE TABLE app.command_account_identity_resolutions(
 household_id TEXT NOT NULL,
 account_id TEXT NOT NULL,
 owner_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0),
 canonical_account_id TEXT NOT NULL,
 custody_account_id TEXT,
 decision TEXT NOT NULL CHECK(decision IN ('user_confirmed_one_account_per_institution','user_confirmed_avenue_account_alias')),
 evidence JSONB NOT NULL,
 actor_id TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(household_id,account_id,revision),
 FOREIGN KEY(household_id,account_id,owner_id) REFERENCES app.accounts(household_id,id,owner_id),
 FOREIGN KEY(household_id,canonical_account_id,owner_id) REFERENCES app.accounts(household_id,id,owner_id),
 FOREIGN KEY(household_id,custody_account_id,owner_id) REFERENCES app.custody_accounts(household_id,id,owner_id),
 FOREIGN KEY(household_id,actor_id) REFERENCES app.memberships(household_id,actor_id),
 CHECK ((decision='user_confirmed_one_account_per_institution' AND custody_account_id IS NOT NULL)
     OR (decision='user_confirmed_avenue_account_alias' AND custody_account_id IS NULL))
);
CREATE INDEX command_account_identity_latest ON app.command_account_identity_resolutions(household_id,account_id,revision DESC);
