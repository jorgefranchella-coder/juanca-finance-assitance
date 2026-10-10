import { env } from "cloudflare:workers";
import { extractText, getDocumentProxy } from "unpdf";

import { parseAvenueConfirmations, parseAvenueStatement } from "@/lib/avenue";
import { authenticatedUserId } from "@/lib/reviews";
import { deleteIncompleteImport, ensureImportSchema, fileSha256 } from "@/lib/import-storage";

export const dynamic = "force-dynamic";

const OWNERS = new Set(["Jorge", "Julia"]);
const KINDS = new Set(["statement", "confirmation"]);

function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : "Falha inesperada.";
  const allowed = ["Este PDF", "Data-base", "Nenhuma posição", "Nenhuma operação"];
  return allowed.some((prefix) => message.startsWith(prefix))
    ? message
    : "Não foi possível importar este PDF da Avenue com segurança.";
}

export async function POST(request: Request) {
  const userId = authenticatedUserId(request);
  if (!userId) return Response.json({ detail: "Autenticação necessária." }, { status: 401 });
  let importId: string | null = null;
  let objectKey: string | null = null;
  try {
    await ensureImportSchema();
    const form = await request.formData();
    const file = form.get("file");
    const owner = String(form.get("owner") ?? "");
    const kind = String(form.get("kind") ?? "");
    if (!(file instanceof File) || !file.name.toLowerCase().endsWith(".pdf")) {
      return Response.json({ detail: "Selecione um PDF da Avenue." }, { status: 400 });
    }
    if (!OWNERS.has(owner) || !KINDS.has(kind)) {
      return Response.json({ detail: "Investidor ou tipo de PDF inválido." }, { status: 400 });
    }
    if (file.size > 15 * 1024 * 1024) {
      return Response.json({ detail: "O PDF excede o limite de 15 MB." }, { status: 400 });
    }
    const bytes = await file.arrayBuffer();
    const digest = await fileSha256(bytes);
    const fileType = kind === "statement" ? "avenue_statement" : "avenue_confirmation";
    const existing = await env.DB.prepare(
      "SELECT id, record_count AS recordCount, status FROM imports WHERE user_id = ? AND sha256 = ? AND file_type = ? LIMIT 1",
    ).bind(userId, digest, fileType).first<{ id: string; recordCount: number; status: string }>();
    if (existing?.status === "processed") {
      return Response.json({ file: file.name, owner, records: existing.recordCount, duplicate: true, persisted: true });
    }

    const pdf = await getDocumentProxy(new Uint8Array(bytes), { maxImageSize: 16_777_216 });
    if (pdf.numPages > 15) return Response.json({ detail: "O PDF excede o limite de 15 páginas." }, { status: 400 });
    const extracted = await extractText(pdf, { mergePages: false });
    const pages = extracted.text;
    const records = kind === "statement"
      ? parseAvenueStatement(pages, owner)
      : parseAvenueConfirmations(pages, owner);
    const referenceDate = kind === "statement"
      ? records[0] && "reference_date" in records[0] ? records[0].reference_date : null
      : records.reduce((latest, item) => "trade_date" in item && item.trade_date > latest ? item.trade_date : latest, "");

    importId = crypto.randomUUID();
    objectKey = `${userId}/${importId}/${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    await env.UPLOADS.put(objectKey, bytes, {
      httpMetadata: { contentType: "application/pdf" },
      customMetadata: { owner, fileType, sha256: digest },
    });
    await env.DB.prepare(`INSERT INTO imports
      (id, user_id, owner, file_type, file_name, sha256, reference_date, object_key,
       record_count, market_value_cents, review_required, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 'processing')`)
      .bind(importId, userId, owner, fileType, file.name, digest, referenceDate, objectKey, records.length).run();
    for (let offset = 0; offset < records.length; offset += 20) {
      const batch = records.slice(offset, offset + 20).map((record, index) => env.DB.prepare(`INSERT INTO import_records
        (import_id, record_kind, source_sheet, source_row, event_type, requires_review, payload)
        VALUES (?, ?, ?, ?, ?, 0, ?)`)
        .bind(importId, record.kind, kind === "statement" ? "Statement" : "Confirmation", offset + index + 1,
          "side" in record ? record.side : null, JSON.stringify(record)));
      await env.DB.batch(batch);
    }
    await env.DB.prepare("UPDATE imports SET status = 'processed' WHERE id = ?").bind(importId).run();
    importId = null;
    return Response.json({ file: file.name, owner, records: records.length, reference_date: referenceDate, duplicate: false, persisted: true });
  } catch (error) {
    console.error("Avenue import error:", error instanceof Error ? error.message.slice(0, 500) : "unknown");
    if (importId) await deleteIncompleteImport(importId, objectKey);
    else if (objectKey) await env.UPLOADS.delete(objectKey).catch(() => undefined);
    return Response.json({ detail: safeError(error) }, { status: 422 });
  }
}
