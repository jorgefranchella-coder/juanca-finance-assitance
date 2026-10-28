"use client";

import {useCallback,useEffect,useMemo,useState,type FormEvent} from "react";
import {buildReviewCards,type Confirmation,type PhotoEvidence,type Position,type Proposal,type ReviewCard,type ReviewKind,type ReviewLane,type Snapshot,type TextEvidence} from "../../lib/review-inbox";

type Account={id:string;owner_id:string;owner:string;identity_status:string;account_scope:string};
type InboxData={cards:ReviewCard[];factsRevision:string;portfolioDate:string|null;accounts:Account[];positions:Position[]};
const EMPTY_CARDS:ReviewCard[]=[];
const date=(value:string|null)=>{if(!value)return "Sin fecha";const parsed=new Date(/^\d{4}-\d{2}-\d{2}$/.test(value)?`${value}T12:00:00Z`:value);return Number.isNaN(parsed.getTime())?value:new Intl.DateTimeFormat("es-AR",{day:"2-digit",month:"2-digit",year:"numeric",timeZone:"America/Sao_Paulo"}).format(parsed);};
const money=(value:string,currency:string)=>new Intl.NumberFormat("es-AR",{style:"currency",currency:currency==='USD'?'USD':'BRL'}).format(Number(value));
const kindLabel:Record<ReviewKind,string>={proposal:'Movimiento',confirmation:'Confirmación',b3_snapshot:'B3',external_snapshot:'Extracto externo',text:'Texto',photo:'Foto'};
const statusLabel:Record<string,string>={pending:'Pendiente de decisión',open:'Pendiente de respuesta',applied:'Aprobado',rejected:'Rechazado',resolved:'Respondido',published:'Publicado',parsed_review:'Datos identificados',needs_manual_review:'Interpretación incompleta',not_detected:'Sin operación identificada',completed:'OCR disponible',queued:'OCR en espera'};
const ageLabel=(receivedAt:string,lane:ReviewLane)=>{if(lane==='history')return '';const age=Math.floor((Date.now()-Date.parse(receivedAt))/86400000);return Number.isFinite(age)&&age>0?` · hace ${age} ${age===1?'día':'días'}`:'';};
const codeMessage:Record<string,string>={STALE_PORTFOLIO:'La cartera cambió. Actualiza la bandeja y revisa de nuevo.',EVENT_AT_OR_BEFORE_SNAPSHOT:'La operación podría estar incluida en el último extracto de esta cuenta. Debe conciliarse antes de aprobar.',INSUFFICIENT_POSITION:'La cantidad supera la posición disponible en esa cuenta.',UNKNOWN_POSITION:'No se encontró una posición verificable en esa cuenta.',PROPOSAL_CHANGED:'La propuesta cambió. Actualiza la bandeja.',FORBIDDEN:'Tu usuario no tiene permiso para aprobar esta decisión.',HISTORICAL_SNAPSHOT_REQUIRES_CORRECTION_FLOW:'Este extracto requiere una corrección histórica.',SNAPSHOT_ALREADY_PUBLISHED:'Este extracto ya fue publicado.'};
function relatedLabel(card:ReviewCard){const parts:string[]=[];if(card.related_texts.length)parts.push(`${card.related_texts.length} ${card.related_texts.length===1?'texto':'textos'}`);if(card.related_photos.length)parts.push(`${card.related_photos.length} ${card.related_photos.length===1?'foto':'fotos'}`);return parts.length?` · ${parts.join(' y ')} adjuntos`:'';}

async function jsonFetch<T>(path:string):Promise<T>{const response=await fetch(path,{cache:'no-store'});if(!response.ok)throw new Error(`No se pudo cargar ${path.split('/').at(-1)??'la bandeja'}.`);return response.json() as Promise<T>;}

