"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

type ImportResult = { records?: number; market_value?: string; review_required?: number; detail?: string };

function money(value: number) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }).format(value);
}

function fileFingerprint(file: File | null) {
  return file ? `${file.name}:${file.size}:${file.lastModified}` : "";
}

function fileListFingerprint(files: File[]) {
  return files.map(fileFingerprint).join("|");
}

export function DataImportPanel() {
  const [positionFile, setPositionFile] = useState<File | null>(null);
  const [movementFile, setMovementFile] = useState<File | null>(null);
  const [avenueStatement, setAvenueStatement] = useState<File | null>(null);
  const [avenueConfirmations, setAvenueConfirmations] = useState<File[]>([]);
  const [pensionStatement, setPensionStatement] = useState<File | null>(null);
  const [owner, setOwner] = useState("Jorge");
  const [positionDate,setPositionDate]=useState(new Date().toISOString().slice(0,10));
  const mirrorKeys=useRef(new Map<string,string>());
  const [status, setStatus] = useState("Selecione um arquivo para começar.");
  const [busy, setBusy] = useState(false);
  const [completedB3Key, setCompletedB3Key] = useState("");
  const [completedAvenueKey, setCompletedAvenueKey] = useState("");
  const [completedPensionKey, setCompletedPensionKey] = useState("");
  const b3Key = `${owner}|${positionDate}|${fileFingerprint(positionFile)}|${fileFingerprint(movementFile)}`;
  const avenueKey = `${owner}|${fileFingerprint(avenueStatement)}|${fileListFingerprint(avenueConfirmations)}`;
  const pensionKey = `${owner}|${fileFingerprint(pensionStatement)}`;
  const b3Completed = Boolean(positionFile || movementFile) && completedB3Key === b3Key;
  const avenueCompleted = Boolean(avenueStatement || avenueConfirmations.length) && completedAvenueKey === avenueKey;
  const pensionCompleted = Boolean(pensionStatement) && completedPensionKey === pensionKey;

  async function mirrorDocument(file:File,source:"b3"|"avenue"|"pension",fileType:string,referenceDate:string|null){
    const fingerprint=`${owner}|${source}|${fileType}|${referenceDate??""}|${fileFingerprint(file)}`;
    let requestId=mirrorKeys.current.get(fingerprint);
    if(!requestId){requestId=Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,"0")).join("");mirrorKeys.current.set(fingerprint,requestId);}
    const mime=source==="b3"?"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":"application/pdf";
    const response=await fetch("/api/shadow/evidence/document-file",{method:"POST",headers:{"Content-Type":mime,"X-Juanca-Owner":owner,"X-Juanca-Source":source,"X-Juanca-File-Type":fileType,"X-Juanca-File-Name":encodeURIComponent(file.name),"X-Juanca-Request-Id":requestId,...(referenceDate?{"X-Juanca-Reference-Date":referenceDate}:{})},body:file});
    if(!response.ok)throw new Error(`Não foi possível registrar ${file.name} como evidência. Tente novamente.`);
  }

  async function sendFile(kind: "positions" | "movements", file: File, extra?: Record<string, string>) {
    await mirrorDocument(file,"b3",kind,kind==="positions"?positionDate:(file.name.match(/\d{4}-\d{2}-\d{2}/)?.[0]??null));
    const body = new FormData();
    body.append("file", file); body.append("owner", owner); body.append("kind", kind);
    Object.entries(extra ?? {}).forEach(([key, value]) => body.append(key, value));
    const response = await fetch("/api/import/b3", { method: "POST", body });
    const result = (await response.json()) as ImportResult;
    if (!response.ok) {
      const detail = typeof result.detail === "string" && result.detail.length <= 300 ? result.detail : "Não foi possível processar o arquivo com segurança.";
      throw new Error(detail);
    }
    return result;
  }

  async function importFiles(event: FormEvent) {
    event.preventDefault();
    if ((!positionFile && !movementFile) || b3Completed) return;
    setBusy(true); setStatus("Validando estrutura, normalizando ativos e procurando duplicidades…");
    try {
      const messages: string[] = [];
      if (positionFile) {
        const result = await sendFile("positions", positionFile, { reference_date: positionDate });
        messages.push(`${result.records} posições • ${money(Number(result.market_value))}`);
      }
      if (movementFile) {
        const result = await sendFile("movements", movementFile);
        messages.push(`${result.records} movimentos • ${result.review_required} para revisão`);
      }
      setStatus(`Importação privada concluída: ${messages.join(" | ")}.`);
      setCompletedB3Key(b3Key);
      window.dispatchEvent(new Event("portfolio-data-updated"));
    } catch (error) { setStatus(error instanceof Error ? error.message : "Falha inesperada na importação."); }
    finally { setBusy(false); }
  }

  async function importAvenue(event: FormEvent) {
    event.preventDefault();
    if ((!avenueStatement && !avenueConfirmations.length) || avenueCompleted) return;
    setBusy(true); setStatus("Lendo os PDFs da Avenue e conciliando as operações com a posição inicial…");
    try {
      const files = [
        ...(avenueStatement ? [{ file: avenueStatement, kind: "statement" }] : []),
        ...avenueConfirmations.map((file) => ({ file, kind: "confirmation" })),
      ];
      let records = 0;
      for (const item of files) {
        await mirrorDocument(item.file,"avenue",item.kind==="statement"?"avenue_statement":"avenue_confirmation",null);
        const body = new FormData();
        body.append("file", item.file); body.append("owner", owner); body.append("kind", item.kind);
        const response = await fetch("/api/import/avenue", { method: "POST", body });
        const result = await response.json() as ImportResult;
        if (!response.ok) throw new Error(result.detail ?? `Falha ao importar ${item.file.name}.`);
        records += result.records ?? 0;
      }
      setStatus(`Avenue importada: ${files.length} PDF(s), ${records} registros.`);
      setCompletedAvenueKey(avenueKey);
      window.dispatchEvent(new Event("portfolio-data-updated"));
    } catch (error) { setStatus(error instanceof Error ? error.message : "Falha inesperada na importação Avenue."); }
    finally { setBusy(false); }
  }

  async function importPension(event: FormEvent) {
    event.preventDefault();
    if (!pensionStatement || pensionCompleted) return;
    setBusy(true); setStatus("Lendo o extrato e isolando exclusivamente a Conta Básica Participante…");
    try {
      await mirrorDocument(pensionStatement,"pension","pension_statement",null);
      const body = new FormData(); body.append("file", pensionStatement); body.append("owner", owner);
      const response = await fetch("/api/import/pension", { method: "POST", body });
      const result = await response.json() as ImportResult;
      if (!response.ok) throw new Error(result.detail ?? "Falha ao importar o extrato de previdência.");
      setStatus(`Previdência importada: saldo pessoal de ${money(Number(result.market_value))}. O saldo da empresa foi excluído.`);
      setCompletedPensionKey(pensionKey);
      window.dispatchEvent(new Event("portfolio-data-updated"));
    } catch (error) { setStatus(error instanceof Error ? error.message : "Falha inesperada na importação de previdência."); }
    finally { setBusy(false); }
  }

  return <section className="import-grid" id="importar">
    <article className="panel import-panel import-card">
      <div className="panel-title"><div><p>B3</p><h2>Posições e movimentações</h2></div><span className="safe-badge">somente leitura</span></div>
      <form onSubmit={importFiles}>
        <label>Investidor<select value={owner} onChange={(event) => setOwner(event.target.value)}><option>Jorge</option><option>Julia</option></select></label>
        <label>Posição (.xlsx)<input type="file" accept=".xlsx" onChange={(event) => {const file=event.target.files?.[0]??null;setPositionFile(file);const date=file?.name.match(/\d{4}-\d{2}-\d{2}/)?.[0];if(date)setPositionDate(date);}} /></label>
        <label>Data do relatório de posição<input type="date" value={positionDate} onChange={(event)=>setPositionDate(event.target.value)} /></label>
        <label>Movimentação (.xlsx)<input type="file" accept=".xlsx" onChange={(event) => setMovementFile(event.target.files?.[0] ?? null)} /></label>
        <button className={`primary-button${b3Completed ? " completed" : ""}`} disabled={busy || (!positionFile && !movementFile) || b3Completed}>{busy ? "Processando…" : b3Completed ? "Importação concluída" : "Validar e importar"}</button>
      </form>
    </article>
    <article className="panel import-panel import-card">
      <div className="panel-title"><div><p>Avenue</p><h2>Extrato e notas</h2></div><span className="safe-badge">USD</span></div>
      <form onSubmit={importAvenue}>
        <label>Extrato mensal (.pdf)<input type="file" accept=".pdf,application/pdf" onChange={(event) => setAvenueStatement(event.target.files?.[0] ?? null)} /></label>
        <label>Notas de corretagem (.pdf)<input type="file" multiple accept=".pdf,application/pdf" onChange={(event) => setAvenueConfirmations(Array.from(event.target.files ?? []))} /></label>
        <button className={`primary-button${avenueCompleted ? " completed" : ""}`} disabled={busy || (!avenueStatement && !avenueConfirmations.length) || avenueCompleted}>{busy ? "Processando…" : avenueCompleted ? "Importação concluída" : "Importar Avenue"}</button>
      </form>
      <p className="source-note">O extrato cria a posição-base e as notas posteriores ajustam quantidades e caixa.</p>
    </article>
    <article className="panel import-panel import-card">
      <div className="panel-title"><div><p>Previdência</p><h2>Santander</h2></div><span className="safe-badge">saldo pessoal</span></div>
      <form onSubmit={importPension}>
        <label>Extrato Santander (.pdf)<input type="file" accept=".pdf,application/pdf" onChange={(event) => setPensionStatement(event.target.files?.[0] ?? null)} /></label>
        <button className={`primary-button${pensionCompleted ? " completed" : ""}`} disabled={busy || !pensionStatement || pensionCompleted}>{busy ? "Processando…" : pensionCompleted ? "Importação concluída" : "Importar previdência"}</button>
      </form>
      <p className="source-note">Somente a Conta Básica Participante entra no patrimônio; a conta da empresa permanece excluída.</p>
    </article>
    <p className="panel import-status" aria-live="polite">{status}</p>
  </section>;
}

