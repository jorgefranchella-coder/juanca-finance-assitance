"use client";

import { FormEvent, useEffect, useRef, useState } from "react";

type Message = { role: "user" | "assistant"; content: string };

export default function HermesChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const thread = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/hermes/chat", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const result = await response.json() as {detail?:string;messages?:Message[]};
        if (!response.ok) throw new Error(result.detail ?? "Não foi possível carregar a conversa.");
        setMessages(result.messages ?? []);
      }).catch((err) => { if (err.name !== "AbortError") setError(err.message); })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (thread.current) thread.current.scrollTop = thread.current.scrollHeight;
  }, [messages, busy]);
  async function send(event: FormEvent) {
    event.preventDefault();
    const text = message.trim();
    if (!text || busy) return;
    setBusy(true); setError("");
    setMessages((current) => [...current, { role: "user", content: text }]);
    setMessage("");
    try {
      const response = await fetch("/api/hermes/chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      const result = await response.json() as {detail?:string;messages?:Message[]};
      if (!response.ok) throw new Error(result.detail ?? "Não foi possível falar com Juanca.");
      setMessages(result.messages ?? []);
      window.dispatchEvent(new Event("portfolio-data-updated"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha na conexão com Juanca.");
      // Reload saved history before another send; the previous request may have completed.
      try {
        const response = await fetch("/api/hermes/chat", { cache: "no-store" });
        if (response.ok) { const result = await response.json() as {detail?:string;messages?:Message[]}; setMessages(result.messages ?? []); }
      } catch { /* The error above remains visible. */ }
    } finally { setBusy(false); }
  }
  return <section className="panel transaction-chat hermes-chat">
    <div className="panel-title chat-title"><div><p>Seu agente Hermes</p><h2>Converse com Juanca</h2><span>Consulte o patrimônio, analise documentos importados e prepare ajustes com seu agente.</span></div><img className="juanca-chat-icon" src="/juanca-icon.png" alt="Juanca, seu assistente de patrimônio" width={64} height={64} /></div>
    <div className="chat-thread" ref={thread} aria-live="polite" aria-busy={busy || loading}>
      {loading && <p className="chat-empty">Carregando conversa…</p>}
      {!loading && !messages.length && <div className="chat-empty"><strong>Como posso ajudar com o patrimônio de vocês?</strong><p>Pergunte: “O que tenho na carteira?” ou “Quais revisões estão pendentes?”</p></div>}
      {messages.map((item, index) => <div className={`chat-message ${item.role}`} key={index}><div className="chat-bubble"><small>{item.role === "user" ? "Você" : "Juanca"}</small><p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{item.content}</p></div></div>)}
      {busy && <div className="chat-message assistant"><div className="chat-bubble"><small>Juanca</small><p role="status">Consultando e preparando a resposta…</p></div></div>}
    </div>
    <form className="chat-composer" onSubmit={send}>
      <label htmlFor="juanca-message">Mensagem para Juanca</label>
      <textarea id="juanca-message" value={message} onChange={(event) => setMessage(event.target.value)} maxLength={8000} rows={3} disabled={busy || loading} placeholder="Pergunte sobre seu patrimônio ou peça ajuda para analisar uma operação…" />
      <div className="composer-footer"><span>Conversa compartilhada da família. Ajustes dependem da sua autorização.</span><button className="primary-button" disabled={busy || loading || !message.trim()}>{busy ? "Aguardando Juanca…" : "Enviar"}</button></div>
      {error && <p className="chat-error" role="alert">{error}</p>}
    </form>
  </section>;
}
