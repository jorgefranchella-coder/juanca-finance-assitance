"""Juanca tools share the web application's authenticated API and storage."""
import json
import hashlib
import mimetypes
import re
import uuid
from decimal import Decimal, InvalidOperation
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from urllib.parse import quote
from mcp.server.fastmcp import FastMCP

mcp = FastMCP('patrimonio')
CONFIG = json.loads((Path(__file__).parent / 'credentials.json').read_text())
BASE = 'http://127.0.0.1:3040'

def api(path, payload=None, fields=None, file_path=None, method=None, extra_headers=None):
    headers = {'Authorization': 'Bearer ' + CONFIG['token']}
    headers.update(extra_headers or {})
    data = None
    if fields is not None:
        boundary = uuid.uuid4().hex
        parts = []
        for key, value in fields.items():
            parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode())
        if file_path:
            p = Path(file_path).expanduser().resolve()
            if not p.is_file() or p.stat().st_size > 15 * 1024 * 1024:
                raise ValueError('Archivo inexistente o mayor de 15 MB')
            name = p.name.replace('"', '_').replace('\r', '_').replace('\n', '_')
            mime = mimetypes.guess_type(name)[0] or 'application/octet-stream'
            parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{name}"\r\nContent-Type: {mime}\r\n\r\n'.encode() + p.read_bytes() + b'\r\n')
        parts.append(f'--{boundary}--\r\n'.encode())
        data = b''.join(parts)
        headers['Content-Type'] = 'multipart/form-data; boundary=' + boundary
    elif isinstance(payload, bytes):
        data = payload
    elif payload is not None:
        data = json.dumps(payload).encode()
        headers['Content-Type'] = 'application/json'
    try:
        with urlopen(Request(BASE + path, data=data, headers=headers, method=method), timeout=180) as r:
            return json.load(r)
    except HTTPError as e:
        raise ValueError(f'API {e.code}: {e.read().decode()[:1500]}') from e


def authority_mode():
    mode = api('/api/authority').get('mode')
    if mode not in {'legacy', 'postgres', 'freeze'}:
        raise ValueError('No se pudo confirmar la autoridad patrimonial; no se enviará ninguna escritura')
    return mode


def stable_request_id(owner, content, prefix='telegram'):
    digest = hashlib.sha256((owner + '\0').encode() + content).hexdigest()[:40]
    return f'{prefix}-{digest}'


def register_text_evidence(owner, message):
    content = message.strip().encode('utf-8')
    request_id = stable_request_id(owner, content)
    return api('/api/shadow/evidence/text', {'request_id': request_id, 'owner': owner, 'text': message.strip()}, method='POST'), request_id


def register_file_evidence(path, owner, *, kind, source=None, file_type=None, reference_date=None, request_id=None):
    file_path = Path(path).expanduser().resolve()
    if not file_path.is_file() or not 0 < file_path.stat().st_size <= 15 * 1024 * 1024:
        raise ValueError('Archivo inexistente o mayor de 15 MB')
    body = file_path.read_bytes()
    filename = file_path.name.replace('\r', '_').replace('\n', '_')
    digest = hashlib.sha256((owner + '\0').encode() + body).hexdigest()
    request_id = request_id or f'telegram-{digest[:40]}'
    if not re.fullmatch(r'[A-Za-z0-9._:-]{8,128}', request_id):
        raise ValueError('Identificador de solicitud invalido')
    if kind == 'photo':
        mime = {'.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.heic': 'image/heic'}.get(file_path.suffix.lower())
        if not mime:
            raise ValueError('Formato de foto no admitido; usa JPG, PNG, WebP o HEIC')
        headers = {
            'Content-Type': mime,
            'X-Juanca-Owner': owner,
            'X-Juanca-File-Name': quote(filename, safe=''),
            'X-Juanca-Request-Id': request_id,
        }
        return api('/api/shadow/evidence/photo-file', body, method='POST', extra_headers=headers)
    if kind != 'document' or source not in {'b3', 'avenue', 'pension'}:
        raise ValueError('Tipo de evidencia documental invalido')
    mime = mimetypes.guess_type(filename)[0] or 'application/octet-stream'
    if source == 'b3':
        if file_type not in {'positions', 'movements'}:
            raise ValueError('Para B3, tipo debe ser positions o movements')
        mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    elif source == 'avenue':
        if file_type not in {'avenue_statement', 'avenue_confirmation'}:
            raise ValueError('Para Avenue, tipo debe ser statement o confirmation')
        mime = 'application/pdf'
    else:
        file_type = 'pension_statement'
        mime = 'application/pdf'
    headers = {
        'Content-Type': mime,
        'X-Juanca-Owner': owner,
        'X-Juanca-Source': source,
        'X-Juanca-File-Type': file_type,
        'X-Juanca-File-Name': quote(filename, safe=''),
        'X-Juanca-Request-Id': request_id,
    }
    if reference_date:
        headers['X-Juanca-Reference-Date'] = reference_date
    return api('/api/shadow/evidence/document-file', body, method='POST', extra_headers=headers)