export function ProjectionPanel() {
  const [startingValue, setStartingValue] = useState<number|null>(null);
  useEffect(()=>{
    const controller=new AbortController();
    void fetch('/api/portfolio/dashboard',{cache:'no-store',signal:controller.signal})
      .then(async r=>r.ok?r.json() as Promise<{valuation_complete?:boolean;total_value_cents:number}>:null).then(data=>{
        if(data?.valuation_complete&&data.total_value_cents>0) setStartingValue(current=>current??data.total_value_cents/100);
      }).catch(()=>undefined);
    return ()=>controller.abort();
  },[]);
  const [annualReturn, setAnnualReturn] = useState(9);
  const [inflation, setInflation] = useState(4.5);
  const [years, setYears] = useState(10);
  const projection = useMemo(() => {
    if(startingValue===null)return {nominal:null,real:null};
    const nominal = startingValue * (1 + annualReturn / 100) ** years;
    return { nominal, real: nominal / (1 + inflation / 100) ** years };
  }, [annualReturn, inflation, startingValue, years]);

  return <section className="panel projection-panel" id="projecoes">
    <div className="panel-title"><div><p>Cenário editável</p><h2>Projeção patrimonial</h2></div><span className="period">valor real e nominal</span></div>
    <div className="projection-inputs">
      <label>Patrimônio inicial<input type="number" value={startingValue??""} placeholder="Informe o capital inicial" onChange={(event) => setStartingValue(event.target.value?Number(event.target.value):null)} /></label>
      <label>Retorno anual<input type="number" step="0.1" value={annualReturn} onChange={(event) => setAnnualReturn(Number(event.target.value))} /><span>%</span></label>
      <label>Inflação anual<input type="number" step="0.1" value={inflation} onChange={(event) => setInflation(Number(event.target.value))} /><span>%</span></label>
      <label>Horizonte<input type="number" min="1" max="80" value={years} onChange={(event) => setYears(Number(event.target.value))} /><span>anos</span></label>
    </div>
    <div className="projection-results"><div><small>Valor nominal</small><strong>{projection.nominal===null?"Informe o capital":money(projection.nominal)}</strong></div><div><small>Em reais de hoje</small><strong>{projection.real===null?"Informe o capital":money(projection.real)}</strong></div></div>
    <p className="disclaimer">Simulação determinística, não promessa de rentabilidade. Impostos, custos e fluxos futuros ainda não estão incluídos.</p>
  </section>;
}

export function RecommendationsPanel() {
  return <section className="panel recommendations" id="recomendacoes">
    <div className="panel-title"><div><p>Motor de regras explicáveis</p><h2>Recomendações para revisar</h2></div><span className="review-badge">não executa ordens</span></div>
    <div className="recommendation-grid">
      <div><span className="priority high">prioridade alta</span><h3>Validar concentração por emissor</h3><p>Exposições de renda fixa acima de R$ 250 mil exigem análise por titular, conglomerado e cobertura vigente.</p></div>
      <div><span className="priority medium">planejamento</span><h3>Preparar próximos vencimentos</h3><p>Crie uma fila de reinvestimento para evitar que resgates sejam realocados sem considerar liquidez e objetivos.</p></div>
      <div><span className="priority blocked">bloqueada</span><h3>Conciliar eventos ambíguos</h3><p>Atualizações de custódia precisam de confirmação antes de influenciar sugestões sobre os ativos envolvidos.</p></div>
    </div>
  </section>;
}
