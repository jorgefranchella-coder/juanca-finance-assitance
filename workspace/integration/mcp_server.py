"""Juanca tools share the web application's authenticated API and storage."""
import json
import base64
import hashlib
import mimetypes
import re
import uuid
from decimal import Decimal, InvalidOperation
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from urllib.parse import quote
from mcp.server.fastmcp import FastMCP

mcp = FastMCP('patrimonio')
CONFIG = json.loads((Path(__file__).parent / 'credentials.json').read_text())
BASE = 'http://127.0.0.1:3040'

class ApiError(ValueError):
    def __init__(self, status, body):
        self.status = status
        try:
            self.body = json.loads(body)
        except (ValueError, TypeError):
            self.body = {}
        super().__init__(f'API {status}: {body[:1500]}')


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
        raise ApiError(e.code, e.read().decode()) from e


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


def file_evidence_request(path, body, headers):
    try:
        return api(path, body, method='POST', extra_headers=headers)
    except ApiError as exc:
        if exc.status != 409 or exc.body.get('code') != 'IDEMPOTENCY_MISMATCH':
            raise
        details = exc.body.get('details')
        if not isinstance(details, dict):
            details = {}
        return {'status': 'conflict', 'code': 'IDEMPOTENCY_MISMATCH', 'details': details,
                'evidence_recorded': False, 'portfolio_changed': False,
                'next_step': 'El reenvío no fue aceptado. Revisa los datos diferentes y el estado del registro anterior; no confirmes una importación nueva ni cambies la cartera.'}


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
        return file_evidence_request('/api/shadow/evidence/photo-file', body, headers)
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
    return file_evidence_request('/api/shadow/evidence/document-file', body, headers)


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

def _current_positions(owner='', asset_class=''):
    """Read current positions from the authoritative API; never substitute chat history."""
    try:
        result = api('/api/portfolio/positions')
    except (ValueError, OSError, TimeoutError):
        return {'status': 'unavailable', 'positions': [], 'values_verified': False,
                'message': 'No se pudieron consultar las posiciones actuales; no uses saldos del historial como actuales.'}
    if not isinstance(result, dict) or not isinstance(result.get('positions'), list) or result.get('mode') != 'postgres' or result.get('authoritative') is not True:
        return {'status': 'unavailable', 'positions': [], 'values_verified': False,
                'message': 'La respuesta no contiene posiciones; no uses saldos del historial como actuales.'}
    rows = [dict(row) for row in result['positions'] if isinstance(row, dict)
            and (not owner or row.get('owner') == owner)
            and (not asset_class or row.get('asset_class') == asset_class)]
    for row in rows:
        missing = []
        for key in ('institution', 'account', 'product_name', 'reference_date', 'currency', 'quantity'):
            if row.get(key) in (None, ''):
                missing.append(key)
        if row.get('asset_class') == 'private_pension':
            for key in ('plan_number', 'fund'):
                if row.get(key) in (None, ''):
                    missing.append(key)
        if row.get('market_value_minor') is None and row.get('market_value_cents') is None:
            missing.append('market_value')
        row['missing_current_fields'] = missing
        row['valuation_date'] = row.get('price_as_of') or row.get('reference_date')
        row['valuation_date_kind'] = 'price_as_of' if row.get('price_as_of') else 'source_reference_date' if row.get('reference_date') else None
        if not row['valuation_date']:
            missing.append('valuation_date')
    return {'status': 'available', 'values_verified': True, 'positions': rows, 'count': len(rows),
            'queried_at': datetime.now(timezone.utc).isoformat(),
            'filter': {'owner': owner or None, 'asset_class': asset_class or None},
            'reference_date': result.get('reference_date'), 'portfolio_version': result.get('portfolio_version'),
            'valuation_complete': result.get('valuation_complete'),
            'mode': result.get('mode'), 'authoritative': result.get('authoritative'),
            'message': 'Solo los campos presentes en estas posiciones están verificados por esta consulta. '
                       'Las fechas corresponden a cada posición; datos del historial no están verificados. '
                       'Una lista vacía solo indica que no hay coincidencias en esta respuesta y no demuestra ausencia de patrimonio.'}

