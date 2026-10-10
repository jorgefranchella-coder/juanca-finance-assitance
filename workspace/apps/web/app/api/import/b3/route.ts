import { and, eq } from "drizzle-orm";
import { env } from "cloudflare:workers";

import { getDb } from "@/db";
import { importRecords, imports } from "@/db/schema";
import { parseMovements, parsePositions } from "@/lib/b3";

export const dynamic = "force-dynamic";

const ALLOWED_OWNERS = new Set(["Jorge", "Julia"]);
const ALLOWED_TYPES = new Set(["positions", "movements"]);

function authenticatedUserId(request: Request): string | null {
  const userId = request.headers.get("oai-authenticated-user-id");
  if (userId) return userId;
  const hostname = new URL(request.url).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" ? "local-development" : null;
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Falha inesperada na importação.";
  if (message.includes("no such table") || message.includes("D1_ERROR")) {
    return "O banco privado ainda está sendo preparado. Tente novamente em alguns instantes.";
  }
  const safeParserPrefixes = [
    "Aba ",
    "Nenhuma posição",
    "Nenhum movimento",
    "Não foi possível abrir",
    "O arquivo excede",
  ];
  if (safeParserPrefixes.some((prefix) => message.startsWith(prefix))) return message;
  return "Não foi possível concluir a gravação privada. A importação incompleta foi descartada; tente novamente.";
}

async function deleteIncompleteImport(importId: string, objectKey: string | null) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM import_records WHERE import_id = ?").bind(importId),
    env.DB.prepare("DELETE FROM imports WHERE id = ?").bind(importId),
  ]).catch(() => undefined);
  if (objectKey) await env.UPLOADS.delete(objectKey).catch(() => undefined);
}

async function ensureSchema() {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS imports (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL,
      owner TEXT NOT NULL,
      file_type TEXT NOT NULL,
      file_name TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      reference_date TEXT,
      object_key TEXT NOT NULL,
      record_count INTEGER NOT NULL,
      market_value_cents INTEGER,
      review_required INTEGER DEFAULT 0 NOT NULL,
      status TEXT DEFAULT 'processed' NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS import_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      import_id TEXT NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
      record_kind TEXT NOT NULL,
      source_sheet TEXT NOT NULL,
      source_row INTEGER NOT NULL,
      event_type TEXT,
      requires_review INTEGER DEFAULT 0 NOT NULL,
      payload TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_imports_user_sha_type
      ON imports(user_id, sha256, file_type)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_import_records_import
      ON import_records(import_id)`),
  ]);
}

export async function POST(request: Request) {
  const userId = authenticatedUserId(request);
  if (!userId) return Response.json({ detail: "Autenticação necessária." }, { status: 401 });

  let objectKey: string | null = null;
  let activeImportId: string | null = null;
  try {
    await ensureSchema();
    const form = await request.formData();
    const file = form.get("file");
    const owner = String(form.get("owner") ?? "");
    const fileType = String(form.get("kind") ?? "");
    const referenceDate = String(form.get("reference_date") ?? "");

    if (!(file instanceof File) || !file.name.toLowerCase().endsWith(".xlsx")) {
      return Response.json({ detail: "Selecione um arquivo B3 no formato .xlsx." }, { status: 400 });
    }
    if (!ALLOWED_OWNERS.has(owner) || !ALLOWED_TYPES.has(fileType)) {
      return Response.json({ detail: "Investidor ou tipo de arquivo inválido." }, { status: 400 });
    }
    if (fileType === "positions" && !/^\d{4}-\d{2}-\d{2}$/.test(referenceDate)) {
      return Response.json({ detail: "Informe a data de referência da posição." }, { status: 400 });
    }

    const bytes = await file.arrayBuffer();
    const records = fileType === "positions"
      ? parsePositions(bytes, owner, referenceDate)
      : parseMovements(bytes, owner);
    const digest = await sha256(bytes);
    const db = getDb();
    const [existing] = await db
      .select()
      .from(imports)
      .where(and(eq(imports.userId, userId), eq(imports.sha256, digest), eq(imports.fileType, fileType as "positions" | "movements")))
      .limit(1);

    if (existing) {
      const stored = await env.DB.prepare(
        "SELECT COUNT(*) AS total FROM import_records WHERE import_id = ?",
      ).bind(existing.id).first<{ total: number }>();
      if (existing.status === "processed" && Number(stored?.total ?? 0) === existing.recordCount) {
        return Response.json({
          file: file.name,
          owner,
          records: existing.recordCount,
          market_value: existing.marketValueCents === null
            ? undefined
            : (existing.marketValueCents / 100).toFixed(2),
          review_required: existing.reviewRequired,
          persisted: true,
          duplicate: true,
        });
      }
      await deleteIncompleteImport(existing.id, existing.objectKey);
    }

    const importId = crypto.randomUUID();
    activeImportId = importId;
    objectKey = `${userId}/${importId}/${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    const marketValueCents = fileType === "positions"
      ? records.reduce((sum, record) => sum + ("market_value_cents" in record ? record.market_value_cents : 0), 0)
      : null;
    const reviewRequired = records.reduce(
      (sum, record) => sum + ("requires_review" in record && record.requires_review ? 1 : 0),
      0,
    );

    await env.UPLOADS.put(objectKey, bytes, {
      httpMetadata: { contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
      customMetadata: { owner, fileType, sha256: digest },
    });
    await db.insert(imports).values({
      id: importId,
      userId,
      owner,
      fileType: fileType as "positions" | "movements",
      fileName: file.name,
      sha256: digest,
      referenceDate: fileType === "positions" ? referenceDate : null,
      objectKey,
      recordCount: records.length,
      marketValueCents,
      reviewRequired,
      status: "processing",
    });

    // D1 limits the number of bound parameters in one statement. Ten records
    // keep each insert comfortably below that limit while retaining throughput.
    for (let offset = 0; offset < records.length; offset += 10) {
      await db.insert(importRecords).values(
        records.slice(offset, offset + 10).map((record) => ({
          importId,
          recordKind: record.kind,
          sourceSheet: record.source_sheet,
          sourceRow: record.source_row,
          eventType: "event_type" in record ? record.event_type : null,
          requiresReview: "requires_review" in record ? record.requires_review : false,
          payload: JSON.stringify(record),
        })),
      );
    }
    await db.update(imports).set({ status: "processed" }).where(eq(imports.id, importId));
    activeImportId = null;

    return Response.json({
      file: file.name,
      owner,
      records: records.length,
      market_value: marketValueCents === null ? undefined : (marketValueCents / 100).toFixed(2),
      review_required: reviewRequired,
      persisted: true,
      duplicate: false,
    });
  } catch (error) {
    const rawDiagnostic = error instanceof Error ? error.message : "unknown error";
    const diagnostic = rawDiagnostic.split(/params:|parameters:/)[0];
    console.error("B3 import storage error:", diagnostic.slice(0, 500));
    if (activeImportId) await deleteIncompleteImport(activeImportId, objectKey);
    else if (objectKey) await env.UPLOADS.delete(objectKey).catch(() => undefined);
    return Response.json({ detail: errorMessage(error) }, { status: 422 });
  }
}
