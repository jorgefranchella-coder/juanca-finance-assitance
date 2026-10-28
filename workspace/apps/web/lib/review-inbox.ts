export type ReviewKind = "proposal" | "confirmation" | "b3_snapshot" | "external_snapshot" | "text" | "photo";
export type ReviewLane = "decision" | "evidence" | "history";
export type Proposal = { id:string; owner:string; owner_id:string; account_id:string; account_scope:string; instrument_code:string; currency:string; side:"buy"|"sell"; quantity:string; unit_price:string; fees_minor:string; effective_date:string; version:number; summary_hash:string; status:string; source_evidence_kind?:string|null; source_evidence_id?:string|null; source_evidence_text?:string|null; source_evidence_received_at?:string|null };
export type Confirmation = { id:string; owner:string; category:string; title:string; context:Record<string,unknown>; evidence:string[]; actions:Array<{key:string;label:string;description?:string;keeps_open?:boolean}>; status:"open"|"resolved"; created_at:string; updated_at:string; decision?:{action_key:string;note:string|null;decided_at:string|null}|null };
export type TextEvidence = { id:string; owner:string; original_text:string; occurred_on:string|null; received_at:string; status:string; interpretation_status?:string|null; fields?:{side?:string|null;instrument_code?:string|null;quantity?:string|null;trade_date?:string|null;unit_price?:string|null;currency?:string|null}|null; review_reasons?:string[]|null };
export type PhotoEvidence = { upload_id:string; owner_id?:string; owner:string; file_name:string; created_at:string; status:string; proposal_evidence_status:string; ocr_status?:string|null; ocr_text?:string|null; ocr_trade_interpretation?:{status?:string;fields?:TextEvidence["fields"];review_reasons?:string[]}|null };
export type Snapshot = { document_id:string; owner:string; source_system?:string; original_name:string; content_sha256:string; effective_as_of:string; registered_at?:string|null; rows:number; invalid_rows:number; account_pending?:number; published:boolean; latest:boolean; status?:string };
export type Position = { owner:string; account_id:string; institution:string; instrument_code:string; currency:string; base_reference_date?:string };
export type ReviewCard = { id:string; kind:ReviewKind; lane:ReviewLane; owner:string; title:string; source:string; custodian:string; account_id:string|null; event_date:string|null; received_at:string; status:string; related_texts:TextEvidence[]; related_photos:PhotoEvidence[]; data:Proposal|Confirmation|TextEvidence|PhotoEvidence|Snapshot };
export type ReviewInput = { proposals:Proposal[]; confirmations:Confirmation[]; texts:TextEvidence[]; photos:PhotoEvidence[]; b3:Snapshot[]; external:Snapshot[]; positions:Position[] };