def _snapshot_publication_status():
    sources = {}
    for name in ('b3', 'external'):
        try:
            result = api('/api/shadow/reconciliation/' + name + '/snapshots')
            if not isinstance(result, dict) or not isinstance(result.get('snapshots'), list):
                raise ValueError('Respuesta inválida')
            sources[name] = {'status': 'available', 'snapshots': [
                {**{key: row.get(key) for key in ('document_id', 'owner', 'source_system', 'original_name', 'effective_as_of', 'registered_at', 'published', 'latest')},
                 'position_details': [{key: position.get(key) for key in ('instrument_code', 'plan_number', 'fund', 'fund_cnpj', 'position_reference_date', 'quantity', 'market_value', 'valuation_basis', 'identity_status', 'identity_decision_revision')} for position in (row.get('position_details') or []) if isinstance(position, dict)]}
                for row in result['snapshots'] if isinstance(row, dict)]}
        except (ValueError, OSError, TimeoutError):
            sources[name] = {'status': 'unavailable', 'snapshots': []}
    return {'sources': sources, 'queried_at': datetime.now(timezone.utc).isoformat(),
            'coverage_note': 'Cada listado puede estar limitado; la ausencia de un documento no prueba su estado. Los detalles son evidencia del extracto y su fecha: no afirmes que describen la posición actual sin verificar la correspondencia de titular, cuenta, instrumento y vigencia. Las confirmaciones de movimientos no son extractos de posición.'}

@mcp.tool()
def consultar_patrimonio(vista: str = 'dashboard', propietario: str = '', clase: str = '') -> dict:
    """Para saldos o detalle usa positions y filtra propietario/clase (previdencia: private_pension). summary cuenta revisiones y nunca prueba saldos; se acompaña de una lectura actual separada. Para próximos vencimientos usa consultar_vencimientos. Para estado de publicación de extractos usa extractos. No completes campos ausentes con el historial ni infieras el estado de un documento ausente."""
    paths = {v: '/api/portfolio/' + v for v in ('dashboard', 'summary', 'positions')}
    paths['cost-basis'] = '/api/shadow/position-identities/acquisition-reconciliation'
    paths['fixed-income-projection'] = '/api/shadow/fixed-income-projection'
    paths['chat'] = '/api/shadow/conversations/family/messages'
    if vista == 'extractos':
        return _snapshot_publication_status()
    if vista not in paths:
        raise ValueError('Vista no permitida')
    if propietario and propietario not in {'Jorge', 'Julia'}:
        raise ValueError('Titular inválido')
    if clase and not re.fullmatch(r'[a-z_]{1,50}', clase):
        raise ValueError('Clase inválida')
    if vista == 'positions':
        return _current_positions(propietario, clase)
    result = api(paths[vista])
    if vista == 'fixed-income-projection':
        if not isinstance(result, dict) or not isinstance(result.get('items'), list):
            raise ValueError('Proyección de renta fija no disponible o incompleta')
        return {'reference_date': result.get('reference_date'), 'summary': result.get('summary'),
                'contractual_summary': result.get('contractual_summary'), 'mode': result.get('mode'),
                'authoritative': result.get('authoritative'), 'details_omitted': True,
                'next_step': 'Para próximos vencimientos usa consultar_vencimientos con titular y horizonte; la matriz detallada está disponible en la aplicación.'}
    if vista == 'summary':
        if not isinstance(result, dict):
            raise ValueError('Respuesta inválida del resumen')
        return {**result, 'scope': 'operational_counts_only', 'summary_scope': 'all_household',
                'summary_does_not_verify_positions': True,
                'summary_does_not_verify_document_status': True,
                'current_positions': _current_positions(propietario, clase)}
    return result

def _maturity_date(value):
    try:
        if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
            return None
        return date.fromisoformat(value)
    except ValueError:
        return None