function PhotoTradeDraft({photo,accounts,positions,onSaved}:{photo:PhotoEvidence;accounts:Account[];positions:Position[];onSaved:()=>Promise<void>}){
 const fields=photo.ocr_trade_interpretation?.fields;
 const[accountId,setAccountId]=useState(''),[side,setSide]=useState(fields?.side??''),[ticker,setTicker]=useState(fields?.instrument_code??''),[quantity,setQuantity]=useState(fields?.quantity??''),[price,setPrice]=useState(fields?.unit_price??''),[currency,setCurrency]=useState(fields?.currency??'BRL'),[tradeDate,setTradeDate]=useState(fields?.trade_date??''),[executed,setExecuted]=useState(false),[saving,setSaving]=useState(false),[error,setError]=useState('');
 const choices=accounts.filter(account=>account.owner===photo.owner&&account.identity_status==='known');
 const institution=(id:string)=>positions.find(position=>position.owner===photo.owner&&position.account_id===id)?.institution;
 async function submit(event:FormEvent){
  event.preventDefault();setError('');
  if(!executed){setError('Confirma primero que la orden fue ejecutada. La captura solo muestra la solicitud.');return;}
  const account=choices.find(item=>item.id===accountId);
  if(!account){setError('Elige una cuenta de custodia conocida.');return;}
  setSaving(true);
  try{
   const response=await fetch('/api/shadow/proposals',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID().replaceAll('-','_')},body:JSON.stringify({owner_id:account.owner_id,account_id:account.id,side,instrument_code:ticker.trim().toUpperCase(),quantity,unit_price:price,currency,effective_date:tradeDate,fees_minor:'0',source_evidence:{kind:'manual_photo',id:photo.upload_id}})});
   const result=await response.json() as {code?:string};if(!response.ok)throw new Error(result.code??'No se pudo guardar la propuesta.');
   await onSaved();
  }catch(problem){setError(problem instanceof Error?problem.message:'No se pudo guardar la propuesta.');}finally{setSaving(false);}
 }
 return <form className="review-photo-draft" onSubmit={event=>void submit(event)}>
  <strong>Datos extraídos para comprobar</strong><p>La captura muestra una orden solicitada. Confirma la ejecución antes de preparar el movimiento; la cartera solo cambia tras la aprobación en Revisiones.</p>
  <div className="review-photo-draft-grid"><label>Titular<input value={photo.owner} readOnly /></label><label>Cuenta de custodia<select value={accountId} onChange={event=>setAccountId(event.target.value)} required><option value="">Elegir cuenta</option>{choices.map(item=><option key={item.id} value={item.id}>{institution(item.id)??item.account_scope}</option>)}</select></label><label>Operación<select value={side} onChange={event=>setSide(event.target.value)} required><option value="">Elegir</option><option value="buy">Compra</option><option value="sell">Venta</option></select></label><label>Ticker<input value={ticker} onChange={event=>setTicker(event.target.value)} required /></label><label>Cantidad<input type="number" min="0.00000001" step="any" value={quantity} onChange={event=>setQuantity(event.target.value)} required /></label><label>Precio unitario<input type="number" min="0.00000001" step="any" value={price} onChange={event=>setPrice(event.target.value)} required /></label><label>Moneda<select value={currency} onChange={event=>setCurrency(event.target.value)} required><option>BRL</option><option>USD</option></select></label><label>Fecha de operación<input type="date" value={tradeDate} onChange={event=>setTradeDate(event.target.value)} required /></label></div>
  <label className="review-photo-executed"><input type="checkbox" checked={executed} onChange={event=>setExecuted(event.target.checked)}/> Confirmo que la orden fue ejecutada, no solo solicitada</label><small>Comisiones no informadas: 0 centavos provisionales. Verifica el comprobante antes de aprobar.</small>
  {error&&<p className="chat-error" role="alert">{error}</p>}<div className="review-inbox-final"><button type="submit" className="proposal-approve" disabled={saving||!executed}>{saving?'Guardando…':'Guardar propuesta pendiente'}</button></div>
 </form>;
}

