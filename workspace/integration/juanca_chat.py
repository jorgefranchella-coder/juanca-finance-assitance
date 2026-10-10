"""Application-owned guided conversation. No Hermes runtime or portfolio mutations."""
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import time
import unicodedata
import uuid
from urllib.request import Request, urlopen

VIEWS = {'dashboard': '/api/portfolio/dashboard', 'positions': '/api/portfolio/positions',
         'reviews': '/api/portfolio/summary', 'fixed_income': '/api/portfolio/fixed-income-projection'}


def normalized(text):
    return ''.join(c for c in unicodedata.normalize('NFD', text.lower()) if not unicodedata.combining(c))


def classify(text):
    value = normalized(text)
    if re.search(r'\b(aprobar|aprova[rr]?|approve|rechaza[rr]?|rejeitar|excluir|borrar)\b', value):
        return 'decision'
    if re.search(r'\b(comprei|compramos|compra|comprado|compre|compramos|vendi|vendemos|venda|vendi|vender|buy|sell)\b', value):
        return 'transaction'
    if re.search(r'revis|pendenc|pendient|concili', value):
        return 'reviews'
    if re.search(r'vencim|renda fixa|renta fija|projec|proyec', value):
        return 'fixed_income'
    if re.search(r'carteira|cartera|posic|custo|costo|coste|lucro|gananc|ativos|activos|acoes|acciones|\b[A-Za-z]{4}\d{1,2}\b', value):
        return 'positions'
    if re.search(r'patrimonio|resumo|resumen|saldo|quanto|cuanto|que tenho|que tengo|que temos|que tenemos', value):
        return 'dashboard'
    return 'help'


def money(minor, currency='BRL'):
    if minor is None:
        return 'não disponível'
    formatted = f'{float(minor) / 100:,.2f}'.replace(',', '_').replace('.', ',').replace('_', '.')
    return ('US$ ' if currency == 'USD' else 'R$ ') + formatted


def answer(message, owner, api):
    intent = classify(message)
    value = normalized(message)
    explicit = [name for name in ('Jorge', 'Julia') if name.lower() in value]
    selected = explicit[0] if len(explicit) == 1 else owner if owner in ('Jorge', 'Julia') else None
    if intent in ('decision', 'transaction'):
        if intent == 'decision':
            return {'content': 'Abra a proposta em Transações e confira os campos antes de aprovar ou descartar. Uma mensagem no chat não aplica decisões.',
                    'actions': [{'type': 'open_transactions'}], 'intent': intent}
        if not selected:
            return {'content': 'Escolha Jorge ou Julia para preparar a operação. Informe compra ou venda, ativo, quantidade, preço, moeda, data e taxas.',
                    'actions': [], 'intent': intent}
        return {'content': f'Posso levar esta descrição para as transações de {selected}. Confira os campos e envie para preparar uma proposta; a carteira só muda após aprovação.',
                'actions': [{'type': 'prepare_transaction', 'message': message, 'owner': selected}], 'intent': intent}
    if intent == 'help':
        return {'content': 'Posso consultar o resumo do patrimônio, a carteira, custos, revisões pendentes e projeções de renda fixa. Exemplos: “Qual o patrimônio da Julia?” ou “Quais revisões estão pendentes?”. Para uma operação, informe titular, ativo, quantidade, preço, moeda e data. A interpretação livre por IA ainda não está configurada.',
                'actions': [], 'intent': intent}
    data = api(VIEWS[intent])
    actions = []
    if intent == 'dashboard':
        owners = [r for r in data.get('owners', []) if not selected or r['owner'] == selected]
        if not owners:
            content = 'Não há posição importada com cobertura para este titular. Isso não demonstra ausência de patrimônio.'
        else:
            total = sum(r['value_cents'] for r in owners)
            content = f'Subtotal valorado{f" de {selected}" if selected else " da família"}: {money(total)}.'
            content += '\n' + '\n'.join(f'{r["owner"]}: {money(r["value_cents"])}' for r in owners)
            content += f'\nReferência da carteira: {data.get("reference_date") or "não disponível"}.'
            if not data.get('valuation_complete', True):
                content += '\nCobertura incompleta: há posições sem conversão ou com pendências. O subtotal não representa um total completo.'
            if data.get('sources', {}).get('ptax'):
                fx = data['sources']['ptax']
                content += f'\nUSD/BRL PTAX: {fx["rate"]:.4f}, observada em {fx["date"]}.'
    elif intent == 'positions':
        positions = [p for p in data.get('positions', []) if not selected or p['owner'] == selected]
        symbols = re.findall(r'\b[A-Z]{2,8}\d{1,2}\b|\b[A-Z]{2,6}\b', message)
        symbols = [s for s in symbols if s not in ('BRL', 'USD')]
        if symbols:
            positions = [p for p in positions if p['instrument_code'] in symbols]
        if not positions:
            content = 'Não encontrei posições cobertas por estes filtros. Consulte a carteira completa e as importações antes de concluir que não há ativos.'
        else:
            rows = []
            for p in positions[:30]:
                text = f'{p["owner"]} · {p["instrument_code"]}: {p["quantity"]:g} unidades · {money(p.get("market_value_cents"))}'
                if p.get('market_value_cents') is None and p.get('currency') == 'USD':
                    text += f' ({money(p.get("market_value_minor"), "USD")} em moeda original; conversão indisponível)'
                if re.search(r'custo|costo|coste|lucro|gananc', value):
                    text += f' · custo {money(p.get("cost_basis_cents"))} · resultado não realizado {money(p.get("unrealized_pnl_cents"))}'
                text += f' · preço de {p.get("price_as_of") or "data desconhecida"}'
                rows.append(text)
            content = '\n'.join(rows)
            if len(positions)>30:
                content += '\nMostrando 30 posições. Abra a carteira para consultar as demais.'
    elif intent == 'reviews':
        rows = [r for r in data.get('reviews', []) if not selected or r['owner'] == selected]
        # The source summary returns at most 50 reviews. Never invent an owner-specific total.
        content = f'Revisões pendentes na família: {data.get("review_count", 0)}.'
        if selected:
            content += f'\nFiltrando a amostra retornada para {selected}.'
        content += '\n' + '\n'.join(f'{r["owner"]} · {r["product_name"]} · {r["event_type"]} · {r["occurred_on"]}' for r in rows[:20])
        actions = [{'type': 'open_reviews'}]
    else:
        rows = [r for r in data.get('items', []) if not selected or r['owner'] == selected]
        content = 'Renda fixa: extrapolação de preços observados, sem equivalência com retorno contratual.'
        content += '\n' + ('\n'.join(f'{r["owner"]} · {r["instrument_code"]}: vencimento {r.get("maturity_date") or "não disponível"} · projeção {money(r.get("projected_value_cents"))} · confiança {r.get("confidence", "insufficient")}' for r in rows[:20]) or 'Dados insuficientes para este filtro.')
    evidence = {'path': VIEWS[intent], 'portfolio_version': data.get('portfolio_version'), 'reference_date': data.get('reference_date')}
    return {'content': content.strip(), 'intent': intent, 'actions': actions, 'evidence': evidence}


