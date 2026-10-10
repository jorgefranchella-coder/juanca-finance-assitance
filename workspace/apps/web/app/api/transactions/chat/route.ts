import { env } from "cloudflare:workers";
import { extractText, getDocumentProxy } from "unpdf";
import { parseAvenueConfirmations } from "@/lib/avenue";
import { fileSha256 } from "@/lib/import-storage";
import { authenticatedUserId } from "@/lib/reviews";
import { ensureTransactionChatSchema } from "@/lib/transaction-chat";
import { missingTransactionFields, parseTransactionText, type TransactionDraft } from "@/lib/transaction-parser";

import { factsRevision } from "@/lib/portfolio-storage";

export const dynamic = "force-dynamic";
const OWNERS = new Set(["Jorge", "Julia"]);
const ALLOWED_TYPES = new Set(["application/pdf", "text/plain", "text/csv", "image/png", "image/jpeg", "image/webp"]);

type MessageRow = {
  id: string; role: string; content: string; attachment_name: string | null;
  attachment_type: string | null; created_at: string;
};
type ProposalRow = {
  id: string; message_id: string; owner: string; side: string; instrument_code: string;
  quantity: number; unit_price: number; currency: string; trade_date: string; fees_minor: number;
  source: string; confidence: number; evidence: string; status: string;
};

async function conversation(userId: string) {
  const [messages, proposals] = await Promise.all([
    env.DB.prepare(`SELECT id, role, content, attachment_name, attachment_type, created_at
      FROM chat_messages WHERE user_id=? ORDER BY created_at, rowid LIMIT 200`).bind(userId).all<MessageRow>(),
    env.DB.prepare(`SELECT id, message_id, owner, side, instrument_code, quantity, unit_price,
      currency, trade_date, fees_minor, source, confidence, evidence, status
      FROM transaction_proposals WHERE user_id=? ORDER BY created_at, rowid LIMIT 200`).bind(userId).all<ProposalRow>(),
  ]);
  const byMessage = new Map<string, ProposalRow[]>();
  for (const proposal of proposals.results) {
    const rows = byMessage.get(proposal.message_id) ?? [];
    rows.push({ ...proposal, quantity: Number(proposal.quantity), unit_price: Number(proposal.unit_price), confidence: Number(proposal.confidence) });
    byMessage.set(proposal.message_id, rows);
  }
  return messages.results.map((message) => ({ ...message, proposals: byMessage.get(message.id) ?? [] }));
}

