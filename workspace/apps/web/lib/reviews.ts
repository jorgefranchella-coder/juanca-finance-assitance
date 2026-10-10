import { env } from "cloudflare:workers";

export const REVIEW_DECISIONS = new Set([
  "corporate_action",
  "custody_transfer",
  "position_adjustment",
  "ignored",
]);

export async function ensureReviewDecisionsSchema() {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS review_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      import_record_id INTEGER NOT NULL REFERENCES import_records(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      decision TEXT NOT NULL,
      note TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    )`),
    env.DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_review_decisions_user_record
      ON review_decisions(user_id, import_record_id)`),
  ]);
}

export function authenticatedUserId(request: Request): string | null {
  const userId = request.headers.get("oai-authenticated-user-id");
  if (userId) return userId;
  const hostname = new URL(request.url).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" ? "local-development" : null;
}
