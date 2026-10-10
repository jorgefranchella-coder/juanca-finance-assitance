import { env } from "cloudflare:workers";

export async function ensureImportSchema() {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS imports (
      id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL, owner TEXT NOT NULL,
      file_type TEXT NOT NULL, file_name TEXT NOT NULL, sha256 TEXT NOT NULL,
      reference_date TEXT, object_key TEXT NOT NULL, record_count INTEGER NOT NULL,
      market_value_cents INTEGER, review_required INTEGER DEFAULT 0 NOT NULL,
      status TEXT DEFAULT 'processed' NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS import_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      import_id TEXT NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
      record_kind TEXT NOT NULL, source_sheet TEXT NOT NULL, source_row INTEGER NOT NULL,
      event_type TEXT, requires_review INTEGER DEFAULT 0 NOT NULL, payload TEXT NOT NULL)`),
    env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_imports_user_sha_type ON imports(user_id, sha256, file_type)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_import_records_import ON import_records(import_id)"),
  ]);
}

export async function fileSha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function deleteIncompleteImport(importId: string, objectKey: string | null) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM import_records WHERE import_id = ?").bind(importId),
    env.DB.prepare("DELETE FROM imports WHERE id = ?").bind(importId),
  ]).catch(() => undefined);
  if (objectKey) await env.UPLOADS.delete(objectKey).catch(() => undefined);
}