def _compact_maturities(projection, owner, horizon, category, cutoff, limit, cursor=''):
    if not isinstance(projection, dict) or not isinstance(projection.get('items'), list):
        raise ValueError('Proyección de renta fija no disponible o incompleta')
    today = _maturity_date(cutoff)
    if today is None:
        raise ValueError('Fecha de corte inválida; usa AAAA-MM-DD')
    if owner not in ('', 'Jorge', 'Julia') or category not in ('futuros', 'vencidos', 'sin_fecha'):
        raise ValueError('Titular o categoría inválida')
    if isinstance(horizon, bool) or not isinstance(horizon, int) or not 1 <= horizon <= 3650 or isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 50:
        raise ValueError('Horizonte debe ser 1–3650 días y límite 1–50')
    counts = {'futuros': 0, 'vencidos': 0, 'sin_fecha': 0}
    rows = []
    for item in projection['items']:
        if not isinstance(item, dict):
            raise ValueError('Posición de renta fija inválida; no se puede afirmar cobertura completa')
        if owner and item.get('owner') != owner:
            continue
        maturity = _maturity_date(item.get('maturity_date'))
        state = 'sin_fecha' if maturity is None else 'vencidos' if maturity < today else 'futuros'
        counts[state] += 1
        if state != category or (state == 'futuros' and maturity > today + timedelta(days=horizon)) or (state == 'vencidos' and maturity < today - timedelta(days=horizon)):
            continue
        contract = item.get('contractual') if isinstance(item.get('contractual'), dict) else {}
        complete = contract.get('status') == 'complete'
        rows.append({'instrumento': item.get('instrument_code'), 'producto': item.get('product_name'),
                     'titular': item.get('owner'), 'custodia': item.get('institution'), 'cuenta': item.get('account'),
                     'emisor': item.get('issuer'), 'moneda': item.get('currency'),
                     'vencimiento': maturity.isoformat() if maturity else None, 'estado_vencimiento': state,
                     'fecha_referencia': item.get('reference_date') or None,
                     'proyeccion_contractual': {'estado': contract.get('status') or 'no_disponible',
                         'importe_bruto_centavos': contract.get('gross_maturity_cents') if complete else None,
                         'motivos': contract.get('missing') or []},
                     'fecha_conocida': maturity is not None})
    rows.sort(key=lambda item: (item['vencimiento'] or '9999-12-31', item['titular'] or '', item['custodia'] or '', item['cuenta'] or '', item['instrumento'] or '', json.dumps(item, sort_keys=True, ensure_ascii=True)))
    signature = hashlib.sha256(json.dumps({'rows': rows, 'owner': owner, 'horizon': horizon, 'category': category, 'cutoff': cutoff, 'limit': limit}, sort_keys=True, ensure_ascii=True, separators=(',', ':')).encode()).hexdigest()
    offset = 0
    if cursor:
        try:
            data = json.loads(base64.urlsafe_b64decode(cursor + '=' * (-len(cursor) % 4)))
            if data.get('signature') != signature or not isinstance(data.get('offset'), int) or isinstance(data['offset'], bool) or not 0 < data['offset'] < len(rows):
                raise ValueError()
            offset = data['offset']
        except (ValueError, TypeError, KeyError, AttributeError):
            raise ValueError('Cursor inválido o datos modificados; inicia una nueva consulta')
    end = min(offset + limit, len(rows))
    next_cursor = base64.urlsafe_b64encode(json.dumps({'signature': signature, 'offset': end}, separators=(',', ':')).encode()).decode().rstrip('=') if end < len(rows) else None
    return {'estado': 'disponible', 'fecha_consulta': datetime.now(timezone.utc).isoformat(),
            'fecha_corte': cutoff, 'fecha_referencia_cartera': projection.get('reference_date') or None,
            'filtro': {'titular': owner or None, 'horizonte_dias': horizon, 'categoria': category},
            'cobertura': {'posiciones_por_estado': counts, 'coincidencias_en_horizonte': len(rows),
                          'alcance': 'posiciones de renta fija incluidas en la proyección vigente',
                          'nota': 'Una fecha conocida se muestra aunque la proyección contractual esté incompleta; la fecha de referencia puede ser anterior al corte.'},
            'vencimientos': rows[offset:end], 'siguiente_cursor': next_cursor}


@mcp.tool()
def consultar_vencimientos(propietario: str = '', horizonte_dias: int = 365, categoria: str = 'futuros', fecha_corte: str = '', limite: int = 20, cursor: str = '') -> dict:
    """Próximos vencimientos de renta fija sin volcar calendarios de proyección. propietario: Jorge, Julia o vacío; horizonte_dias: 1–3650; categoria: futuros (desde fecha_corte inclusive), vencidos o sin_fecha; fecha_corte AAAA-MM-DD (por defecto hoy en São Paulo); limite: 1–50. Para más resultados repite exactamente los parámetros y pasa siguiente_cursor. Si no hay proyección contractual no inventes el importe; la fecha conocida sigue visible. Para preguntas en español o portugués usa esta herramienta, no inventes vistas de consultar_patrimonio."""
    if authority_mode() != 'postgres':
        raise ValueError('No se pudo confirmar la autoridad PostgreSQL para consultar vencimientos')
    cutoff = fecha_corte or datetime.now(ZoneInfo('America/Sao_Paulo')).date().isoformat()
    result = api('/api/shadow/fixed-income-projection')
    return _compact_maturities(result, propietario, horizonte_dias, categoria, cutoff, limite, cursor)


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
    if result.get('status') == 'conflict':
        return result
    return {'evidence': result, 'evidence_recorded': True, 'portfolio_changed': False,
            'next_step': 'Foto conservada en PostgreSQL para revisión; no modifica la cartera.'}

