"use client";
import { FormEvent, useEffect, useRef, useState } from 'react';
type Action = { type: string; message?: string; owner?: string };
type ChatResponse = {messages?: Message[]; detail?: string};
type Message = { id: string; role: 'user' | 'assistant'; content: string; origin?: string; actions?: Action[] };

export default function JuancaChat() {
  const [messages,setMessages]=useState<Message[]>([]);
  const [message,setMessage]=useState('');
  const [owner,setOwner]=useState('family');
  const [busy,setBusy]=useState(false);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const pending=useRef<{id:string;message:string;owner:string}|null>(null);
  const thread=useRef<HTMLDivElement>(null);
  async function history(signal?: AbortSignal) {
    const r=await fetch('/api/juanca/chat',{cache:'no-store',signal});
    const result=await r.json() as ChatResponse;
    if (!r.ok) throw new Error(result.detail??'Não foi possível carregar a conversa.');
    setMessages(result.messages??[]);
  }
  useEffect(()=>{
    const controller=new AbortController();
    const timer=window.setTimeout(()=>void history(controller.signal).catch(err=>{if(err.name!=='AbortError')setError(err.message);}).finally(()=>setLoading(false)),0);
    return ()=>{window.clearTimeout(timer);controller.abort();};
  },[]);
  useEffect(()=>{if(thread.current)thread.current.scrollTop=thread.current.scrollHeight;},[messages,busy]);
  async function send(event:FormEvent) {
    event.preventDefault();
    const text=message.trim();
    if(!text||busy)return;
    setBusy(true);setError('');
    if(pending.current?.message!==text||pending.current?.owner!==owner) pending.current={id:globalThis.crypto.randomUUID?.()??Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join(''),message:text,owner};
    try {
      const r=await fetch('/api/juanca/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:text,owner,request_id:pending.current.id})});
      const result=await r.json() as ChatResponse;
      if(!r.ok)throw new Error(result.detail??'Não foi possível consultar os dados.');
      setMessages(result.messages??[]);setMessage('');pending.current=null;
    }catch(err){
      setError(err instanceof Error?err.message:'Falha na consulta.');
      await history().catch(()=>undefined);
    }finally{setBusy(false);}
  }
  return <section className="panel transaction-chat hermes-chat">
    <div className="panel-title chat-title"><div><p>Seu patrimônio</p><h2>Converse com Juanca</h2><span>Consulte a carteira, custos, revisões e projeções. Prepare operações para conferir em Transações.</span></div><img className="juanca-chat-icon" src="/juanca-icon.png" alt="Juanca" width={64} height={64}/></div>
    <div className="chat-thread" ref={thread} aria-live="polite" aria-busy={busy||loading}>
      {loading&&<p className="chat-empty">Carregando conversa…</p>}
      {!loading&&!messages.length&&<div className="chat-empty"><strong>Como posso ajudar com o patrimônio de vocês?</strong><p>“Qual o patrimônio da Julia?” ou “Quais revisões estão pendentes?”</p></div>}
      {messages.map(item=><div className={`chat-message ${item.role}`} key={item.id}><div className="chat-bubble"><small>{item.role==='user'?'Você':'Juanca'}{item.origin==='hermes_archive'?' · Histórico anterior':''}</small><p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{item.content}</p>{item.actions?.map((action,i)=><button key={i} className="secondary-button" type="button" onClick={()=>window.dispatchEvent(new CustomEvent('juanca-action',{detail:action}))}>{action.type==='prepare_transaction'?'Preparar operação':action.type==='open_reviews'?'Ver revisões':'Ver transações'}</button>)}</div></div>)}
      {busy&&<div className="chat-message assistant"><div className="chat-bubble"><small>Juanca</small><p role="status">Consultando os dados…</p></div></div>}
    </div>
    <form className="chat-composer" onSubmit={send}>
      <label>Titular<select value={owner} onChange={e=>setOwner(e.target.value)} disabled={busy}><option value="family">Família</option><option>Jorge</option><option>Julia</option></select></label>
      <label htmlFor="juanca-message">Mensagem para Juanca</label>
      <textarea id="juanca-message" value={message} onChange={e=>setMessage(e.target.value)} maxLength={8000} rows={3} disabled={busy||loading} placeholder="Pergunte sobre o patrimônio, carteira, custos, revisões ou renda fixa"/>
      <div className="composer-footer"><span>Conversa compartilhada da família. Confira e aprove ajustes em Transações.</span><button className="primary-button" disabled={busy||loading||!message.trim()}>{busy?'Consultando…':'Enviar'}</button></div>
      {error&&<p className="chat-error" role="alert">{error}</p>}
    </form>
  </section>;
}
