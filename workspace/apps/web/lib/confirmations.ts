import { env } from "cloudflare:workers";

export async function ensureConfirmationsSchema() {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS confirmation_items (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL,
      owner TEXT NOT NULL,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      context TEXT NOT NULL,
      evidence TEXT NOT NULL,
      actions TEXT NOT NULL,
      source_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, source_key)
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS confirmation_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      item_id TEXT NOT NULL REFERENCES confirmation_items(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      action_key TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_confirmation_items_user_status
      ON confirmation_items(user_id, status, updated_at DESC)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_confirmation_decisions_item
      ON confirmation_decisions(user_id, item_id, created_at DESC)`),
  ]);
}

export function confirmationUserId(request: Request): string | null {
  const userId = request.headers.get("oai-authenticated-user-id");
  if (userId) return userId;
  const hostname = new URL(request.url).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" ? "local-development" : null;
}
