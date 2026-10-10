import { env } from "cloudflare:workers";

export async function ensureTransactionChatSchema() {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL,
      content TEXT NOT NULL, attachment_name TEXT, attachment_type TEXT, object_key TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_chat_messages_user_created
      ON chat_messages(user_id, created_at)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS transaction_proposals (
      id TEXT PRIMARY KEY NOT NULL, message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL, owner TEXT NOT NULL, side TEXT NOT NULL, instrument_code TEXT NOT NULL,
      quantity REAL NOT NULL, unit_price REAL NOT NULL, currency TEXT NOT NULL, trade_date TEXT NOT NULL,
      fees_minor INTEGER DEFAULT 0 NOT NULL, source TEXT NOT NULL, confidence REAL NOT NULL,
      evidence TEXT NOT NULL, status TEXT DEFAULT 'pending' NOT NULL, applied_import_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL, updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_transaction_proposals_user_status
      ON transaction_proposals(user_id, status, created_at)`),
  ]);
}