@mcp.tool()
def aclarar_evidencia_foto(propietario: str, datos_json: str, evidencia_id: str = '', procedencia: str = '') -> dict:
    """Guarda y verifica una aclaración aportada por el usuario sobre una foto pendiente, sin publicar ni modificar cartera. datos_json admite reference_date (AAAA-MM-DD), institution, plan_number, fund_name, fund_cnpj y source_locator. Fondo o CNPJ requieren plan_number para no mezclar planes. procedencia describe el mensaje o fuente de la aclaración. Si hay más de una foto pendiente pide evidencia_id; no prometas que quedó guardado hasta recibir saved=true. Usa esta herramienta cuando el usuario complete o corrija datos después de enviar la foto."""
    if propietario not in ('Jorge', 'Julia') or not procedencia.strip():
        raise ValueError('Indica titular y procedencia de la aclaración')
    if authority_mode() != 'postgres':
        raise ValueError('La aclaración no se guardó: PostgreSQL no está disponible como autoridad')
    try:
        data = json.loads(datos_json)
    except (ValueError, TypeError):
        raise ValueError('Los datos deben ser un objeto JSON válido')
    if not isinstance(data, dict) or not data:
        raise ValueError('Indica los datos de la aclaración')
    candidates, cursor, seen = [], '', set()
    while True:
        response = api('/api/shadow/evidence/photos?limit=100' + ('&cursor=' + quote(cursor, safe='') if cursor else ''))
        if not isinstance(response, dict) or not isinstance(response.get('items'), list):
            raise ValueError('No se pudo verificar la lista de evidencias; no se guardó la aclaración')
        candidates.extend(x for x in response['items'] if isinstance(x, dict) and x.get('owner') == propietario and x.get('proposal_evidence_status') == 'awaiting_review')
        cursor = response.get('next_cursor') or ''
        if not cursor:
            break
        if cursor in seen:
            raise ValueError('No se pudo completar la búsqueda de evidencias; no se guardó la aclaración')
        seen.add(cursor)
    if evidencia_id:
        selected = [x for x in candidates if x.get('upload_id') == evidencia_id]
        if len(selected) != 1:
            raise ValueError('La evidencia no corresponde al titular o ya no está pendiente; no se guardó la aclaración')
    elif len(candidates) != 1:
        return {'saved': False, 'reason': 'evidence_ambiguous' if candidates else 'evidence_not_found',
                'candidates': [{k: x.get(k) for k in ('upload_id','file_name','created_at','owner')} for x in candidates],
                'next_step': 'Identifica la foto por su evidencia_id antes de guardar la aclaración.', 'portfolio_changed': False}
    else:
        selected = candidates
    photo_id = selected[0]['upload_id']
    payload_key = json.dumps([photo_id, data, procedencia.strip()], sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()
    request_key = stable_request_id(propietario, payload_key, prefix='photo-clarification')
    path = '/api/shadow/evidence/photos/' + quote(photo_id, safe='') + '/clarifications'
    saved = api(path, {'request_key': request_key, 'metadata': data, 'provenance': procedencia.strip()}, method='POST')
    persisted = api(path)
    records = persisted.get('clarifications', []) if isinstance(persisted, dict) else []
    match = next((item for item in records if isinstance(item, dict) and item.get('id') == saved.get('clarification_id') and item.get('revision') == saved.get('revision')), None)
    if not match:
        return {'saved': False, 'reason': 'verification_failed', 'next_step': 'No se pudo verificar la aclaración; consulta la evidencia antes de volver a intentarlo.', 'portfolio_changed': False}
    return {'saved': True, 'upload_id': photo_id, 'clarification': match, 'replayed': saved.get('replayed', False), 'portfolio_changed': False}


@mcp.tool()
def consultar_aclaraciones_foto(evidencia_id: str) -> dict:
    """Recupera la historia auditada de aclaraciones de una foto por upload_id, incluso en una sesión nueva. No modifica la evidencia ni la cartera."""
    if not re.fullmatch(r'[0-9a-fA-F-]{36}', evidencia_id):
        raise ValueError('Indica un identificador de evidencia válido')
    if authority_mode() != 'postgres':
        raise ValueError('No se pueden verificar aclaraciones sin autoridad PostgreSQL')
    return api('/api/shadow/evidence/photos/' + quote(evidencia_id, safe='') + '/clarifications')


@mcp.tool()
def registrar_snapshot_previdencia(propietario: str, instituicao: str, data_referencia: str,
                                   base_valor: str, planos_json: str, evidencias_json: str = '[]',
                                   alcance: str = 'complete', identidade_pendente: bool = False) -> dict:
    """Prepara saldos de previdência para revisão sem publicar carteira. Para atualizar apenas os planos informados, use alcance='plans': os outros são conservados com a última data publicada e a mesma base bruta/líquida. Use identidade_pendente=true se o fundo/CNPJ vier apenas de evidência anterior e a nova foto não o confirmar. Exige titular, instituição, data, base gross/net e para cada plano número, produto, fundo, CNPJ, saldo bruto, saldo líquido e regime tributário. Cada plano mantém identidade separada."""
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
    scope_aliases = {'complete': 'complete', 'completo': 'complete', 'plans': 'plans', 'planos': 'plans', 'parcial': 'plans'}
    scope = scope_aliases.get(alcance.strip().lower())
    if not scope or not isinstance(identidade_pendente, bool) or identidade_pendente and scope != 'plans':
        raise ValueError('Indique alcance completo ou por planos; identidade pendente exige atualização por planos')
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
    # Reuse the latest recorded clarification for each exact photo and plan;
    # conflicting facts require a new clarification rather than silent selection.
    clarifications = []
    for ref in evidence_refs:
        if not isinstance(ref, dict) or ref.get('kind') != 'manual_photo':
            continue
        photo_id = ref.get('upload_id')
        if not isinstance(photo_id, str) or not re.fullmatch(r'[0-9a-fA-F-]{36}', photo_id):
            raise ValueError('Identificador de foto inválido')
        history = api('/api/shadow/evidence/photos/' + quote(photo_id, safe='') + '/clarifications')
        if not isinstance(history, dict) or not isinstance(history.get('clarifications'), list):
            raise ValueError('No se pudieron consultar las aclaraciones; no se preparó el snapshot')
        latest = {}
        for row in history['clarifications']:
            if isinstance(row, dict) and isinstance(row.get('scope'), str):
                old = latest.get(row['scope'])
                if old is None or row.get('revision', 0) > old.get('revision', 0):
                    latest[row['scope']] = row
        clarifications.extend(latest.values())
    def apply_value(current, value, label):
        if not value:
            return current
        if current and str(current).strip() != str(value).strip():
            raise ValueError('La aclaración guardada difiere de ' + label + '; revisa la evidencia antes de continuar')
        return current or value
    for row in clarifications:
        values = row.get('metadata') or {}
        if not isinstance(values, dict):
            raise ValueError('Aclaración inválida; no se preparó el snapshot')
        data_referencia = apply_value(data_referencia, values.get('reference_date'), 'la fecha')
        instituicao = apply_value(instituicao, values.get('institution'), 'la institución')
        plan_number = values.get('plan_number')
        if plan_number:
            matching = [p for p in normalized_plans if str(p.get('plan_number', '')).strip() == str(plan_number).strip()]
            if len(matching) != 1:
                raise ValueError('La aclaración corresponde a un plan no identificado de forma única')
            plan = matching[0]
            plan['fund'] = apply_value(plan.get('fund'), values.get('fund_name'), 'el fondo del plan')
            plan['fund_cnpj'] = apply_value(plan.get('fund_cnpj'), values.get('fund_cnpj'), 'el CNPJ del plan')
        evidence_refs.append({'kind':'photo_clarification','id':row['id'],'revision':row['revision']})
    if len(evidence_refs) > 20:
        raise ValueError('Demasiadas referencias de evidencia; no se preparó el snapshot')
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
    if scope == 'plans':
        body['update_scope'] = 'plans'
    if identidade_pendente:
        body['identity_unverified'] = True
    canonical = json.dumps(body, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()
    request_key = stable_request_id(propietario, canonical, prefix='telegram-pension')
    result = api('/api/shadow/reconciliation/external/manual-snapshots',
                 {'request_key': request_key, **body}, method='POST')
    return {'snapshot': result, 'portfolio_changed': False,
            'next_step': 'Atualização enviada para a fila de revisão PostgreSQL. Confira os planos conservados e a identidade; o patrimônio só muda após aprovação explícita na web.'}

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
        if result.get('status') == 'conflict':
            return result
        if result.get('replayed'):
            return {'evidence': result, 'evidence_recorded': True, 'portfolio_changed': False,
                    'next_step': 'El documento ya estaba registrado. Informa el estado de procesamiento devuelto y no afirmes que se creó una importación nueva.'}
        return {'evidence': result, 'evidence_recorded': True, 'portfolio_changed': False,
                'next_step': ('Documento original recibido y en cola de procesamiento. No confirmes que haya propuestas listas hasta verificar el resultado; la cartera cambia solo al aprobar cada propuesta.' if file_type == 'avenue_confirmation' else 'Documento original recibido y en cola de procesamiento. Consulta su estado antes de indicar qué revisión está disponible; la cartera aún no cambió.')}
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