class ChatStore:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.executescript('''
            CREATE TABLE IF NOT EXISTS requests (
              user_id TEXT NOT NULL, id TEXT NOT NULL, digest TEXT NOT NULL,
              status TEXT NOT NULL, lease TEXT NOT NULL, started REAL NOT NULL,
              PRIMARY KEY(user_id,id));
            CREATE UNIQUE INDEX IF NOT EXISTS one_active_request ON requests(user_id) WHERE status='processing';
            CREATE TABLE IF NOT EXISTS messages (
              seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL,
              role TEXT NOT NULL, content TEXT NOT NULL, origin TEXT NOT NULL DEFAULT 'application',
              metadata TEXT NOT NULL DEFAULT '{}', created_at REAL NOT NULL);
            ''')
        self.path.chmod(0o600)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=5)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def history(self, user_id):
        with self.connect() as db:
            rows = db.execute('SELECT * FROM (SELECT * FROM messages WHERE user_id=? ORDER BY seq DESC LIMIT 200) ORDER BY seq', (user_id,)).fetchall()
        return [{'id': r['id'], 'role': r['role'], 'content': r['content'], 'origin': r['origin'],
                 'created_at': r['created_at'], **json.loads(r['metadata'])} for r in rows]

    def reserve(self, user_id, request_id, message, owner):
        digest = hashlib.sha256(json.dumps([message,owner],ensure_ascii=False).encode()).hexdigest()
        now = time.time()
        lease = str(uuid.uuid4())
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT * FROM requests WHERE user_id=? AND id=?', (user_id,request_id)).fetchone()
            if row and row['digest']!=digest:
                return 'mismatch', None
            if row and row['status']=='done':
                return 'done', None
            db.execute("UPDATE requests SET status='failed' WHERE user_id=? AND status='processing' AND started<?", (user_id,now-60))
            if db.execute("SELECT 1 FROM requests WHERE user_id=? AND status='processing'", (user_id,)).fetchone():
                return 'busy', None
            db.execute('''INSERT INTO requests VALUES(?,?,?,'processing',?,?) ON CONFLICT(user_id,id)
              DO UPDATE SET status='processing',lease=excluded.lease,started=excluded.started''', (user_id,request_id,digest,lease,now))
            message_id = f'{user_id}:{request_id}:user'
            db.execute('INSERT OR IGNORE INTO messages(id,user_id,role,content,created_at) VALUES(?,?,\'user\',?,?)', (message_id,user_id,message,now))
        return 'ready', lease

    def finish(self, user_id, request_id, lease, result):
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            updated = db.execute("UPDATE requests SET status='done' WHERE user_id=? AND id=? AND status='processing' AND lease=?", (user_id,request_id,lease)).rowcount
            if not updated:
                return False
            metadata = {k:v for k,v in result.items() if k!='content'}
            db.execute('INSERT INTO messages(id,user_id,role,content,metadata,created_at) VALUES(?,?,\'assistant\',?,?,?)',
                       (f'{user_id}:{request_id}:assistant',user_id,result['content'],json.dumps(metadata),time.time()))
        return True

    def fail(self, user_id, request_id, lease):
        with self.connect() as db:
            db.execute("UPDATE requests SET status='failed' WHERE user_id=? AND id=? AND lease=? AND status='processing'", (user_id,request_id,lease))

    def import_legacy(self, user_id, source, session_id):
        with sqlite3.connect(Path(source).resolve().as_uri()+'?mode=ro',uri=True) as src:
            rows=src.execute("SELECT id,role,content,timestamp FROM messages WHERE session_id=? AND role IN ('user','assistant') AND content IS NOT NULL AND content<>'' ORDER BY id", (session_id,)).fetchall()
        with self.connect() as db:
            for source_id,role,content,stamp in rows:
                db.execute("INSERT OR IGNORE INTO messages(id,user_id,role,content,origin,metadata,created_at) VALUES(?,?,?,?,'hermes_archive',?,?)",
                           (f'legacy:{session_id}:{source_id}',user_id,role,content,json.dumps({'archived':True}),stamp or 0))
        return len(rows)