def prepare_postgres_transaction(owner, message, account_id=None, photo_evidence_id=None):
    evidence_result, request_id = register_text_evidence(owner, message)
    interpretation = evidence_result.get('interpretation') or {}
    fields = interpretation.get('fields') or {}
    if interpretation.get('interpretation_status') != 'parsed_review':
        return {'evidence': evidence_result, 'evidence_recorded': True, 'portfolio_changed': False,
                'proposal_created': False, 'next_step': 'La evidencia quedó en PostgreSQL para revisión; el texto no produjo una operación completa.'}
    required = ('side', 'instrument_code', 'quantity', 'unit_price', 'currency', 'trade_date')
    if any(not fields.get(key) for key in required):
        return {'evidence': evidence_result, 'evidence_recorded': True, 'portfolio_changed': False,
                'proposal_created': False, 'next_step': 'La evidencia quedó en PostgreSQL; faltan campos para preparar una propuesta.'}
    evidence_id = evidence_result.get('evidence_id') or evidence_result.get('intake_id') or evidence_result.get('id') or (evidence_result.get('item') or {}).get('id')
    if not evidence_id:
        listed = api('/api/shadow/evidence/text').get('items', [])
        matches = [item for item in listed if item.get('request_id') == request_id]
        evidence_id = matches[0].get('id') if len(matches) == 1 else None
    if not evidence_id:
        return {'evidence': evidence_result, 'evidence_recorded': True, 'portfolio_changed': False,
                'proposal_created': False, 'next_step': 'La evidencia quedó guardada, pero no se pudo asociar su identificador a una propuesta.'}
    positions = api('/api/shadow/portfolio').get('positions', [])
    matching = [item for item in positions if item.get('owner') == owner
                and str(item.get('instrument_code', '')).strip().upper() == str(fields['instrument_code']).strip().upper()
                and str(item.get('currency', '')).upper() == str(fields['currency']).upper()
                and item.get('identity_status') == 'known' and item.get('account_id')]
    by_account = {}
    for item in matching:
        try:
            quantity = Decimal(str(item.get('quantity', '0')))
        except (InvalidOperation, ValueError):
            continue
        if quantity <= 0:
            continue
        candidate = by_account.setdefault(item['account_id'], {
            'account_id': item['account_id'], 'owner_id': item.get('owner_id'),
            'institution': item.get('institution') or 'Custodia sin nombre', 'instrument_code': item['instrument_code'],
            'currency': item['currency'], 'available_quantity': '0',
        })
        try:
            candidate['available_quantity'] = str(Decimal(candidate['available_quantity']) + quantity)
        except (InvalidOperation, ValueError):
            continue
    alternatives = list(by_account.values())
    if fields['side'] == 'buy' and not alternatives:
        accounts = api('/api/shadow/accounts').get('accounts', [])
        alternatives = [{'account_id': item.get('id'), 'owner_id': item.get('owner_id'),
                         'institution': item.get('institution') or item.get('account_scope') or 'Cuenta conocida',
                         'instrument_code': fields['instrument_code'], 'currency': fields['currency'],
                         'available_quantity': None}
                        for item in accounts if item.get('owner') == owner and item.get('identity_status') == 'known']
    if not alternatives:
        return {'evidence': evidence_result, 'evidence_recorded': True, 'portfolio_changed': False,
                'proposal_created': False, 'alternatives': [],
                'next_step': 'La evidencia quedó guardada, pero no hay una posición/cuenta conocida que permita registrar esta operación con seguridad.'}
    selected = next((item for item in alternatives if item['account_id'] == account_id), None) if account_id else None
    if account_id and not selected:
        return {'evidence': evidence_result, 'evidence_recorded': True, 'proposal_created': False,
                'needs_account_selection': True, 'alternatives': alternatives,
                'next_step': 'La cuenta elegida no coincide con las alternativas del activo; selecciona una cuenta de la lista.'}
    if not selected and len(alternatives) > 1:
        return {'evidence': evidence_result, 'evidence_recorded': True, 'portfolio_changed': False,
                'proposal_created': False, 'needs_account_selection': True, 'alternatives': alternatives,
                'next_step': 'El activo está disponible en varias cuentas. Elige una alternativa; luego se preparará una propuesta pendiente, sin aplicar el movimiento.'}
    if not selected:
        selected = alternatives[0]
    if fields['side'] == 'sell' and Decimal(str(fields['quantity'])) > Decimal(str(selected['available_quantity'])):
        return {'evidence': evidence_result, 'evidence_recorded': True, 'portfolio_changed': False,
                'proposal_created': False, 'needs_account_selection': True, 'alternatives': alternatives,
                'next_step': 'La cantidad supera la posición disponible en esa cuenta. Elige otra cuenta con unidades suficientes.'}
    proposal = {
        'owner_id': selected['owner_id'], 'account_id': selected['account_id'],
        'instrument_code': str(fields['instrument_code']).strip().upper(),
        'currency': str(fields['currency']).upper(), 'side': fields['side'],
        'quantity': str(fields['quantity']), 'unit_price': str(fields['unit_price']),
        'fees_minor': str(fields.get('fees_minor') or '0'), 'effective_date': fields['trade_date'],
        'source_evidence': {'kind': 'manual_photo', 'id': photo_evidence_id} if photo_evidence_id else {'kind': 'manual_text', 'id': evidence_id},
    }
    result = api('/api/shadow/proposals', proposal, method='POST', extra_headers={
        'Idempotency-Key': stable_request_id(owner, request_id.encode(), prefix='telegram-proposal'),
    })
    return {'evidence': evidence_result, 'proposal': result, 'selected_custody': selected,
            'fee_assumption': 'zero_not_reported' if fields.get('fees_assumed_zero') else None, 'evidence_recorded': True,
            'proposal_created': True, 'portfolio_changed': False,
            'next_step': 'Propuesta pendiente en PostgreSQL; requiere revisión y aprobación explícitas.'}

