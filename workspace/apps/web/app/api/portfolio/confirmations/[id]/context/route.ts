import { env } from "cloudflare:workers";
import { confirmationUserId, ensureConfirmationsSchema } from "@/lib/confirmations";

export const dynamic = "force-dynamic";

export async function POST(request: Request, route: { params: Promise<{ id: string }> }) {
  const userId = confirmationUserId(request);
  if (!userId) return Response.json({ detail: "Autenticação necessária." }, { status: 401 });
  const { id } = await route.params;
  try {
    const body = await request.json() as { context?: unknown; evidence?: unknown };
    if (!body.context || typeof body.context !== "object" || Array.isArray(body.context)
      || JSON.stringify(body.context).length > 8000 || !Array.isArray(body.evidence)
      || body.evidence.length > 50
      || body.evidence.some((entry) => typeof entry !== "string" || entry.length > 1000)) {
      return Response.json({ detail: "Contexto o evidencia inválidos." }, { status: 400 });
    }
    await ensureConfirmationsSchema();
    const result = await env.DB.prepare(`UPDATE confirmation_items
      SET context = ?, evidence = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ? AND status = 'open'`)
      .bind(JSON.stringify(body.context), JSON.stringify(body.evidence), id, userId).run();
    if (!Number(result.meta.changes ?? 0)) {
      const existing = await env.DB.prepare(`SELECT status FROM confirmation_items WHERE id = ? AND user_id = ?`)
        .bind(id, userId).first<{ status: string }>();
      return Response.json({ detail: existing ? "Solo se pueden corregir confirmaciones abiertas." : "Confirmación no encontrada." },
        { status: existing ? 409 : 404 });
    }
    return Response.json({ saved: true, id });
  } catch {
    return Response.json({ detail: "No se pudo actualizar el contexto de la confirmación." }, { status: 500 });
  }
}
