import { env } from "cloudflare:workers";
import { authenticatedUserId, ensureReviewDecisionsSchema } from "@/lib/reviews";

export const dynamic = "force-dynamic";

type StoredReview = {
  id: number;
  file_name: string;
  source_row: number;
  payload: string;
};

export async function GET(request: Request) {
  const userId = authenticatedUserId(request);
  if (!userId) return Response.json({ detail: "Autenticação necessária." }, { status: 401 });

  try {
    await ensureReviewDecisionsSchema();
    const imports = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM imports WHERE user_id = ? AND status = 'processed'",
    ).bind(userId).first<{ total: number }>();
    const reviewTotal = await env.DB.prepare(`
      SELECT COUNT(*) AS total
      FROM import_records r
      JOIN imports i ON i.id = r.import_id
      LEFT JOIN review_decisions d
        ON d.import_record_id = r.id AND d.user_id = i.user_id
      WHERE i.user_id = ? AND i.status = 'processed'
        AND r.requires_review = 1 AND d.id IS NULL
    `).bind(userId).first<{ total: number }>();
    const stored = await env.DB.prepare(`
      SELECT r.id, i.file_name, r.source_row, r.payload
      FROM import_records r
      JOIN imports i ON i.id = r.import_id
      LEFT JOIN review_decisions d
        ON d.import_record_id = r.id AND d.user_id = i.user_id
      WHERE i.user_id = ? AND i.status = 'processed'
        AND r.requires_review = 1 AND d.id IS NULL
      ORDER BY i.created_at DESC, r.source_row ASC
      LIMIT 50
    `).bind(userId).all<StoredReview>();

    const reviews = stored.results.flatMap((row) => {
      try {
        const payload = JSON.parse(row.payload) as Record<string, unknown>;
        return [{
          id: row.id,
          owner: String(payload.owner ?? ""),
          occurred_on: String(payload.occurred_on ?? ""),
          movement_name: String(payload.movement_name ?? "Movimento não classificado"),
          product_name: String(payload.product_name ?? "Ativo não identificado"),
          institution: String(payload.institution ?? ""),
          event_type: String(payload.event_type ?? "unknown"),
          file_name: row.file_name,
          source_row: row.source_row,
        }];
      } catch {
        return [];
      }
    });

    return Response.json(
      { import_count: Number(imports?.total ?? 0), review_count: Number(reviewTotal?.total ?? 0), reviews },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch {
    return Response.json(
      { detail: "Não foi possível carregar as revisões agora." },
      { status: 500, headers: { "Cache-Control": "private, no-store" } },
    );
  }
}