def handle(handler, config, root, worker_port=3041):
    store = ChatStore(Path(root)/'state/juanca-conversations.db')
    user_id = config['user_id']
    if handler.command == 'GET':
        handler.reply_json(200, {'messages': store.history(user_id), 'mode': 'guided', 'hermes_required': False})
        return
    try:
        size = int(handler.headers.get('Content-Length', '0'))
        if not 0<size<=40000 or handler.headers.get('Transfer-Encoding') or handler.headers.get('Content-Type','').split(';')[0]!='application/json':
            raise ValueError()
        body = json.loads(handler.rfile.read(size))
        message=body.get('message')
        owner=body.get('owner', 'family')
        request_id=body.get('request_id')
        if not isinstance(message,str) or not message.strip() or len(message)>8000 or owner not in ('family','Jorge','Julia') or not isinstance(request_id,str) or not re.fullmatch(r'[A-Za-z0-9_-]{8,100}',request_id):
            raise ValueError()
    except (ValueError,TypeError,AttributeError,UnicodeError):
        handler.reply_json(400, {'detail':'Envie uma mensagem de até 8.000 caracteres e um identificador de envio válido.'})
        return
    try:
        state,lease=store.reserve(user_id,request_id,message.strip(),owner)
    except sqlite3.OperationalError:
        handler.reply_json(503,{'detail':'A conversa está temporariamente ocupada. Tente novamente.'})
        return
    if state=='mismatch':
        handler.reply_json(409, {'code':'IDEMPOTENCY_MISMATCH','detail':'Este identificador já corresponde a outra mensagem.'})
        return
    if state=='busy':
        handler.reply_json(409, {'code':'BUSY','detail':'Há uma consulta em andamento. Aguarde e confira o histórico antes de reenviar.'})
        return
    if state=='done':
        handler.reply_json(200, {'messages':store.history(user_id),'replayed':True,'hermes_required':False})
        return
    def api(path):
        if path not in VIEWS.values():
            raise ValueError('View not allowed')
        req=Request(f'http://127.0.0.1:{worker_port}'+path,headers={'oai-authenticated-user-id':user_id,'oai-authenticated-user-email':'juanca@localhost'})
        with urlopen(req,timeout=20) as r:
            return json.load(r)
    try:
        result=answer(message.strip(),owner,api)
        if not store.finish(user_id,request_id,lease,result):
            handler.reply_json(409,{'detail':'A consulta perdeu sua reserva. Atualize o histórico.'})
            return
        handler.reply_json(200,{'messages':store.history(user_id),'mode':'guided','hermes_required':False})
    except (OSError,ValueError,KeyError,TypeError):
        store.fail(user_id,request_id,lease)
        handler.reply_json(502,{'detail':'Não foi possível consultar os dados. A carteira não foi modificada; confira o histórico antes de tentar novamente.'})