export default function ReviewInbox(){
 const[data,setData]=useState<InboxData|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[notice,setNotice]=useState(''),[saving,setSaving]=useState('');
 const[owner,setOwner]=useState('Todos'),[kind,setKind]=useState('Todos'),[custody,setCustody]=useState('Todas'),[lane,setLane]=useState<ReviewLane|'all'>('decision'),[search,setSearch]=useState('');
 const[choices,setChoices]=useState<Record<string,string>>({}),[notes,setNotes]=useState<Record<string,string>>({});
 const load=useCallback(async()=>{
  const results=await Promise.allSettled([
   jsonFetch<{proposals:Proposal[]}>('/api/shadow/proposals'),jsonFetch<{items:Confirmation[]}>('/api/shadow/confirmations'),
   jsonFetch<{items:TextEvidence[]}>('/api/shadow/evidence/text'),jsonFetch<{items:PhotoEvidence[]}>('/api/shadow/evidence/photos'),
   jsonFetch<{snapshots:Snapshot[]}>('/api/shadow/reconciliation/b3/snapshots'),jsonFetch<{snapshots:Snapshot[]}>('/api/shadow/reconciliation/external/snapshots'),
   jsonFetch<{facts_revision:string|number;effective_as_of?:string;positions:Position[]}>('/api/shadow/portfolio'),jsonFetch<{accounts:Account[]}>('/api/shadow/accounts')
  ]);
  const names=['movimientos','confirmaciones','textos','fotos','extractos B3','extractos externos','cartera','cuentas'];
  const failed=results.flatMap((result,index)=>result.status==='rejected'?[names[index]]:[]);
  if(failed.length===results.length)throw new Error('No se pudo cargar ninguna fuente de Revisiones.');
  const take=<T,>(index:number,fallback:T):T=>results[index].status==='fulfilled'?(results[index] as PromiseFulfilledResult<T>).value:fallback;
  const proposals=take(0,{proposals:[] as Proposal[]}),confirmations=take(1,{items:[] as Confirmation[]}),texts=take(2,{items:[] as TextEvidence[]}),photos=take(3,{items:[] as PhotoEvidence[]}),b3=take(4,{snapshots:[] as Snapshot[]}),external=take(5,{snapshots:[] as Snapshot[]}),portfolio=take(6,{facts_revision:'',positions:[] as Position[],effective_as_of:null as string|null}),accounts=take(7,{accounts:[] as Account[]});
  setData({cards:buildReviewCards({proposals:proposals.proposals??[],confirmations:confirmations.items??[],texts:texts.items??[],photos:photos.items??[],b3:b3.snapshots??[],external:external.snapshots??[],positions:portfolio.positions??[]}),factsRevision:String(portfolio.facts_revision??''),portfolioDate:portfolio.effective_as_of??null,accounts:accounts.accounts??[],positions:portfolio.positions??[]});
  if(failed.length)setError(`Carga parcial: faltan ${failed.join(', ')}. Actualiza la bandeja para volver a intentarlo.`);
 },[]);
 const refresh=useCallback(async()=>{setLoading(true);setError('');try{await load();}catch(problem){setError(problem instanceof Error?problem.message:'No se pudo cargar Revisiones.');}finally{setLoading(false);}},[load]);
 useEffect(()=>{const timer=window.setTimeout(()=>void refresh(),0);const updated=()=>void refresh();window.addEventListener('shadow-evidence-updated',updated);window.addEventListener('confirmations-updated',updated);window.addEventListener('shadow-portfolio-updated',updated);return()=>{window.clearTimeout(timer);window.removeEventListener('shadow-evidence-updated',updated);window.removeEventListener('confirmations-updated',updated);window.removeEventListener('shadow-portfolio-updated',updated);};},[refresh]);
 const cards=data?.cards??EMPTY_CARDS;
 const owners=useMemo(()=>[...new Set(cards.map(card=>card.owner))].sort(),[cards]);
 const custodians=useMemo(()=>[...new Set(cards.map(card=>card.custodian).filter(Boolean))].sort(),[cards]);
 const filtered=useMemo(()=>cards.filter(card=>{
  if(lane!=='all'&&card.lane!==lane||owner!=='Todos'&&card.owner!==owner||kind!=='Todos'&&card.kind!==kind||custody!=='Todas'&&card.custodian!==custody)return false;
  const query=search.trim().toLocaleLowerCase();return !query||[card.title,card.owner,card.source,card.custodian,card.kind==='proposal'?(card.data as Proposal).instrument_code:'',card.kind==='proposal'?(card.data as Proposal).account_scope:''].join(' ').toLocaleLowerCase().includes(query);
 }),[cards,lane,owner,kind,custody,search]);
 const counts={decision:cards.filter(card=>card.lane==='decision').length,evidence:cards.filter(card=>card.lane==='evidence').length,history:cards.filter(card=>card.lane==='history').length};

 async function decideProposal(proposal:Proposal,action:'approve'|'reject'){
  if(!data?.factsRevision){setError('Falta la revisión vigente de la cartera. Actualiza la bandeja.');return;}
  const verb=action==='approve'?'Aprobar y aplicar':'Rechazar';
  if(!window.confirm(`${verb} ${proposal.side==='buy'?'la compra':'la venta'} de ${proposal.quantity} ${proposal.instrument_code} de ${proposal.owner} en la cuenta indicada?`))return;
  setSaving(`proposal:${proposal.id}`);setError('');setNotice('');
  try{const response=await fetch(`/api/shadow/proposals/${proposal.id}/${action}`,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':`review_${action}_${proposal.id.replaceAll('-','')}_${proposal.version}`},body:JSON.stringify({version:proposal.version,summary_hash:proposal.summary_hash,expected_facts_revision:data.factsRevision})});
   const body=await response.json() as {code?:string};if(!response.ok)throw new Error(codeMessage[body.code??'']??body.code??'No se pudo registrar la decisión.');
   setNotice(action==='approve'?'Movimiento aprobado y aplicado a la cartera.':'Propuesta rechazada.');await load();window.dispatchEvent(new Event('portfolio-data-updated'));
  }catch(problem){setError(problem instanceof Error?problem.message:'No se pudo registrar la decisión.');}finally{setSaving('');}
 }
 async function decideConfirmation(item:Confirmation){
  const action_key=choices[item.id]??item.decision?.action_key;if(!action_key){setError('Elige una respuesta para esta confirmación.');return;}
  setSaving(`confirmation:${item.id}`);setError('');setNotice('');
  try{const response=await fetch(`/api/shadow/confirmations/${encodeURIComponent(item.id)}/decisions`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action_key,note:notes[item.id]??''})});
   const body=await response.json() as {code?:string;detail?:string};if(!response.ok)throw new Error(codeMessage[body.code??'']??body.detail??body.code??'No se pudo registrar la respuesta.');
   setNotice('Respuesta registrada.');await load();
  }catch(problem){setError(problem instanceof Error?problem.message:'No se pudo registrar la respuesta.');}finally{setSaving('');}
 }
 async function publish(snapshot:Snapshot,kind:ReviewKind){
  if(snapshot.rows===0||snapshot.invalid_rows>0){setError('El extracto tiene filas incompletas. Revisa sus datos antes de publicar.');return;}
  const source=kind==='b3_snapshot'?'B3':snapshot.source_system??'externo';
  if(!window.confirm(`Publicar las ${snapshot.rows} posiciones del extracto ${source} de ${snapshot.owner}, con fecha ${snapshot.effective_as_of}? Esta acción actualiza la cartera invertida.`))return;
  setSaving(`${kind}:${snapshot.document_id}`);setError('');setNotice('');
  try{const route=kind==='b3_snapshot'?'b3':'external';const response=await fetch(`/api/shadow/reconciliation/${route}/snapshots/${encodeURIComponent(snapshot.document_id)}/publish`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({request_key:`review-publish-${snapshot.document_id.replaceAll('-','')}`,content_sha256:snapshot.content_sha256})});
   const body=await response.json() as {code?:string};if(!response.ok)throw new Error(codeMessage[body.code??'']??body.code??'No se pudo publicar el extracto.');
   setNotice('Extracto publicado.');await load();window.dispatchEvent(new Event('portfolio-data-updated'));
  }catch(problem){setError(problem instanceof Error?problem.message:'No se pudo publicar el extracto.');}finally{setSaving('');}
 }
 function renderDetails(card:ReviewCard){
  if(card.kind==='proposal'){
   const proposal=card.data as Proposal;
   return <><p><strong>Cuenta:</strong> {card.custodian} · {proposal.currency}</p><p><strong>Operación:</strong> {proposal.side==='buy'?'Compra':'Venta'} de {proposal.quantity} {proposal.instrument_code} a {money(proposal.unit_price,proposal.currency)} por unidad. Comisiones: {proposal.fees_minor} centavos.</p>
    <p><strong>Evidencia principal:</strong> {proposal.source_evidence_kind==='manual_photo'&&proposal.source_evidence_id?<a href={`/api/shadow/evidence/photos/${proposal.source_evidence_id}/content`} target="_blank" rel="noreferrer">Abrir foto original</a>:proposal.source_evidence_text??'Registro histórico'}</p>
    {card.related_photos.map(photo=><details key={photo.upload_id}><summary>Ver foto adjunta</summary><img className="review-inbox-photo" src={`/api/shadow/evidence/photos/${photo.upload_id}/content`} alt={`Comprobante de ${photo.owner}`} loading="lazy" /></details>)}
    {card.related_texts.map(item=><blockquote key={item.id}>{item.original_text}<small>Texto relacionado por los datos de la operación; comprueba que describe este mismo movimiento.</small></blockquote>)}
    {card.status==='pending'&&<div className="review-inbox-final"><button type="button" className="proposal-reject" disabled={!!saving} onClick={()=>void decideProposal(proposal,'reject')}>Rechazar</button><button type="button" className="proposal-approve" disabled={!!saving} onClick={()=>void decideProposal(proposal,'approve')}>{saving===card.id?'Guardando…':'Aprobar y aplicar'}</button></div>}
   </>;
  }
  if(card.kind==='confirmation'){
   const item=card.data as Confirmation;
   return <><p>{Object.entries(item.context??{}).map(([key,value])=>`${key.replaceAll('_',' ')}: ${String(value)}`).join(' · ')}</p>{!!item.evidence?.length&&<details><summary>Evidencia consultada ({item.evidence.length})</summary><ul>{item.evidence.map((entry,index)=><li key={index}>{entry}</li>)}</ul></details>}
    {item.status==='resolved'?<p>Respuesta: {item.actions.find(action=>action.key===item.decision?.action_key)?.label??item.decision?.action_key}{item.decision?.note?` · ${item.decision.note}`:''}</p>:<><fieldset><legend>Elige una respuesta</legend>{item.actions.map(action=><label key={action.key}><input type="radio" name={`review-${item.id}`} checked={(choices[item.id]??item.decision?.action_key)===action.key} onChange={()=>setChoices(current=>({...current,[item.id]:action.key}))}/><span><strong>{action.label}</strong>{action.description&&<small>{action.description}</small>}</span></label>)}</fieldset><label className="review-inbox-note">Nota opcional<textarea rows={2} maxLength={1000} value={notes[item.id]??''} onChange={event=>setNotes(current=>({...current,[item.id]:event.target.value}))}/></label><div className="review-inbox-final"><button type="button" className="proposal-approve" disabled={!!saving||!(choices[item.id]??item.decision?.action_key)} onClick={()=>void decideConfirmation(item)}>{saving===card.id?'Guardando…':'Registrar respuesta'}</button></div></>}
   </>;
  }
  if(card.kind==='b3_snapshot'||card.kind==='external_snapshot'){
   const snapshot=card.data as Snapshot;
   return <><p><strong>Archivo:</strong> {snapshot.original_name}</p><p>{snapshot.rows} posiciones · {snapshot.invalid_rows} filas incompletas{snapshot.account_pending!==undefined?` · ${snapshot.account_pending} cuentas sin referencia explícita`:''}</p><p>La fecha del extracto se conserva en las posiciones. La cartera vigente puede tener una fecha posterior.</p>{!snapshot.published&&<div className="review-inbox-final"><button type="button" className="proposal-approve" disabled={!!saving||snapshot.rows===0||snapshot.invalid_rows>0} onClick={()=>void publish(snapshot,card.kind)}>{saving===card.id?'Publicando…':'Aprobar y publicar'}</button></div>}</>;
  }
  if(card.kind==='text'){
   const item=card.data as TextEvidence;return <><blockquote>{item.original_text}</blockquote>{item.fields&&<p>Lectura sugerida: {item.fields.side??'operación pendiente'} · {item.fields.instrument_code??'activo pendiente'} · {item.fields.quantity??'cantidad pendiente'} · {item.fields.unit_price&&item.fields.currency?`${item.fields.currency} ${item.fields.unit_price}`:'precio pendiente'}</p>}{!!item.review_reasons?.length&&<p>Falta revisar: {item.review_reasons.join(', ')}</p>}<div className="review-inbox-final"><button type="button" className="proposal-approve" onClick={()=>window.dispatchEvent(new CustomEvent('juanca-action',{detail:{type:'prepare_transaction',message:item.original_text,owner:item.owner}}))}>Preparar movimiento</button></div></>;
  }
  const photo=card.data as PhotoEvidence;return <><p>{photo.ocr_status==='completed'?'Texto reconocido disponible para comprobar contra la imagen.':'La foto está guardada; la lectura automática puede estar pendiente.'}</p><a href={`/api/shadow/evidence/photos/${photo.upload_id}/content`} target="_blank" rel="noreferrer">Abrir foto original</a>{photo.ocr_text&&<details><summary>Ver texto reconocido</summary><pre>{photo.ocr_text}</pre></details>}{photo.ocr_trade_interpretation?.fields?<PhotoTradeDraft key={photo.upload_id} photo={photo} accounts={data?.accounts??[]} positions={data?.positions??[]} onSaved={async()=>{setNotice('Propuesta pendiente guardada. Revísala antes de aprobar.');await load();}}/>:<p>La lectura estructurada está pendiente. Actualiza esta bandeja en unos momentos.</p>}</>;
 }
 return <section className="panel review-inbox" aria-label="Bandeja de revisiones">
  <div className="panel-title"><div><p>Patrimonio familiar</p><h2>Revisiones pendientes</h2><span>Decisiones y evidencia reunidas por caso.</span></div><button type="button" className="text-button" disabled={loading} onClick={()=>void refresh()}>Actualizar</button></div>
  <nav className="review-inbox-lanes" aria-label="Estado de revisiones">{([['decision','Para decidir',counts.decision],['evidence','Faltan datos',counts.evidence],['history','Historial',counts.history]] as const).map(([value,label,count])=><button type="button" key={value} className={lane===value?'active':''} aria-current={lane===value?'page':undefined} onClick={()=>setLane(value)}>{label} <strong>{count}</strong></button>)}</nav>
  <div className="review-inbox-filters"><label>Buscar<input type="search" placeholder="Ticker, cuenta o asunto" value={search} onChange={event=>setSearch(event.target.value)}/></label><label>Titular<select value={owner} onChange={event=>setOwner(event.target.value)}><option>Todos</option>{owners.map(value=><option key={value}>{value}</option>)}</select></label><label>Tipo<select value={kind} onChange={event=>setKind(event.target.value)}><option>Todos</option>{(Object.entries(kindLabel) as [ReviewKind,string][]).map(([value,label])=><option value={value} key={value}>{label}</option>)}</select></label><label>Custodia<select value={custody} onChange={event=>setCustody(event.target.value)}><option>Todas</option>{custodians.map(value=><option key={value}>{value}</option>)}</select></label></div>
  {error&&<p className="chat-error" role="alert">{error}</p>}{notice&&<p className="form-status" role="status">{notice}</p>}
  {loading&&!data&&<p>Cargando revisiones…</p>}{!loading&&data&&filtered.length===0&&<p className="review-inbox-empty">No hay casos para estos filtros.</p>}
  <div className="review-inbox-list">{filtered.map(card=><article className="review-inbox-card" key={card.id}><div className="review-inbox-main"><div><span className="review-inbox-type">{kindLabel[card.kind]} · {card.owner}</span><h3>{card.title}</h3><p>{card.custodian&&`${card.custodian} · `}{card.event_date?`${card.kind==='b3_snapshot'||card.kind==='external_snapshot'?'Corte':'Operación'}: ${date(card.event_date)} · `:''}Recibido: {date(card.received_at)}</p><small>{statusLabel[card.status]??card.status}{ageLabel(card.received_at,card.lane)}{relatedLabel(card)}</small></div></div><details><summary>{card.lane==='history'?'Ver detalle':card.kind==='proposal'?'Revisar movimiento':card.kind==='confirmation'?'Responder duda':card.kind==='b3_snapshot'||card.kind==='external_snapshot'?'Revisar extracto':'Revisar evidencia'}</summary><div className="review-inbox-detail">{renderDetails(card)}</div></details></article>)}</div>
 </section>;
}
