import { env } from "cloudflare:workers";
import type { PensionPosition } from "@/lib/pension";

type Stored = { payload: string };

export async function loadPensionPortfolio(userId: string): Promise<PensionPosition[]> {
  const stored = await env.DB.prepare(`
    SELECT r.payload
    FROM import_records r JOIN imports i ON i.id = r.import_id
    WHERE i.user_id = ? AND i.status = 'processed' AND i.file_type = 'pension_statement'
      AND r.record_kind = 'position'
      AND i.id = (SELECT latest.id FROM imports latest
        WHERE latest.user_id = i.user_id AND latest.owner = i.owner
          AND latest.file_type = 'pension_statement' AND latest.status = 'processed'
        ORDER BY latest.reference_date DESC, latest.created_at DESC, latest.rowid DESC LIMIT 1)
    ORDER BY i.owner, r.id LIMIT 100
  `).bind(userId).all<Stored>();
  return stored.results.flatMap((row) => {
    try {
      const item = JSON.parse(row.payload) as PensionPosition;
      return item.account_scope === "participant" ? [item] : [];
    } catch {
      return [];
    }
  });
}
