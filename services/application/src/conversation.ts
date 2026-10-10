import {randomUUID} from 'node:crypto';
import type pg from 'pg';
import {D,minor} from './money.ts';
import {hash} from './migration.ts';
import {portfolio} from './queries.ts';
import {Conflict} from './commands.ts';

export type ChatInput={request_id:string;message:string;owner:'family'|'Jorge'|'Julia'};
type ChatMessage={id:string;role:'user'|'assistant';content:string;origin:string;created_at:string;actions?:{type:string;message?:string;owner?:string}[];evidence?:Record<string,unknown>};
const householdConversation='family';
export function validateChatInput(value:unknown):ChatInput {
 if(!value||typeof value!=='object')throw new Conflict('VALIDATION',422);
 const v=value as Record<string,unknown>;
 if(typeof v.request_id!=='string'||!/^[A-Za-z0-9_-]{8,100}$/.test(v.request_id)||typeof v.message!=='string'||!v.message.trim()||v.message.length>8000||!['family','Jorge','Julia'].includes(String(v.owner)))throw new Conflict('VALIDATION',422);
 return {request_id:v.request_id,message:v.message.trim(),owner:v.owner as ChatInput['owner']};
}
function normalized(text:string){return text.toLocaleLowerCase('pt-BR').normalize('NFD').replace(/[\u0300-\u036f]/g,'');}
export function classify(message:string){
 const text=normalized(message);
 if(/\b(aprobar|aprova[rr]?|approve|rechaza[rr]?|rejeitar|excluir|borrar)\b/.test(text))return 'decision';
 if(/\b(comprei|compramos|compra|comprado|compre|vendi|vendemos|venda|vender|buy|sell)\b/.test(text))return 'transaction';
 if(/revis|pendenc|pendient|concili/.test(text))return 'reviews';
 if(/vencim|renda fixa|renta fija|projec|proyec/.test(text))return 'fixed_income';
 if(/carteira|cartera|posic|custo|costo|coste|lucro|gananc|ativos|activos|acoes|acciones|\b[a-z]{4}\d{1,2}\b/.test(text))return 'positions';
 if(/patrimonio|resumo|resumen|saldo|quanto|cuanto|que tenho|que tengo|que temos|que tenemos/.test(text))return 'dashboard';
 return 'help';
}
function displayMinor(value:string|null,currency:'BRL'|'USD'='BRL'){
 if(value===null)return 'não disponível';
 const n=new D(value).div(100);
 const decimal=n.abs().toFixed(2);
 const [whole,fraction]=decimal.split('.');
 return (currency==='USD'?'US$ ':'R$ ')+(n.isNegative()?'-':'')+whole.replace(/\B(?=(\d{3})+(?!\d))/g,'.')+','+fraction;
}
export async function answerGuided(db:pg.Pool,household:string,input:ChatInput){
 const intent=classify(input.message);const text=normalized(input.message);
 const explicit=['Jorge','Julia'].filter(name=>text.includes(name.toLowerCase()));
 const selected=explicit.length===1?explicit[0]:input.owner==='family'?null:input.owner;
 if(intent==='decision')return {content:'Abra a proposta em Transações na aplicação atual e confira os campos antes de aprovar ou descartar. Esta conversa em sombra não aplica decisões.',actions:[{type:'open_transactions'}],intent};
 if(intent==='transaction'){
  if(!selected)return {content:'Escolha Jorge ou Julia e confira a operação em Transações na aplicação atual. Esta conversa em sombra não altera a carteira.',actions:[],intent};
  return {content:`A mensagem de ${selected} foi guardada como evidência pendente nesta conversa em sombra. Confira a operação em Transações na aplicação atual; a aprovação exige revisão explícita.`,actions:[{type:'prepare_transaction',message:input.message,owner:selected}],intent};
 }
 if(intent==='help')return {content:'Posso consultar a carteira copiada para esta aplicação em sombra. Os dados podem estar desatualizados; custos e projeções continuam na aplicação atual. A interpretação livre por IA ainda não está configurada.',actions:[],intent};
 const view=await portfolio(db,household);const positions=view.positions as Array<{owner:string;instrument_code:string;quantity:string;currency:string;market_value_cents:string|null;market_value_minor:string;price_as_of:string}>;
 const evidence={portfolio_version:view.portfolio_version,effective_as_of:view.effective_as_of,known_at:view.known_at,mode:'shadow',authoritative:false};
 if(intent==='dashboard'){
  const filtered=positions.filter(p=>!selected||p.owner===selected);
  if(!filtered.length)return {content:'Não há posição importada com cobertura para este titular. Isso não demonstra ausência de patrimônio.',actions:[],intent,evidence};
  const total=minor(filtered.reduce((sum,p)=>sum.add(p.market_value_cents??'0'),new D(0)));
  const coverage=view.valuation_complete&&view.identity_complete?'Cobertura conciliada na fotografia em sombra.':'Cobertura incompleta: há identidade de conta ou operações pendentes. Este subtotal não representa um total conciliado.';
  return {content:`Subtotal valorado ${selected?'de '+selected:'da família'}: ${displayMinor(total)}.\nReferência econômica: ${view.effective_as_of}. Fotografia conhecida em: ${view.known_at}.\n${coverage}`,actions:[],intent,evidence};
 }
 if(intent==='reviews'){
  const issues=view.issues as Array<{code:string;owner?:string}>;const filtered=issues.filter(i=>!selected||i.owner===selected);
  return {content:`Pendências de conciliação nesta fotografia em sombra: ${filtered.length}. As decisões de revisão da aplicação atual não estão incluídas neste número.`,actions:[],intent,evidence};
 }
 if(intent==='fixed_income')return {content:'A projeção de renda fixa ainda não foi migrada para esta aplicação em sombra. Consulte a metodologia e os valores na aplicação atual.',actions:[],intent,evidence};
 const symbols=(input.message.match(/\b[A-Z]{2,8}\d{1,2}\b/g)??[]).filter(s=>s!=='BRL'&&s!=='USD');
 const filtered=positions.filter(p=>(!selected||p.owner===selected)&&(!symbols.length||symbols.includes(p.instrument_code)));
 if(!filtered.length)return {content:'Não encontrei posições cobertas por estes filtros nesta fotografia. Confira as importações antes de concluir que o ativo não existe.',actions:[],intent,evidence};
 const lines=filtered.slice(0,30).map(p=>`${p.owner} · ${p.instrument_code}: ${p.quantity} unidades · ${displayMinor(p.market_value_cents)}${p.currency==='USD'&&p.market_value_cents===null?' ('+displayMinor(p.market_value_minor,'USD')+' em moeda original)':''} · preço de ${p.price_as_of}`);
 const costWarning=/custo|costo|coste|lucro|gananc/.test(text)?'\nCustos e ganho não realizado ainda não foram migrados; consulte a aplicação atual.':'';
 return {content:lines.join('\n')+(filtered.length>30?'\nMostrando 30 posições de '+filtered.length+'.':'')+costWarning+'\nFotografia em sombra, com identidade de conta ainda em conciliação.',actions:[],intent,evidence};
}
export async function chatHistory(db:pg.Pool,household:string):Promise<ChatMessage[]>{
 const [recent,archive]=await Promise.all([
  db.query(`SELECT id,role,content,origin,metadata,created_at FROM app.conversation_messages WHERE household_id=$1 AND conversation_id=$2 ORDER BY created_at DESC,id DESC LIMIT 200`,[household,householdConversation]),
  db.query(`SELECT id,original FROM app.conversation_archives WHERE household_id=$1 ORDER BY id LIMIT 200`,[household])
 ]);
 const rows:ChatMessage[]=recent.rows.map(r=>({id:r.id,role:r.role,content:r.content,origin:r.origin,created_at:r.created_at.toISOString(),...r.metadata}));
 for(const row of archive.rows){
  const m=JSON.parse(row.original) as Record<string,unknown>;
  if(!['user','assistant'].includes(String(m.role)))continue;
  const stamp=typeof m.created_at==='number'?m.created_at:0;
  const metadata=typeof m.metadata==='string'?JSON.parse(m.metadata):m.metadata??{};
  rows.push({id:String(m.id),role:m.role as ChatMessage['role'],content:String(m.content??''),origin:String(m.origin??'hermes_archive'),created_at:new Date(stamp*1000).toISOString(),...(metadata as object)});
 }
 return rows.sort((a,b)=>a.created_at.localeCompare(b.created_at)||a.id.localeCompare(b.id)).slice(-200);
}
export async function sendChat(db:pg.Pool,household:string,raw:unknown){
 const input=validateChatInput(raw);const digest=hash(JSON.stringify([input.message,input.owner]));const lease=randomUUID();
 const c=await db.connect();let replay=false;
 try{
  await c.query('BEGIN');
  await c.query('INSERT INTO app.conversations(household_id,id) VALUES($1,$2) ON CONFLICT DO NOTHING',[household,householdConversation]);
  await c.query('SELECT id FROM app.conversations WHERE household_id=$1 AND id=$2 FOR UPDATE',[household,householdConversation]);
  const previous=await c.query('SELECT request_hash,status FROM app.conversation_requests WHERE household_id=$1 AND id=$2 FOR UPDATE',[household,input.request_id]);
  if(previous.rowCount){
   if(previous.rows[0].request_hash!==digest)throw new Conflict('IDEMPOTENCY_MISMATCH');
   if(previous.rows[0].status==='done'){replay=true;await c.query('COMMIT');return {messages:await chatHistory(db,household),mode:'guided_shadow',hermes_required:false,replayed:true};}
  }
  await c.query("UPDATE app.conversation_requests SET status='failed' WHERE household_id=$1 AND status='processing' AND started_at<now()-interval '60 seconds'",[household]);
  const busy=await c.query("SELECT 1 FROM app.conversation_requests WHERE household_id=$1 AND status='processing'",[household]);if(busy.rowCount)throw new Conflict('BUSY');
  await c.query(`INSERT INTO app.conversation_requests(household_id,id,conversation_id,request_hash,status,lease_token) VALUES($1,$2,$3,$4,'processing',$5)
    ON CONFLICT(household_id,id) DO UPDATE SET status='processing',lease_token=EXCLUDED.lease_token,started_at=now()`,[household,input.request_id,householdConversation,digest,lease]);
  await c.query(`INSERT INTO app.conversation_messages(household_id,id,conversation_id,role,content) VALUES($1,$2,$3,'user',$4) ON CONFLICT DO NOTHING`,[household,household+':'+input.request_id+':user',householdConversation,input.message]);
  if(classify(input.message)==='transaction'){
   const text=normalized(input.message),explicit=['Jorge','Julia'].filter(name=>text.includes(name.toLowerCase()));const selected=explicit.length===1?explicit[0]:input.owner==='family'?null:input.owner;
   if(selected){const owner=await c.query('SELECT id FROM app.owners WHERE household_id=$1 AND display_name=$2',[household,selected]);if(owner.rowCount){const ownerId=String(owner.rows[0].id),key='chat:'+input.request_id,requestHash=hash(JSON.stringify([ownerId,input.message,null]));await c.query(`INSERT INTO app.manual_intakes(household_id,id,request_key,request_hash,owner_id,original_text) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(household_id,request_key) DO NOTHING`,[household,randomUUID(),key,requestHash,ownerId,input.message]);}}
  }
  await c.query('COMMIT');
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 try{
  const result=await answerGuided(db,household,input);
  const done=await db.connect();
  try{
   await done.query('BEGIN');
   const changed=await done.query("UPDATE app.conversation_requests SET status='done',result=$4 WHERE household_id=$1 AND id=$2 AND status='processing' AND lease_token=$3 RETURNING id",[household,input.request_id,lease,result]);
   if(!changed.rowCount)throw new Conflict('LEASE_EXPIRED');
   const {content,...metadata}=result;
   await done.query(`INSERT INTO app.conversation_messages(household_id,id,conversation_id,role,content,metadata) VALUES($1,$2,$3,'assistant',$4,$5)`,[household,household+':'+input.request_id+':assistant',householdConversation,content,metadata]);
   await done.query('COMMIT');
  }catch(e){await done.query('ROLLBACK');throw e;}finally{done.release();}
  return {messages:await chatHistory(db,household),mode:'guided_shadow',hermes_required:false,replayed:false};
 }catch(e){await db.query("UPDATE app.conversation_requests SET status='failed' WHERE household_id=$1 AND id=$2 AND status='processing' AND lease_token=$3",[household,input.request_id,lease]);throw e;}
}