function signature(owner:string,side:unknown,ticker:unknown,quantity:unknown,date:unknown){
 if(!owner||!side||!ticker||!quantity||!date)return null;
 return [owner,String(side).toLowerCase(),String(ticker).toUpperCase(),String(quantity),String(date).slice(0,10)].join("|");
}
function accountHint(scope:string){
 try{const part=JSON.parse(scope)?.[1];if(typeof part==='string'&&part.startsWith('account:'))return part.slice(8);}
 catch{/* The source may be a legacy plain label. */}
 return null;
}
function confirmationCustody(context:Record<string,unknown>){for(const key of ['custodian','custody','institution','institucion','instituicao','cuenta','account']){const value=context[key];if(typeof value==='string'&&value.trim())return value.trim();}return '';}
export function custodyLabel(proposal:Proposal,positions:Position[],sameInstitutionCount=1){
 const institution=positions.find(position=>position.owner===proposal.owner&&position.account_id===proposal.account_id)?.institution?.trim();
 const hint=accountHint(proposal.account_scope);
 if(institution)return sameInstitutionCount>1?`${institution} · ${hint?`cuenta …${hint.slice(-4)}`:`ref. interna ${proposal.account_id.slice(-4)}`}`:institution;
 return hint?`Cuenta …${hint.slice(-4)}`:`Cuenta identificada · ref. interna ${proposal.account_id.slice(-4)}`;
}
export function buildReviewCards(input:ReviewInput):ReviewCard[]{
 const cards:ReviewCard[]=[];
 const proposalSignatures=new Map<string,Proposal[]>();
 for(const proposal of input.proposals){const key=signature(proposal.owner,proposal.side,proposal.instrument_code,proposal.quantity,proposal.effective_date);if(key)proposalSignatures.set(key,[...(proposalSignatures.get(key)??[]),proposal]);}
 const textByProposal=new Map<string,TextEvidence[]>(),assignedTexts=new Set<string>();
 for(const item of input.texts){
  const direct=input.proposals.find(proposal=>proposal.source_evidence_kind==='manual_text'&&proposal.source_evidence_id===item.id);
  const key=signature(item.owner,item.fields?.side,item.fields?.instrument_code,item.fields?.quantity,item.fields?.trade_date);
  const candidates=key?proposalSignatures.get(key)??[]:[];
  const proposal=direct??(candidates.length===1?candidates[0]:null);
  if(proposal){textByProposal.set(proposal.id,[...(textByProposal.get(proposal.id)??[]),item]);assignedTexts.add(item.id);}
 }
 const photosByProposal=new Map<string,PhotoEvidence[]>(),assignedPhotos=new Set<string>();
 for(const photo of input.photos){const proposal=input.proposals.find(item=>item.source_evidence_kind==='manual_photo'&&item.source_evidence_id===photo.upload_id);if(proposal){photosByProposal.set(proposal.id,[...(photosByProposal.get(proposal.id)??[]),photo]);assignedPhotos.add(photo.upload_id);}}
 for(const proposal of input.proposals){
  const sameInstitutionPositions=input.positions.filter(position=>position.owner===proposal.owner&&position.account_id===proposal.account_id);
  const institution=sameInstitutionPositions[0]?.institution;
  const count=institution?new Set(input.positions.filter(position=>position.owner===proposal.owner&&position.institution===institution).map(position=>position.account_id)).size:1;
  cards.push({id:`proposal:${proposal.id}`,kind:'proposal',lane:proposal.status==='pending'?'decision':'history',owner:proposal.owner,title:`${proposal.side==='buy'?'Compra':'Venta'} de ${proposal.quantity} ${proposal.instrument_code}`,source:'Movimiento',custodian:custodyLabel(proposal,input.positions,count),account_id:proposal.account_id,event_date:proposal.effective_date,received_at:proposal.source_evidence_received_at??proposal.effective_date,status:proposal.status,related_texts:textByProposal.get(proposal.id)??[],related_photos:photosByProposal.get(proposal.id)??[],data:proposal});
 }
 for(const item of input.confirmations)cards.push({id:`confirmation:${item.id}`,kind:'confirmation',lane:item.status==='open'?'decision':'history',owner:item.owner,title:item.title,source:item.category,custodian:confirmationCustody(item.context??{}),account_id:null,event_date:null,received_at:item.created_at,status:item.status,related_texts:[],related_photos:[],data:item});
 for(const [kind,snapshots] of [['b3_snapshot',input.b3],['external_snapshot',input.external]] as const){
  for(const snapshot of snapshots){const source=kind==='b3_snapshot'?'B3':snapshot.source_system==='Avenue'?'Avenue':`Previdência · ${snapshot.source_system??'institución'}`;
   if(!snapshot.published&&!snapshot.latest)continue;
   cards.push({id:`${kind}:${snapshot.document_id}`,kind,lane:snapshot.published?'history':'decision',owner:snapshot.owner,title:`Extracto ${source} · ${snapshot.effective_as_of}`,source,custodian:source==='B3'?'':source,account_id:null,event_date:snapshot.effective_as_of,received_at:snapshot.registered_at??snapshot.effective_as_of,status:snapshot.published?'published':'pending',related_texts:[],related_photos:[],data:snapshot});
  }
 }
 for(const item of input.texts)if(!assignedTexts.has(item.id)&&item.status==='awaiting_review')cards.push({id:`text:${item.id}`,kind:'text',lane:'evidence',owner:item.owner,title:item.fields?.instrument_code&&item.fields.instrument_code!=='VENDA'?`Texto sobre ${item.fields.instrument_code}`:'Movimiento escrito por identificar',source:'Texto',custodian:'',account_id:null,event_date:item.fields?.trade_date??item.occurred_on??null,received_at:item.received_at,status:item.interpretation_status??item.status,related_texts:[],related_photos:[],data:item});
 for(const photo of input.photos)if(!assignedPhotos.has(photo.upload_id)&&photo.proposal_evidence_status==='awaiting_review')cards.push({id:`photo:${photo.upload_id}`,kind:'photo',lane:'evidence',owner:photo.owner,title:photo.ocr_trade_interpretation?.fields?.instrument_code?`Foto sobre ${photo.ocr_trade_interpretation.fields.instrument_code}`:`Foto recibida · ${photo.file_name}`,source:'Foto',custodian:'',account_id:null,event_date:photo.ocr_trade_interpretation?.fields?.trade_date??null,received_at:photo.created_at,status:photo.ocr_trade_interpretation?.status??photo.ocr_status??photo.status,related_texts:[],related_photos:[],data:photo});
 const lanes:Record<ReviewLane,number>={decision:0,evidence:1,history:2};
 return cards.sort((a,b)=>lanes[a.lane]-lanes[b.lane]||Date.parse(b.received_at)-Date.parse(a.received_at)||a.id.localeCompare(b.id));
}
