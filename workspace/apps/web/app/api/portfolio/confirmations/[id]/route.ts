import { env } from "cloudflare:workers";
import { confirmationUserId, ensureConfirmationsSchema } from "@/lib/confirmations";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const userId = confirmationUserId(request);
  if (!userId) return Response.json({ detail: "Autenticação necessária." }, { status: 401 });
  const { id } = await context.params;
  try {
    const body = await request.json() as { action_key?: unknown; note?: unknown };
    const actionKey = String(body.action_key ?? "").trim();
    const note = String(body.note ?? "").trim().slice(0, 1000);
    await ensureConfirmationsSchema();
    const item = await env.DB.prepare(`SELECT actions, status FROM confirmation_items WHERE id = ? AND user_id = ?`)
      .bind(id, userId).first<{ actions: string; status: string }>();
    if (!item) return Response.json({ detail: "Confirmación no encontrada." }, { status: 404 });
    if (item.status !== "open") return Response.json({ detail: "Esta confirmación ya fue respondida." }, { status: 409 });
    const actions = JSON.parse(item.actions) as Array<{ key: string; keeps_open?: boolean }>;
    const selectedAction = actions.find((action) => action.key === actionKey);
    if (!selectedAction) return Response.json({ detail: "Selecciona una acción disponible." }, { status: 400 });
    const nextStatus = selectedAction.keeps_open === true ? "open" : "resolved";
    const saved = await env.DB.batch([
      env.DB.prepare(`UPDATE confirmation_items SET status = 'answering' WHERE id = ? AND user_id = ? AND status = 'open'`).bind(id, userId),
      env.DB.prepare(`INSERT INTO confirmation_decisions (item_id, user_id, action_key, note)
        SELECT ?, ?, ?, ? WHERE EXISTS (
          SELECT 1 FROM confirmation_items WHERE id = ? AND user_id = ? AND status = 'answering'
        )`).bind(id, userId, actionKey, note || null, id, userId),
      env.DB.prepare(`UPDATE confirmation_items SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND status = 'answering'`).bind(nextStatus, id, userId),
    ]);
    if (!Number(saved[0]?.meta?.changes ?? 0)) return Response.json({ detail: "Esta confirmación ya fue respondida." }, { status: 409 });
    return Response.json({ saved: true, id, action_key: actionKey, status: nextStatus });
  } catch {
    return Response.json({ detail: "No se pudo guardar la respuesta." }, { status: 500 });
  }
}
