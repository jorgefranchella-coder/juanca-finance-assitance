import { env } from 'cloudflare:workers';
import { fileSha256 } from '@/lib/import-storage';
import { authenticatedUserId } from '@/lib/reviews';
import { loadPortfolioView } from '@/lib/portfolio-storage';
import { applicationStatements } from '@/lib/proposal-application';

export const dynamic = 'force-dynamic';
type Proposal = {
  id: string; message_id: string; source_message_id: string | null; owner: string; side: 'buy' | 'sell';
  instrument_code: string; quantity: number; unit_price: number; currency: 'BRL' | 'USD';
  trade_date: string; fees_minor: number; source: string; status: string;
  object_key: string | null; attachment_name: string | null; applied_import_id: string | null;
};
const conflict = (code: string, detail: string) => Response.json({ code, detail },{status:409});
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const userId = authenticatedUserId(request);
  if (!userId) return Response.json({ detail:'Autenticação necessária.' },{status:401});
  const { id } = await context.params;
  const body = await request.json().catch(()=>({})) as { action?: string; expected_revision?: number; allow_similar?: boolean };
  if (!['approve','reject'].includes(String(body.action))) return Response.json({ detail:'Ação inválida.' },{status:400});
  const proposal = await env.DB.prepare(`SELECT p.*,m.object_key,m.attachment_name
    FROM transaction_proposals p LEFT JOIN chat_messages m ON m.id=p.source_message_id
      AND m.user_id=p.user_id AND m.role='user' WHERE p.id=? AND p.user_id=?`)
    .bind(id,userId).first<Proposal>();
  if (!proposal) return Response.json({ detail:'Proposta não encontrada.' },{status:404});
  if (proposal.status==='applied' && body.action==='approve') return Response.json({status:'applied',import_id:proposal.applied_import_id,replayed:true});
  if (proposal.status==='rejected' && body.action==='reject') return Response.json({status:'rejected',replayed:true});
  if (proposal.status!=='pending') return conflict('ALREADY_REVIEWED','Esta proposta já foi revisada.');
  if (body.action==='reject') {
    const result = await env.DB.prepare(`UPDATE transaction_proposals SET status='rejected',updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND user_id=? AND status='pending'`).bind(id,userId).run();
    return result.meta.changes ? Response.json({status:'rejected'}) : conflict('ALREADY_REVIEWED','A proposta mudou enquanto você revisava. Atualize a conversa.');
  }
  const view = await loadPortfolioView(userId);
  if (body.expected_revision!==undefined && body.expected_revision!==view.facts_revision) return conflict('STALE_PORTFOLIO','A carteira mudou. Atualize e confira o ajuste antes de aprovar.');
  const matching = view.positions.filter(p=>p.owner===proposal.owner && p.currency===proposal.currency && p.instrument_code===proposal.instrument_code);
  if (matching.length>1 || view.issues.some(i=>(!i.owner || i.owner===proposal.owner) && (!i.instrument_code || i.instrument_code===proposal.instrument_code) && i.code!=='missing_fx')) return conflict('RECONCILIATION_REQUIRED','Esta posição precisa de conciliação antes de receber outro ajuste.');
  if (matching[0] && proposal.trade_date<=matching[0].base_reference_date) return conflict('SNAPSHOT_CUTOFF','A operação é anterior ou coincide com a posição-base. Concilie a data de corte antes de aplicar.');
  if (proposal.side==='sell' && (!matching[0] || matching[0].quantity+0.000001<proposal.quantity)) return conflict('INSUFFICIENT_POSITION','Não há quantidade conhecida suficiente para aplicar esta venda. Concilie a posição primeiro.');
  if (proposal.currency==='USD' && !view.positions.some(p=>p.owner===proposal.owner && p.currency==='USD')) return conflict('MISSING_BASE','Importe ou concilie a posição-base em USD antes de aplicar esta operação.');
  const trades = await env.DB.prepare(`SELECT r.payload FROM import_records r JOIN imports i ON i.id=r.import_id
    WHERE i.user_id=? AND i.status='processed' AND r.record_kind='trade'`).bind(userId).all<{payload:string}>();
  const similar = trades.results.some(row=>{
    try {
      const t=JSON.parse(row.payload);
      return t.owner===proposal.owner && t.side===proposal.side && t.instrument_code===proposal.instrument_code && t.trade_date===proposal.trade_date
        && Math.abs(Number(t.quantity)-proposal.quantity)<0.000001 && Math.abs(Number(t.unit_price)-proposal.unit_price)<0.000001;
    } catch {return false;}
  });
  if (similar && body.allow_similar!==true) return conflict('POSSIBLE_DUPLICATE','Existe uma operação semelhante. Confirme que esta é uma operação distinta antes de aplicar.');
  const importId=crypto.randomUUID();
  const payload={kind:'trade',source:'transaction_chat',proposal_id:id,owner:proposal.owner,account:null,
    side:proposal.side,trade_date:proposal.trade_date,settlement_date:null,instrument_code:proposal.instrument_code,
    product_name:proposal.instrument_code,quantity:Number(proposal.quantity),unit_price:Number(proposal.unit_price),
    principal_minor:Math.round(proposal.quantity*proposal.unit_price*100),fees_minor:Number(proposal.fees_minor),currency:proposal.currency,
    asset_class:proposal.currency==='USD'?'international_equity':'equity',institution:proposal.currency==='USD'?'Avenue':'Informado no chat'};
  const encoded=JSON.stringify(payload);
  const digest=await fileSha256(new TextEncoder().encode(encoded).buffer);
  const statements=applicationStatements({proposalId:id,userId,importId,expectedRevision:view.facts_revision,
    owner:proposal.owner,fileName:proposal.attachment_name??'mensagem-no-chat.txt',digest,tradeDate:proposal.trade_date,
    objectKey:proposal.object_key??`chat://${proposal.source_message_id??proposal.message_id}`,side:proposal.side,payload:encoded});
  const result=await env.DB.batch(statements.map(s=>env.DB.prepare(s.sql).bind(...s.values)));
  if (!result[0].meta.changes) {
    const current=await env.DB.prepare('SELECT status,applied_import_id FROM transaction_proposals WHERE id=? AND user_id=?').bind(id,userId).first<{status:string;applied_import_id:string|null}>();
    if (current?.status==='applied') return Response.json({status:'applied',import_id:current.applied_import_id,replayed:true});
    return conflict('STALE_PORTFOLIO','A carteira ou proposta mudou durante a aprovação. Atualize e confira o ajuste.');
  }
  return Response.json({status:'applied',import_id:importId});
}
