"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";

type Proposal = {
  id: string; owner: string; side: "buy" | "sell"; instrument_code: string;
  quantity: number; unit_price: number; currency: "BRL" | "USD"; trade_date: string;
  fees_minor: number; source: string; confidence: number; evidence: string;
  status: "pending" | "applied" | "rejected" | "duplicate";
};
type Message = {
  id: string; role: "user" | "assistant"; content: string; attachment_name: string | null;
  created_at: string; proposals: Proposal[];
};
type ShadowInterpretation = { interpretation_status: "parsed_review" | "needs_manual_review" | "not_detected"; fields: { side?: string|null; instrument_code?: string|null; quantity?: string|null; unit_price?: string|null; currency?: string|null; trade_date?: string|null }; review_reasons: string[] };

function price(value: number, currency: string) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency }).format(value);
}

export default function TransactionChat({ prefill }: { prefill?: {message:string;owner:string} }) {
  const [duplicateId,setDuplicateId]=useState<string|null>(null);
  const [factsRevision,setFactsRevision]=useState<number|undefined>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [owner, setOwner] = useState(prefill?.owner??"Jorge");
  const [message, setMessage] = useState(prefill?.message??"");
  const [attachment, setAttachment] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [evidenceStatus,setEvidenceStatus]=useState("");
  const [evidenceInterpretation,setEvidenceInterpretation]=useState<ShadowInterpretation|null>(null);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const pendingEvidence=useRef<{id:string;fingerprint:string}|null>(null);
  const threadRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/transactions/chat", { cache: "no-store" });
    const result = await response.json() as { messages?: Message[]; facts_revision?: number; detail?: string };
    if (!response.ok) throw new Error(result.detail ?? "Não foi possível carregar a conversa.");
    setMessages(result.messages ?? []);setFactsRevision(result.facts_revision);
  }, []);

  useEffect(() => { const timer=window.setTimeout(()=>void load().catch((loadError) => setError(loadError.message)),0);return ()=>window.clearTimeout(timer); }, [load]);
  useEffect(() => {
    const thread = threadRef.current;
    if (thread) thread.scrollTop = thread.scrollHeight;
  }, [messages]);

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!message.trim() && !attachment) return;
    setBusy(true); setError("");setEvidenceStatus("");setEvidenceInterpretation(null);
    try {
      const fingerprint=`${owner}|${message}|${attachment?.name??""}|${attachment?.size??0}|${attachment?.lastModified??0}`;
      if(pendingEvidence.current?.fingerprint!==fingerprint){
        const bytes=crypto.getRandomValues(new Uint8Array(16));
        pendingEvidence.current={id:Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join(""),fingerprint};
      }
      const evidenceId=pendingEvidence.current.id;
      let registered=false;
      if(message.trim()){
        const saved=await fetch("/api/shadow/evidence/text",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({request_id:evidenceId,owner,text:message.trim()})});
        if(!saved.ok)throw new Error("Não foi possível registrar a mensagem como evidência. Tente novamente.");
        const result=await saved.json() as {interpretation?:ShadowInterpretation|null};
        setEvidenceInterpretation(result.interpretation??null);
        registered=true;
      }
      if(attachment?.type.startsWith("image/")){
        const saved=await fetch("/api/shadow/evidence/photo-file",{method:"POST",headers:{"Content-Type":attachment.type,"X-Juanca-Owner":owner,"X-Juanca-File-Name":encodeURIComponent(attachment.name),"X-Juanca-Request-Id":evidenceId+".photo"},body:attachment});
        if(!saved.ok)throw new Error("Não foi possível registrar a foto como evidência. Tente novamente.");
        registered=true;
      }
      if(registered)setEvidenceStatus("Evidência registrada para conciliação na nova aplicação.");
      const body = new FormData();
      body.append("owner", owner); body.append("message", message);
      if (attachment) body.append("attachment", attachment);
      const response = await fetch("/api/transactions/chat", { method: "POST", body });
      const result = await response.json() as { messages?: Message[]; facts_revision?: number; detail?: string };
      if (!response.ok) throw new Error(result.detail ?? "Não foi possível interpretar a operação.");
      setMessages(result.messages ?? []);setFactsRevision(result.facts_revision); setMessage(""); setAttachment(null);pendingEvidence.current=null;
      const input = document.querySelector<HTMLInputElement>("#transaction-attachment");
      if (input) input.value = "";
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Não foi possível enviar.");
    } finally { setBusy(false); }
  }

  async function review(proposal: Proposal, action: "approve" | "reject") {
    setReviewing(proposal.id); setError("");
    try {
      const response = await fetch(`/api/transactions/proposals/${proposal.id}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, expected_revision: factsRevision, allow_similar: duplicateId===proposal.id }),
      });
      const result = await response.json() as { detail?: string; code?: string };
      if (!response.ok) {
        if(result.code==='POSSIBLE_DUPLICATE')setDuplicateId(proposal.id);
        if(result.code==='STALE_PORTFOLIO')await load();
        throw new Error(result.detail ?? "Não foi possível registrar a decisão.");
      }
      setDuplicateId(null);
      await load();
      if (action === "approve") window.dispatchEvent(new Event("portfolio-data-updated"));
    } catch (reviewError) {
      setError(reviewError instanceof Error ? reviewError.message : "Não foi possível registrar a decisão.");
    } finally { setReviewing(null); }
  }

  return (
    <section className="panel transaction-chat" id="transacoes">
      <div className="panel-title chat-title">
        <div><p>Entrada conversacional</p><h2>Assistente de transações</h2><span>Envie uma ordem, nota ou comprovante. A carteira só muda depois da sua aprovação.</span></div>
        <span className="review-badge">revisão obrigatória</span>
      </div>
      <div className="chat-layout">
        <div className="chat-thread" aria-live="polite" ref={threadRef}>
          {!messages.length && <div className="chat-empty"><strong>Descreva a operação como você falaria normalmente.</strong><p>Exemplo: “Comprei 20 PETR4 a R$ 32,50 em 16/08/2026” ou anexe uma nota de corretagem da Avenue.</p></div>}
          {messages.map((item) => <div className={`chat-message ${item.role}`} key={item.id}>
            <div className="chat-bubble"><small>{item.role === "user" ? "Você" : "Assistente"}</small><p>{item.content}</p>{item.attachment_name && <span className="chat-attachment">Anexo · {item.attachment_name}</span>}</div>
            {item.proposals.map((proposal) => <article className="transaction-proposal" key={proposal.id}>
              <header><span className={`trade-side ${proposal.side}`}>{proposal.side === "buy" ? "Compra" : "Venda"}</span><strong>{proposal.instrument_code}</strong><small>{Math.round(proposal.confidence * 100)}% de confiança</small></header>
              <dl><div><dt>Investidor</dt><dd>{proposal.owner}</dd></div><div><dt>Quantidade</dt><dd>{proposal.quantity.toLocaleString("pt-BR")}</dd></div><div><dt>Preço unitário</dt><dd>{price(proposal.unit_price, proposal.currency)}</dd></div><div><dt>Taxas</dt><dd>{price(proposal.fees_minor/100,proposal.currency)}</dd></div><div><dt>Data</dt><dd>{proposal.trade_date.split("-").reverse().join("/")}</dd></div></dl>
              <p className="proposal-evidence">Fonte: {proposal.source.replaceAll("_", " ")} · {proposal.evidence}</p>
              {proposal.status === "pending" ? <footer><button className="proposal-reject" disabled={reviewing === proposal.id} onClick={() => void review(proposal, "reject")}>Descartar</button><button className="proposal-approve" disabled={reviewing === proposal.id} onClick={() => void review(proposal, "approve")}>{reviewing === proposal.id ? "Salvando…" : duplicateId===proposal.id ? "Confirmar operação distinta" : "Aprovar ajuste"}</button></footer> : <div className={`proposal-status ${proposal.status}`}>{proposal.status === "applied" ? "Ajuste aplicado à carteira" : proposal.status === "duplicate" ? "Operação já existente na carteira" : "Proposta descartada"}</div>}
            </article>)}
          </div>)}
        </div>
        <form className="chat-composer" onSubmit={send}>
          <div className="chat-controls"><label>Investidor<select value={owner} onChange={(event) => setOwner(event.target.value)}><option>Jorge</option><option>Julia</option></select></label><label className="attachment-control">Comprovante<input id="transaction-attachment" type="file" accept=".pdf,.txt,.csv,.png,.jpg,.jpeg,.webp,application/pdf,text/plain,text/csv,image/*" onChange={(event) => setAttachment(event.target.files?.[0] ?? null)} /></label></div>
          <textarea value={message} onChange={(event) => setMessage(event.target.value)} maxLength={3000} rows={3} placeholder="Ex.: Vendi 5 AAPL a US$ 225,40 para a carteira da Julia em 16/08/2026" />
          <div className="composer-footer"><span>{attachment ? attachment.name : "PDFs com texto são interpretados; imagens ficam guardadas para complemento manual."}</span><button className="primary-button" disabled={busy || (!message.trim() && !attachment)}>{busy ? "Interpretando…" : "Enviar para análise"}</button></div>
          {error && <p className="chat-error" role="alert">{error}</p>}
          {evidenceStatus && <p className="form-status" role="status">{evidenceStatus}</p>}
          {evidenceInterpretation && <div className="shadow-interpretation" role="status"><strong>Leitura local para revisão</strong>{evidenceInterpretation.interpretation_status==="not_detected"?<p>Não foi identificada uma operação estruturada; o texto original ficou guardado.</p>:<p>{evidenceInterpretation.fields.side??"Lado pendente"} · {evidenceInterpretation.fields.instrument_code??"ativo pendente"} · {evidenceInterpretation.fields.quantity??"quantidade pendente"} · {evidenceInterpretation.fields.unit_price&&evidenceInterpretation.fields.currency?`${evidenceInterpretation.fields.currency} ${evidenceInterpretation.fields.unit_price}`:"preço/moeda pendente"} · {evidenceInterpretation.fields.trade_date??"data pendente"}</p>}{evidenceInterpretation.review_reasons.length>0&&<small>Campos a revisar: {evidenceInterpretation.review_reasons.join(", ").replaceAll("_"," ")}.</small>}<small>Esta leitura não altera a carteira nem confirma custodiante ou conta.</small></div>}
        </form>
      </div>
    </section>
  );
}
