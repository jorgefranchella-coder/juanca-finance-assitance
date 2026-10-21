import { env } from "cloudflare:workers";
import { confirmationUserId, ensureConfirmationsSchema } from "@/lib/confirmations";

export const dynamic = "force-dynamic";

type ItemRow = {
  id: string; owner: string; category: string; title: string; context: string;
  evidence: string; actions: string; source_key: string; status: string;
  created_at: string; updated_at: string; action_key: string | null; note: string | null;
  decided_at: string | null;
};

function jsonField<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

export async function GET(request: Request) {
  const userId = confirmationUserId(request);
  if (!userId) return Response.json({ detail: "Autenticação necessária." }, { status: 401 });
  try {
    await ensureConfirmationsSchema();
    const status = new URL(request.url).searchParams.get("status");
    const rows = await env.DB.prepare(`
      SELECT i.*, d.action_key, d.note, d.created_at AS decided_at
      FROM confirmation_items i
      LEFT JOIN confirmation_decisions d ON d.id = (
        SELECT MAX(d2.id) FROM confirmation_decisions d2
        WHERE d2.item_id = i.id AND d2.user_id = i.user_id
      )
      WHERE i.user_id = ? AND (? IS NULL OR i.status = ?)
      ORDER BY CASE i.status WHEN 'open' THEN 0 ELSE 1 END, i.created_at DESC
      LIMIT 200
    `).bind(userId, status, status).all<ItemRow>();
    const items = rows.results.map((row) => ({
      id: row.id, owner: row.owner, category: row.category, title: row.title,
      context: jsonField(row.context, {}), evidence: jsonField(row.evidence, []),
      actions: jsonField(row.actions, []), source_key: row.source_key,
      status: row.status, created_at: row.created_at, updated_at: row.updated_at,
      decision: row.action_key ? { action_key: row.action_key, note: row.note, decided_at: row.decided_at } : null,
    }));
    return Response.json({ items, open_count: items.filter((item) => item.status === "open").length },
      { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return Response.json({ detail: "No se pudo cargar la lista de confirmaciones." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const userId = confirmationUserId(request);
  if (!userId) return Response.json({ detail: "Autenticação necessária." }, { status: 401 });
  try {
    const body = await request.json() as Record<string, unknown>;
    const owner = String(body.owner ?? "");
    const category = String(body.category ?? "").trim().slice(0, 60);
    const title = String(body.title ?? "").trim().slice(0, 240);
    const sourceKey = String(body.source_key ?? "").trim().slice(0, 240);
    const context = body.context;
    const evidence = body.evidence;
    const actions = body.actions;
    if (!(["Jorge", "Julia", "Sin identificar"].includes(owner)) || !category || !title || !sourceKey
      || !Array.isArray(actions) || actions.length < 2 || actions.length > 12
      || !context || typeof context !== "object" || Array.isArray(context) || JSON.stringify(context).length > 8000
      || !Array.isArray(evidence) || evidence.length > 50
      || evidence.some((entry) => typeof entry !== "string" || entry.length > 1000)) {
      return Response.json({ detail: "Faltan datos válidos para registrar la confirmación." }, { status: 400 });
    }
    const validActions = actions.every((action) => action && typeof action === "object"
      && typeof (action as Record<string, unknown>).key === "string" && /^[a-z0-9_-]{1,80}$/.test(String((action as Record<string, unknown>).key))
      && typeof (action as Record<string, unknown>).label === "string" && String((action as Record<string, unknown>).label).length <= 180
      && ((action as Record<string, unknown>).description === undefined || (typeof (action as Record<string, unknown>).description === "string" && String((action as Record<string, unknown>).description).length <= 600))
      && ((action as Record<string, unknown>).keeps_open === undefined || typeof (action as Record<string, unknown>).keeps_open === "boolean"));
    if (!validActions) return Response.json({ detail: "Las acciones deben tener identificador y etiqueta." }, { status: 400 });
    await ensureConfirmationsSchema();
    const id = crypto.randomUUID();
    await env.DB.prepare(`
      INSERT INTO confirmation_items (id, user_id, owner, category, title, context, evidence, actions, source_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, source_key) DO NOTHING
    `).bind(id, userId, owner, category, title, JSON.stringify(context), JSON.stringify(evidence), JSON.stringify(actions), sourceKey).run();
    const saved = await env.DB.prepare(`SELECT id, status FROM confirmation_items WHERE user_id = ? AND source_key = ?`)
      .bind(userId, sourceKey).first<{ id: string; status: string }>();
    return Response.json({ saved: true, duplicate: saved?.id !== id, id: saved?.id, status: saved?.status }, { status: 201 });
  } catch {
    return Response.json({ detail: "No se pudo registrar la confirmación." }, { status: 500 });
  }
}