export async function GET(request: Request) {
  const userId = authenticatedUserId(request);
  if (!userId) return Response.json({ detail: "Autenticação necessária." }, { status: 401 });
  await ensureTransactionChatSchema();
  return Response.json({ messages: await conversation(userId), facts_revision: await factsRevision(userId) }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request) {
  const userId = authenticatedUserId(request);
  if (!userId) return Response.json({ detail: "Autenticação necessária." }, { status: 401 });
  await ensureTransactionChatSchema();
  const form = await request.formData();
  const owner = String(form.get("owner") ?? "");
  const content = String(form.get("message") ?? "").trim();
  const attachment = form.get("attachment");
  if (!OWNERS.has(owner)) return Response.json({ detail: "Selecione Jorge ou Julia." }, { status: 400 });
  if (!content && !(attachment instanceof File && attachment.size)) return Response.json({ detail: "Escreva uma mensagem ou anexe um comprovante." }, { status: 400 });
  if (content.length > 3000) return Response.json({ detail: "A mensagem excede 3.000 caracteres." }, { status: 400 });

  let objectKey: string | null = null;
  let attachmentName: string | null = null;
  let attachmentType: string | null = null;
  let extractedText = "";
  let fileDrafts: TransactionDraft[] = [];
  if (attachment instanceof File && attachment.size) {
    if (attachment.size > 15 * 1024 * 1024) return Response.json({ detail: "O anexo excede o limite de 15 MB." }, { status: 400 });
    const type = attachment.type || (attachment.name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "text/plain");
    if (!ALLOWED_TYPES.has(type)) return Response.json({ detail: "Use PDF, TXT, CSV, PNG, JPG ou WEBP." }, { status: 400 });
    const bytes = await attachment.arrayBuffer();
    const digest = await fileSha256(bytes);
    attachmentName = attachment.name.slice(0, 180);
    attachmentType = type;
    objectKey = `${userId}/chat/${crypto.randomUUID()}/${attachmentName.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    if (type === "application/pdf") {
      const pdf = await getDocumentProxy(new Uint8Array(bytes), { maxImageSize: 16_777_216 });
      if (pdf.numPages > 20) return Response.json({ detail: "O PDF excede o limite de 20 páginas." }, { status: 400 });
      const pages = (await extractText(pdf, { mergePages: false })).text;
      extractedText = pages.join("\n");
      try {
        fileDrafts = parseAvenueConfirmations(pages, owner).map((trade) => ({
          owner, side: trade.side, instrumentCode: trade.instrument_code, quantity: trade.quantity,
          unitPrice: trade.unit_price, currency: "USD", tradeDate: trade.trade_date,
          feesMinor: trade.fees_minor, source: "avenue_confirmation", confidence: 1,
          evidence: `${trade.product_name} · ${trade.quantity} ${trade.instrument_code} @ ${trade.unit_price}`,
        }));
      } catch { /* generic parser handles other text-based receipts */ }
    } else if (type === "text/plain" || type === "text/csv") {
      extractedText = new TextDecoder().decode(bytes).slice(0, 50_000);
    }
    await env.UPLOADS.put(objectKey, bytes, { httpMetadata: { contentType: type }, customMetadata: { owner, sha256: digest } });
  }

  const userMessageId = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO chat_messages
    (id, user_id, role, content, attachment_name, attachment_type, object_key) VALUES (?, ?, 'user', ?, ?, ?, ?)`)
    .bind(userMessageId, userId, content || `Enviei ${attachmentName}.`, attachmentName, attachmentType, objectKey).run();
  const drafts = fileDrafts.length ? fileDrafts : parseTransactionText(`${content}\n${extractedText}`, owner);
  const assistantMessageId = crypto.randomUUID();
  let answer: string;
  if (drafts.length) {
    answer = drafts.length === 1
      ? "Interpretei uma operação e preparei o ajuste abaixo. Confira todos os campos antes de aprovar."
      : `Interpretei ${drafts.length} operações no comprovante. Confira cada proposta antes de aprovar.`;
  } else if (attachmentType?.startsWith("image/")) {
    answer = "Guardei a imagem, mas esta versão ainda não faz OCR. Escreva na mensagem se foi compra ou venda, a quantidade, o ativo e o preço unitário para eu preparar o ajuste.";
  } else {
    const missing = missingTransactionFields(`${content}\n${extractedText}`);
    answer = missing.length
      ? `Ainda preciso de ${missing.join(", ")}. Exemplo: “Comprei 20 PETR4 a R$ 32,50 em 16/08/2026”.`
      : "Não consegui interpretar a operação com segurança. Descreva compra ou venda, quantidade, ativo, preço unitário e data.";
  }
  await env.DB.prepare(`INSERT INTO chat_messages (id, user_id, role, content) VALUES (?, ?, 'assistant', ?)`)
    .bind(assistantMessageId, userId, answer).run();
  if (drafts.length) {
    await env.DB.batch(drafts.map((draft) => env.DB.prepare(`INSERT INTO transaction_proposals
      (id, message_id, user_id, owner, side, instrument_code, quantity, unit_price, currency,
       trade_date, fees_minor, source, confidence, evidence, status, source_message_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
      .bind(crypto.randomUUID(), assistantMessageId, userId, draft.owner, draft.side, draft.instrumentCode,
        draft.quantity, draft.unitPrice, draft.currency, draft.tradeDate, draft.feesMinor,
        draft.source, draft.confidence, draft.evidence, userMessageId)));
  }
  return Response.json({ messages: await conversation(userId), facts_revision: await factsRevision(userId) });
}
