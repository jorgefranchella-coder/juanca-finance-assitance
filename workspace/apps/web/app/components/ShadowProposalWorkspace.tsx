"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

type Account = { id: string; owner_id: string; owner: string; identity_status: "known" | "unresolved"; account_scope: string };
type Evidence = { id: string; kind: "manual_text" | "manual_photo"; owner_id: string; owner: string; description: string; occurred_on: string | null; status: string };
type Proposal = { id: string; owner_id: string; owner: string; account_id: string; account_scope: string; instrument_code: string; currency: string; side: "buy" | "sell"; quantity: string; unit_price: string; fees_minor: string; effective_date: string; version:number; summary_hash:string; status: string; source_evidence_kind?: string | null; source_evidence_id?: string | null; source_evidence_text?: string | null };
const money = (value: string, currency: string) => new Intl.NumberFormat("pt-BR", { style: "currency", currency }).format(Number(value));

export default function ShadowProposalWorkspace() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [ownerId, setOwnerId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [evidenceId, setEvidenceId] = useState("");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [instrument, setInstrument] = useState("");
  const [currency, setCurrency] = useState("BRL");
  const [quantity, setQuantity] = useState("");
  const [unitPrice, setUnitPrice] = useState("");
  const [fees, setFees] = useState("0");
  const [effectiveDate, setEffectiveDate] = useState(new Date().toLocaleDateString("en-CA"));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [factsRevision,setFactsRevision]=useState("");
  const [reviewing,setReviewing]=useState("");
  const pendingRequest = useRef<{ fingerprint: string; key: string } | null>(null);

  const owners = useMemo(() => Array.from(new Map(accounts.map(a => [a.owner_id, { id: a.owner_id, name: a.owner }])).values()), [accounts]);
  const ownerAccounts = useMemo(() => accounts.filter(a => a.owner_id === ownerId), [accounts, ownerId]);
  const ownerEvidence = useMemo(() => evidence.filter(item => item.owner_id === ownerId && item.status === "awaiting_review"), [evidence, ownerId]);
  const selectedEvidence = ownerEvidence.find(item => `${item.kind}:${item.id}` === evidenceId);
  const selectedEvidenceId = selectedEvidence ? evidenceId : "";
  const selectedAccountId = ownerAccounts.some(a => a.id === accountId) ? accountId : ownerAccounts.find(a => a.identity_status === "known")?.id ?? "";

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const [accountResponse, proposalResponse, evidenceResponse, photoResponse,portfolioResponse] = await Promise.all([
        fetch("/api/shadow/accounts", { cache: "no-store" }),
        fetch("/api/shadow/proposals?status=pending", { cache: "no-store" }),
        fetch("/api/shadow/evidence/text", { cache: "no-store" }),
        fetch("/api/shadow/evidence/photos", { cache: "no-store" }),
        fetch("/api/shadow/portfolio", { cache: "no-store" }),
      ]);
      if (!accountResponse.ok || !proposalResponse.ok || !evidenceResponse.ok || !photoResponse.ok || !portfolioResponse.ok) throw new Error("La API PostgreSQL no pudo cargar cuentas, cartera y evidencias.");
      const accountData = await accountResponse.json() as { accounts: Account[] };
      const proposalData = await proposalResponse.json() as { proposals: Proposal[] };
      const evidenceData = await evidenceResponse.json() as { items: Array<Omit<Evidence, "kind" | "description"> & { original_text: string }> };
      const photoData = await photoResponse.json() as { items: Array<{ upload_id: string; owner_id: string; owner: string; file_name: string; status: string; proposal_evidence_status: string }> };
      const portfolioData=await portfolioResponse.json() as {facts_revision?:string|number};
      setAccounts(accountData.accounts ?? []); setProposals(proposalData.proposals ?? []);
      setFactsRevision(String(portfolioData.facts_revision??""));
      setEvidence([
        ...(evidenceData.items ?? []).map(item => ({ ...item, kind: "manual_text" as const, description: item.original_text })),
        ...(photoData.items ?? []).filter(item => item.status === "stored" && item.proposal_evidence_status === "awaiting_review").map(item => ({ id: item.upload_id, kind: "manual_photo" as const, owner_id: item.owner_id, owner: item.owner, description: item.file_name, occurred_on: null, status: item.proposal_evidence_status })),
      ]);
      const firstOwner = accountData.accounts?.[0]?.owner_id ?? "";
      setOwnerId(current => current || firstOwner);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível carregar as propostas sombra.");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); const refresh=()=>void load();window.addEventListener("shadow-evidence-updated",refresh);return () => {window.clearTimeout(timer);window.removeEventListener("shadow-evidence-updated",refresh);}; }, [load]);

  async function submit(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError(""); setMessage("");
    try {
      if (!selectedEvidence) throw new Error("Selecciona una evidencia pendiente del mismo titular.");
      const input = { owner_id: ownerId, account_id: selectedAccountId, instrument_code: instrument.trim().toUpperCase(), currency, side, quantity, unit_price: unitPrice, fees_minor: fees, effective_date: effectiveDate, source_evidence: { kind: selectedEvidence.kind, id: selectedEvidence.id } };
      const fingerprint = JSON.stringify(input);
      if (pendingRequest.current?.fingerprint !== fingerprint) pendingRequest.current = { fingerprint, key: crypto.randomUUID().replaceAll("-", "_") };
      const key = pendingRequest.current.key;
      const response = await fetch("/api/shadow/proposals", {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify(input),
      });
      const result = await response.json() as { code?: string; proposal_id?: string };
      if (!response.ok) throw new Error(result.code === "FORBIDDEN" ? "Este usuario puede preparar propuestas; la API todavía no le permite ejecutar ni descartar movimientos." : result.code ?? "No se pudo guardar la propuesta.");
      setMessage(`Propuesta ${result.proposal_id ?? ""} guardada como pendiente. La cartera no cambió.`);
      pendingRequest.current = null; setInstrument(""); setQuantity(""); setUnitPrice(""); setFees("0"); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo guardar la propuesta."); }
    finally { setSaving(false); }
  }

  async function decide(proposal:Proposal,action:"approve"|"reject"){
    if(!proposal.version||!proposal.summary_hash||!factsRevision){setError("Falta la versión vigente de la propuesta o de la cartera PostgreSQL.");return;}
    const question=action==="approve"?`Aprobar ${proposal.side==="buy"?"la compra":"la venta"} de ${proposal.quantity} ${proposal.instrument_code} en PostgreSQL sombra? La cartera D1 visible en el panel principal no cambia hasta el corte.`:`Rechazar la propuesta de ${proposal.instrument_code} en PostgreSQL sombra?`;
    if(!window.confirm(question))return;
    setReviewing(proposal.id);setError("");setMessage("");
    try{
      const key=crypto.randomUUID().replaceAll("-","_");
      const response=await fetch(`/api/shadow/proposals/${proposal.id}/${action}`,{method:"POST",headers:{"Content-Type":"application/json","Idempotency-Key":key},body:JSON.stringify({version:proposal.version,summary_hash:proposal.summary_hash,expected_facts_revision:factsRevision})});
      const result=await response.json() as {code?:string};
      if(!response.ok)throw new Error(result.code==="STALE_PORTFOLIO"?"La cartera cambió. Actualiza la bandeja y vuelve a revisar la propuesta.":result.code??"No se pudo registrar la decisión.");
      setMessage(action==="approve"?"Movimiento aprobado y aplicado exclusivamente a la cartera PostgreSQL sombra.":"Propuesta rechazada en PostgreSQL sombra.");
      await load();window.dispatchEvent(new Event("shadow-portfolio-updated"));
    }catch(cause){setError(cause instanceof Error?cause.message:"No se pudo registrar la decisión.");}
    finally{setReviewing("");}
  }

  return <section className="panel shadow-proposals">
    <div className="panel-title"><div><p>PostgreSQL · sombra</p><h2>Registrar movimiento</h2><span>La propuesta queda pendiente y no altera la cartera. La revisión final sigue protegida por permisos.</span></div><span className="review-badge">sin ejecución</span></div>
    {error && <p className="chat-error" role="alert">{error}</p>}
    {message && <p className="form-status" role="status">{message}</p>}
    {!loading && accounts.length === 0 && !error && <p>No hay cuentas disponibles para registrar movimientos.</p>}
    <form className="shadow-proposal-form" onSubmit={submit}>
      <label>Inversor<select value={ownerId} onChange={e => setOwnerId(e.target.value)} required><option value="">Elegir</option>{owners.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label>
      <label>Cuenta de custodia<select value={selectedAccountId} onChange={e => setAccountId(e.target.value)} required><option value="">Elegir cuenta conocida</option>{ownerAccounts.map(a => <option key={a.id} value={a.id} disabled={a.identity_status !== "known"}>{a.account_scope} · {a.identity_status === "known" ? "identificada" : "pendiente de identificar"}</option>)}</select></label>
      <label className="shadow-evidence-field">Evidencia de la operación<select value={selectedEvidenceId} onChange={e => setEvidenceId(e.target.value)} required><option value="">Elegir evidencia pendiente</option>{ownerEvidence.map(item => <option key={`${item.kind}:${item.id}`} value={`${item.kind}:${item.id}`}>{item.kind === "manual_photo" ? "Foto" : "Texto"} · {item.occurred_on ?? "sin fecha"} · {item.description.slice(0, 100)}</option>)}</select></label>
      <label>Operación<select value={side} onChange={e => setSide(e.target.value as "buy" | "sell")}><option value="buy">Compra</option><option value="sell">Venta</option></select></label>
      <label>Ticker<input value={instrument} onChange={e => setInstrument(e.target.value)} maxLength={32} required /></label>
      <label>Moneda<select value={currency} onChange={e => setCurrency(e.target.value)}><option>BRL</option><option>USD</option></select></label>
      <label>Fecha<input type="date" value={effectiveDate} onChange={e => setEffectiveDate(e.target.value)} required /></label>
      <label>Cantidad<input type="number" min="0.00000001" step="any" value={quantity} onChange={e => setQuantity(e.target.value)} required /></label>
      <label>Precio unitario<input type="number" min="0.00000001" step="any" value={unitPrice} onChange={e => setUnitPrice(e.target.value)} required /></label>
      <label>Comisiones (centavos)<input type="number" min="0" step="1" value={fees} onChange={e => setFees(e.target.value)} required /></label>
      <button className="primary-button" disabled={saving || loading || !selectedAccountId}>{saving ? "Guardando…" : "Guardar propuesta pendiente"}</button>
    </form>
    <div className="shadow-proposal-queue"><h3>Propuestas pendientes ({proposals.length})</h3>{loading ? <p>Cargando…</p> : proposals.length === 0 ? <p>No hay propuestas pendientes.</p> : <div className="table-wrap"><table><thead><tr><th>Fecha</th><th>Inversor / cuenta</th><th>Movimiento</th><th>Cantidad</th><th>Precio</th><th>Evidencia</th><th>Decisión</th></tr></thead><tbody>{proposals.map(p => <tr key={p.id}><td>{p.effective_date}</td><td>{p.owner}<small>{p.account_scope}</small></td><td>{p.side === "buy" ? "Compra" : "Venta"} {p.instrument_code}</td><td>{p.quantity}</td><td>{money(p.unit_price, p.currency)}</td><td>{p.source_evidence_kind === "manual_photo" && p.source_evidence_id ? <a href={`/api/shadow/evidence/photos/${p.source_evidence_id}/content`} target="_blank" rel="noreferrer">{p.source_evidence_text ?? "Abrir foto"}</a> : p.source_evidence_text ?? "Evidencia histórica pendiente"}</td><td><div className="proposal-actions"><button className="proposal-reject" disabled={reviewing===p.id} onClick={()=>void decide(p,"reject")}>{reviewing===p.id?"Guardando…":"Rechazar"}</button><button className="proposal-approve" disabled={reviewing===p.id} onClick={()=>void decide(p,"approve")}>{reviewing===p.id?"Guardando…":"Aprobar en PostgreSQL"}</button></div></td></tr>)}</tbody></table></div>}</div>
  </section>;
}
