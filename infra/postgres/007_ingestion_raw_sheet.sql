-- Row numbers repeat across workbook sheets, so identity includes the sheet.
ALTER TABLE ingestion.raw_records ADD COLUMN source_sheet TEXT NOT NULL DEFAULT '';
ALTER TABLE ingestion.raw_records DROP CONSTRAINT IF EXISTS raw_records_import_job_id_source_ordinal_parser_version_key;
CREATE UNIQUE INDEX raw_record_source_identity ON ingestion.raw_records(import_job_id,source_sheet,source_ordinal,parser_version);
