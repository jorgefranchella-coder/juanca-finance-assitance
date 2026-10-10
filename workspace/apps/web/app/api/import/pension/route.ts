import { env } from "cloudflare:workers";
import { extractText, getDocumentProxy } from "unpdf";

import { authenticatedUserId } from "@/lib/reviews";
import { deleteIncompleteImport, ensureImportSchema, fileSha256 } from "@/lib/import-storage";
import { parseSantanderPensionStatement } from "@/lib/pension";

export const dynamic = "force-dynamic";
const OWNERS = new Set(["Jorge", "Julia"]);

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
    if (!(file instanceof File) || !file.name.toLowerCase().endsWith(".pdf")) {
      return Response.json({ detail: "Selecione um PDF de previdência." }, { status: 400 });
    }
    if (!OWNERS.has(owner)) return Response.json({ detail: "Selecione Jorge ou Julia." }, { status: 400 });
    if (file.size > 15 * 1024 * 1024) return Response.json({ detail: "O PDF excede o limite de 15 MB." }, { status: 400 });

    const bytes = await file.arrayBuffer();
    const digest = await fileSha256(bytes);
    const existing = await env.DB.prepare(
      "SELECT record_count AS recordCount, market_value_cents AS marketValueCents, status FROM imports WHERE user_id=? AND sha256=? AND file_type='pension_statement' LIMIT 1",
    ).bind(userId, digest).first<{ recordCount: number; marketValueCents: number; status: string }>();
    if (existing?.status === "processed") {
      return Response.json({ file: file.name, owner, records: existing.recordCount, market_value: existing.marketValueCents / 100, duplicate: true });
    }

    const pdf = await getDocumentProxy(new Uint8Array(bytes), { maxImageSize: 16_777_216 });
    if (pdf.numPages > 15) return Response.json({ detail: "O PDF excede o limite de 15 páginas." }, { status: 400 });
    const extracted = await extractText(pdf, { mergePages: false });
    const records = parseSantanderPensionStatement(extracted.text, owner);
    const record = records[0];
    importId = crypto.randomUUID();
    objectKey = `${userId}/${importId}/${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    await env.UPLOADS.put(objectKey, bytes, {
      httpMetadata: { contentType: "application/pdf" },
      customMetadata: { owner, fileType: "pension_statement", sha256: digest },
    });
    await env.DB.prepare(`INSERT INTO imports
      (id, user_id, owner, file_type, file_name, sha256, reference_date, object_key,
       record_count, market_value_cents, review_required, status)
      VALUES (?, ?, ?, 'pension_statement', ?, ?, ?, ?, ?, ?, 0, 'processing')`)
      .bind(importId, userId, owner, file.name, digest, record.reference_date, objectKey, records.length, record.market_value_cents).run();
    await env.DB.prepare(`INSERT INTO import_records
      (import_id, record_kind, source_sheet, source_row, event_type, requires_review, payload)
      VALUES (?, 'position', 'Conta Básica Participante', 1, NULL, 0, ?)`)
      .bind(importId, JSON.stringify(record)).run();
    await env.DB.prepare("UPDATE imports SET status='processed' WHERE id=?").bind(importId).run();
    importId = null;
    return Response.json({ file: file.name, owner, records: records.length, reference_date: record.reference_date,
      market_value: record.market_value_cents / 100, employer_balance_excluded: true, persisted: true });
  } catch (error) {
    console.error("Pension import error:", error instanceof Error ? error.message.slice(0, 500) : "unknown");
    if (importId) await deleteIncompleteImport(importId, objectKey);
    else if (objectKey) await env.UPLOADS.delete(objectKey).catch(() => undefined);
    const message = error instanceof Error && /^(Este PDF|A Conta|O saldo|A data|Data do extrato)/.test(error.message)
      ? error.message : "Não foi possível importar este extrato de previdência com segurança.";
    return Response.json({ detail: message }, { status: 422 });
  }
}