@mcp.tool()
def consultar_patrimonio(vista: str = 'dashboard') -> dict:
    """Consulta dashboard, summary, positions, cost-basis, fixed-income-projection o chat. Incluye los propietarios Jorge y Julia cuando hay datos."""
    paths = {v: '/api/portfolio/' + v for v in ('dashboard', 'summary', 'positions')}
    paths['cost-basis'] = '/api/shadow/position-identities/acquisition-reconciliation'
    paths['fixed-income-projection'] = '/api/shadow/fixed-income-projection'
    paths['chat'] = '/api/shadow/conversations/family/messages'
    if vista not in paths:
        raise ValueError('Vista no permitida')
    return api(paths[vista])

@mcp.tool()
def proponer_transaccion(propietario: str, mensaje: str, cuenta_id: str = '', evidencia_foto_id: str = '') -> dict:
    """Registra el texto y prepara una propuesta pendiente. Busca las cuentas que contienen el activo; si hay varias, devuelve alternativas para elegir mediante cuenta_id. Puede vincular una foto previamente guardada con evidencia_foto_id. Nunca aprueba ni cambia la cartera."""
    if propietario not in {'Jorge', 'Julia'} or not mensaje.strip():
        raise ValueError('Indica un titular válido y el texto del movimiento')
    mode = authority_mode()
    if mode == 'freeze':
        raise ValueError('Las escrituras patrimoniales están pausadas durante el corte')
    if mode == 'postgres':
        return prepare_postgres_transaction(propietario, mensaje, cuenta_id or None, evidencia_foto_id or None)
    return api('/api/transactions/chat', fields={'owner': propietario, 'message': mensaje})


