import { env } from "cloudflare:workers";
import {
  authenticatedUserId,
  ensureReviewDecisionsSchema,
  REVIEW_DECISIONS,
} from "@/lib/reviews";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const userId = authenticatedUserId(request);
  if (!userId) return Response.json({ detail: "Autenticação necessária." }, { status: 401 });

  const { id } = await context.params;
  const recordId = Number(id);
  if (!Number.isInteger(recordId) || recordId <= 0) {
    return Response.json({ detail: "Revisão inválida." }, { status: 400 });
  }

  try {
    const body = await request.json() as { decision?: string; note?: string };
    const decision = String(body.decision ?? "");
    const note = String(body.note ?? "").trim().slice(0, 500);
    if (!REVIEW_DECISIONS.has(decision)) {
      return Response.json({ detail: "Selecione uma decisão válida." }, { status: 400 });
    }

    await ensureReviewDecisionsSchema();
    const ownedRecord = await env.DB.prepare(`
      SELECT r.id
      FROM import_records r
      JOIN imports i ON i.id = r.import_id
      WHERE r.id = ? AND i.user_id = ? AND i.status = 'processed'
        AND r.requires_review = 1
    `).bind(recordId, userId).first<{ id: number }>();
    if (!ownedRecord) return Response.json({ detail: "Pendência não encontrada." }, { status: 404 });

    await env.DB.prepare(`
      INSERT INTO review_decisions (import_record_id, user_id, decision, note)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, import_record_id) DO UPDATE SET
        decision = excluded.decision,
        note = excluded.note,
        updated_at = CURRENT_TIMESTAMP
    `).bind(recordId, userId, decision, note || null).run();

    return Response.json({ saved: true, record_id: recordId, decision });
  } catch {
    return Response.json(
      { detail: "Não foi possível salvar a decisão agora." },
      { status: 500 },
    );
  }
}
