"use client";

import { FormEvent, useRef, useState } from "react";

type Interpretation = { interpretation_status: "parsed_review" | "needs_manual_review" | "not_detected"; fields: { side?: string | null; instrument_code?: string | null; quantity?: string | null; unit_price?: string | null; currency?: string | null; trade_date?: string | null }; review_reasons: string[] };

export default function TransactionChat({ prefill }: { prefill?: { message: string; owner: string } }) {
  const [owner, setOwner] = useState(prefill?.owner ?? "Jorge");
  const [message, setMessage] = useState(prefill?.message ?? "");
  const [attachment, setAttachment] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [interpretation, setInterpretation] = useState<Interpretation | null>(null);
  const request = useRef<{ fingerprint: string; id: string } | null>(null);

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!message.trim() && !attachment) return;
    setBusy(true); setError(""); setStatus(""); setInterpretation(null);
    try {
      if (attachment && !attachment.type.startsWith("image/")) throw new Error("Para mantener el original y su vínculo en PostgreSQL, adjunta una foto (JPG, PNG o WebP). Los PDF se incorporan desde Importar.");
      const fingerprint = `${owner}|${message}|${attachment?.name ?? ""}|${attachment?.size ?? 0}|${attachment?.lastModified ?? 0}`;
      if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, id: crypto.randomUUID().replaceAll("-", "_") };
      const requestId = request.current.id;
      if (message.trim()) {
        const response = await fetch("/api/shadow/evidence/text", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ request_id: requestId, owner, text: message.trim() }) });
        const result = await response.json() as { code?: string; interpretation?: Interpretation | null };
        if (!response.ok) throw new Error(result.code ?? "No se pudo guardar el texto en PostgreSQL.");
        setInterpretation(result.interpretation ?? null);
      }
      if (attachment) {
        const response = await fetch("/api/shadow/evidence/photo-file", { method: "POST", headers: { "Content-Type": attachment.type, "X-Juanca-Owner": owner, "X-Juanca-File-Name": encodeURIComponent(attachment.name), "X-Juanca-Request-Id": `${requestId}.photo` }, body: attachment });
        const result = await response.json() as { code?: string };
        if (!response.ok) throw new Error(result.code ?? "No se pudo guardar la foto en PostgreSQL.");
      }
      setStatus("Evidencia original registrada en PostgreSQL. Completa la propuesta y revisa su aprobación en esta misma pantalla.");
      setMessage(""); setAttachment(null); request.current = null;
      const input = document.querySelector<HTMLInputElement>("#transaction-attachment"); if (input) input.value = "";
      window.dispatchEvent(new Event("shadow-evidence-updated"));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo registrar la evidencia."); }
    finally { setBusy(false); }
  }

  return <section className="panel transaction-chat" id="transacoes">
    <div className="panel-title chat-title"><div><p>Entrada conversacional · PostgreSQL</p><h2>Registrar evidencia</h2><span>El texto y las fotos se conservan como evidencia. No se envían al libro D1 ni cambian la cartera.</span></div><span className="review-badge">revisión explícita</span></div>
    <form className="chat-composer" onSubmit={send}>
      <div className="chat-controls"><label>Inversor<select value={owner} onChange={event => setOwner(event.target.value)}><option>Jorge</option><option>Julia</option></select></label><label className="attachment-control">Comprobante (foto)<input id="transaction-attachment" type="file" accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp" onChange={event => setAttachment(event.target.files?.[0] ?? null)} /></label></div>
      <textarea value={message} onChange={event => setMessage(event.target.value)} maxLength={3000} rows={3} placeholder="Ej.: Compré 20 PETR4 a R$ 32,50 en 16/08/2026" />
      <div className="composer-footer"><span>{attachment ? attachment.name : "Admite texto y fotos; importa documentos PDF desde la sección Importar."}</span><button className="primary-button" disabled={busy || (!message.trim() && !attachment)}>{busy ? "Registrando…" : "Registrar evidencia"}</button></div>
      {error && <p className="chat-error" role="alert">{error}</p>}{status && <p className="form-status" role="status">{status}</p>}
      {interpretation && <div className="shadow-interpretation" role="status"><strong>Lectura para revisión</strong>{interpretation.interpretation_status === "not_detected" ? <p>No se identificó una operación estructurada; el texto original quedó guardado.</p> : <p>{interpretation.fields.side ?? "lado pendiente"} · {interpretation.fields.instrument_code ?? "activo pendiente"} · {interpretation.fields.quantity ?? "cantidad pendiente"} · {interpretation.fields.unit_price && interpretation.fields.currency ? `${interpretation.fields.currency} ${interpretation.fields.unit_price}` : "precio/moneda pendiente"} · {interpretation.fields.trade_date ?? "fecha pendiente"}</p>}{interpretation.review_reasons.length > 0 && <small>Campos a revisar: {interpretation.review_reasons.join(", ").replaceAll("_", " ")}.</small>}<small>La lectura no confirma la cuenta ni modifica la cartera.</small></div>}
    </form>
  </section>;
}
