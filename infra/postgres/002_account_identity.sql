-- Keep household, owner and account identity consistent in the database itself.
ALTER TABLE app.accounts ADD CONSTRAINT account_owner_identity UNIQUE(household_id,id,owner_id);
ALTER TABLE app.snapshots ADD CONSTRAINT snapshot_account_owner FOREIGN KEY(household_id,account_id,owner_id) REFERENCES app.accounts(household_id,id,owner_id);
ALTER TABLE app.events ADD CONSTRAINT event_account_owner FOREIGN KEY(household_id,account_id,owner_id) REFERENCES app.accounts(household_id,id,owner_id);
ALTER TABLE app.proposals ADD CONSTRAINT proposal_account_owner FOREIGN KEY(household_id,account_id,owner_id) REFERENCES app.accounts(household_id,id,owner_id);
