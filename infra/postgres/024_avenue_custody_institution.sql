INSERT INTO app.custody_institutions(id,canonical_name,kind)
VALUES('avenue-securities','Avenue Securities','custodian')
ON CONFLICT(id) DO UPDATE SET canonical_name=EXCLUDED.canonical_name,kind=EXCLUDED.kind;

INSERT INTO app.custody_institution_aliases(normalized_alias,institution_id)
VALUES ('AVENUE','avenue-securities'),('AVENUE SECURITIES','avenue-securities'),('AVENUE SECURITIES LLC','avenue-securities')
ON CONFLICT(normalized_alias) DO UPDATE SET institution_id=EXCLUDED.institution_id;