@mcp.tool()
def registrar_evidencia_foto(propietario: str, ruta: str) -> dict:
    """Guarda una foto enviada por Telegram como evidencia pendiente en PostgreSQL. No crea ni aprueba un movimiento."""
    if propietario not in {'Jorge', 'Julia'}:
        raise ValueError('Titular invalido')
    mode = authority_mode()
    if mode != 'postgres':
        raise ValueError('El registro de fotos por Telegram requiere autoridad PostgreSQL activa')
    result = register_file_evidence(ruta, propietario, kind='photo')
    return {'evidence': result, 'evidence_recorded': True, 'portfolio_changed': False,
            'next_step': 'Foto conservada en PostgreSQL para revisión; no modifica la cartera.'}

@mcp.tool()
def registrar_snapshot_previdencia(propietario: str, instituicao: str, data_referencia: str,
                                   base_valor: str, planos_json: str, evidencias_json: str = '[]') -> dict:
    """Envia em uma única chamada o snapshot completo de previdência compilado durante a conversa. Cria evidência pendente sem alterar a carteira; exige titular, instituição, data e base gross/net (também aceita bruto/líquido), além de todos os planos. Os campos numero/produto/cnpj/saldo_bruto/saldo_liquido/regime_tributario são normalizados; aceita também os nomes canônicos plan_number/product_name/fund_cnpj/gross_balance/net_balance/tax_regime. Planos do mesmo fundo/CNPJ ficam detalhados na evidência e consolidados numa posição."""
    if propietario not in {'Jorge', 'Julia'}:
        raise ValueError('Titular inválido')
    if authority_mode() != 'postgres':
        raise ValueError('O registro de snapshots de previdência requer autoridade PostgreSQL ativa')
    try:
        plans = json.loads(planos_json)
        evidence_refs = json.loads(evidencias_json)
    except json.JSONDecodeError as exc:
        raise ValueError('Planos e evidências devem ser JSON válido') from exc
    if not isinstance(plans, list) or not isinstance(evidence_refs, list):
        raise ValueError('Planos e evidências devem ser listas JSON')
    basis_aliases = {'gross': 'gross', 'bruto': 'gross', 'net': 'net', 'liquido': 'net', 'líquido': 'net'}
    basis = basis_aliases.get(base_valor.strip().lower())
    if not basis:
        raise ValueError('Escolha uma única base de valorização: bruto ou líquido')
    plan_aliases = {'numero': 'plan_number', 'produto': 'product_name', 'cnpj': 'fund_cnpj', 'fund_name': 'fund', 'fondo': 'fund',
                    'saldo_bruto': 'gross_balance', 'saldo_liquido': 'net_balance',
                    'regime_tributario': 'tax_regime', 'codigo_anbima': 'anbima_code'}
    normalized_plans = []
    for plan in plans:
        if not isinstance(plan, dict):
            raise ValueError('Cada plano deve ser um objeto JSON')
        normalized = dict(plan)
        for source, target in plan_aliases.items():
            if source in normalized:
                normalized.setdefault(target, normalized.pop(source))
        normalized_plans.append(normalized)
    # A single fund CNPJ identifies the same underlying fund across separate plans.
    funds_by_cnpj = {}
    for plan in normalized_plans:
        cnpj = re.sub(r'\D', '', str(plan.get('fund_cnpj', '')))
        fund = str(plan.get('fund', '')).strip()
        if cnpj and fund:
            previous = funds_by_cnpj.setdefault(cnpj, fund)
            if previous != fund:
                raise ValueError(f'O CNPJ {cnpj} foi associado a nomes de fundo diferentes')
    required = ('plan_number', 'product_name', 'fund', 'fund_cnpj', 'gross_balance', 'net_balance', 'tax_regime')
    for plan in normalized_plans:
        cnpj = re.sub(r'\D', '', str(plan.get('fund_cnpj', '')))
        if not plan.get('fund') and cnpj in funds_by_cnpj:
            plan['fund'] = funds_by_cnpj[cnpj]
        missing = [field for field in required if plan.get(field) is None or str(plan.get(field)).strip() == '']
        if missing:
            raise ValueError('Faltan campos del plan: ' + ', '.join(missing))
    body = {'owner': propietario, 'institution': instituicao, 'reference_date': data_referencia,
            'valuation_basis': basis, 'plans': normalized_plans, 'evidence_refs': evidence_refs}
    canonical = json.dumps(body, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()
    request_key = stable_request_id(propietario, canonical, prefix='telegram-pension')
    result = api('/api/shadow/reconciliation/external/manual-snapshots',
                 {'request_key': request_key, **body}, method='POST')
    return {'snapshot': result, 'portfolio_changed': False,
            'next_step': 'Snapshot completo enviado para a fila de revisão PostgreSQL. O patrimônio só muda depois da publicação explícita na web.'}

@mcp.tool()
def decidir_transaccion(propuesta_id: str, accion: str) -> dict:
    """Aprueba o rechaza una propuesta: approve/reject. Aprobar cambia el patrimonio; requiere instrucción explícita del usuario sobre la propuesta."""
    if accion not in ('approve','reject'):
        raise ValueError('Accion invalida')
    mode = authority_mode()
    if mode == 'freeze':
        raise ValueError('Las escrituras patrimoniales están pausadas durante el corte')
    if mode == 'postgres':
        proposals = api('/api/shadow/proposals?status=pending').get('proposals', [])
        selected = next((item for item in proposals if item.get('id') == propuesta_id), None)
        if not selected:
            raise ValueError('No se encontró una propuesta PostgreSQL pendiente con ese identificador')
        portfolio = api('/api/shadow/portfolio')
        if not selected.get('version') or not selected.get('summary_hash') or portfolio.get('facts_revision') is None:
            raise ValueError('La propuesta o la revisión vigente de PostgreSQL está incompleta; no se aplicó ningún cambio')
        result = api('/api/shadow/proposals/' + quote(propuesta_id, safe='') + '/' + accion,
                     {'version': selected['version'], 'summary_hash': selected['summary_hash'],
                      'expected_facts_revision': portfolio['facts_revision']}, method='POST',
                     extra_headers={'Idempotency-Key': stable_request_id(propuesta_id, accion.encode(), prefix='telegram-decision')})
        return {'decision': result, 'authority': 'postgres', 'portfolio_changed': accion == 'approve'}
    return api('/api/transactions/proposals/' + quote(propuesta_id, safe=''), {'action': accion})

@mcp.tool()
def importar_documento(ruta: str, fuente: str, propietario: str, tipo: str = '', fecha_referencia: str = '') -> dict:
    """En PostgreSQL incorpora B3, Avenue o previsión como evidencia documental para revisión; aún no publica una posición automáticamente. Usar solo por pedido del usuario."""
    if fuente not in ('b3','avenue','pension'):
        raise ValueError('Fuente invalida')
    if propietario not in {'Jorge', 'Julia'}:
        raise ValueError('Titular invalido')
    mode = authority_mode()
    if mode == 'freeze':
        raise ValueError('Las escrituras patrimoniales están pausadas durante el corte')
    if mode == 'postgres':
        file_type = ({'positions': 'positions', 'movements': 'movements'}.get(tipo, tipo) if fuente == 'b3' else
                     {'statement': 'avenue_statement', 'confirmation': 'avenue_confirmation'}.get(tipo, tipo) if fuente == 'avenue' else
                     'pension_statement')
        result = register_file_evidence(ruta, propietario, kind='document', source=fuente,
                                        file_type=file_type, reference_date=fecha_referencia or None)
        return {'evidence': result, 'evidence_recorded': True, 'portfolio_changed': False,
                'next_step': 'Documento original guardado en PostgreSQL para conciliación; la cartera no cambia hasta publicar una revisión aprobada.'}
    return api('/api/import/' + fuente, fields={'owner': propietario,'kind': tipo,'reference_date': fecha_referencia}, file_path=ruta)

@mcp.tool()
def guardar_costo(propietario: str, activo: str, moneda: str, cantidad: float, costo_unitario: float, fecha: str) -> dict:
    """Registra costo manual con autorización del usuario; fecha YYYY-MM-DD, moneda BRL/USD."""
    mode = authority_mode()
    if mode == 'freeze':
        raise ValueError('Las escrituras patrimoniales están pausadas durante el corte')
    if mode == 'postgres':
        raise ValueError('El costo oficial no se escribe con la herramienta heredada. Registra el lote desde Compras frente al snapshot en la web PostgreSQL, con cuenta y evidencia identificadas.')
    return api('/api/portfolio/cost-basis', {'owner': propietario,'instrument_code': activo,'currency': moneda,'quantity': cantidad,'average_unit_cost': costo_unitario,'as_of': fecha})

@mcp.tool()
def resolver_revision(registro_id: int, decision: str, nota: str = '') -> dict:
    """Resuelve revisión usando las decisiones admitidas por la API; requiere instrucción del usuario."""
    mode = authority_mode()
    if mode == 'freeze':
        raise ValueError('Las escrituras patrimoniales están pausadas durante el corte')
    if mode == 'postgres':
        raise ValueError('Las revisiones PostgreSQL usan identificadores y decisiones auditadas propios; resuélvelas en la cola PostgreSQL de la web para evitar aplicar una revisión D1 antigua.')
    return api('/api/portfolio/reviews/' + str(registro_id), {'decision': decision,'note': nota})

@mcp.tool()
def actualizar_cotizaciones() -> dict:
    """Actualiza las cotizaciones públicas utilizadas por el dashboard."""
    mode = authority_mode()
    if mode == 'freeze':
        raise ValueError('Las escrituras patrimoniales están pausadas durante el corte')
    if mode == 'postgres':
        view = api('/api/shadow/portfolio')
        positions = view.get('positions', [])
        b3 = sorted({str(item.get('instrument_code', '')).upper() for item in positions
                     if item.get('currency') == 'BRL' and re.fullmatch(r'[A-Z]{4}\d{1,2}[A-Z]?', str(item.get('instrument_code', '')).upper())})
        us = sorted({str(item.get('instrument_code', '')).upper() for item in positions
                     if item.get('currency') == 'USD' and re.fullmatch(r'[A-Z.]{1,10}', str(item.get('instrument_code', '')).upper())})
        if not b3 and not us:
            raise ValueError('No hay símbolos de mercado reconocidos para actualizar')
        key = stable_request_id('market', json.dumps([b3, us], separators=(',', ':')).encode(), prefix='telegram-market')
        return api('/api/shadow/market/refresh', {'b3_symbols': b3, 'us_symbols': us, 'include_fx': True},
                   method='POST', extra_headers={'Idempotency-Key': key})
    return api('/api/market/refresh', {})

if __name__ == '__main__':
    mcp.run(transport='stdio')
