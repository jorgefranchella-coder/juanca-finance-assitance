"""Juanca tools share the web application's authenticated API and storage."""
import json
import mimetypes
import uuid
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from urllib.parse import urlencode, quote
from mcp.server.fastmcp import FastMCP

mcp = FastMCP('patrimonio')
CONFIG = json.loads((Path(__file__).parent / 'credentials.json').read_text())
BASE = 'http://127.0.0.1:3040'

def api(path, payload=None, fields=None, file_path=None):
    headers = {'Authorization': 'Bearer ' + CONFIG['token']}
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
    elif payload is not None:
        data = json.dumps(payload).encode()
        headers['Content-Type'] = 'application/json'
    try:
        with urlopen(Request(BASE + path, data=data, headers=headers), timeout=180) as r:
            return json.load(r)
    except HTTPError as e:
        raise ValueError(f'API {e.code}: {e.read().decode()[:1500]}') from e

@mcp.tool()
def consultar_patrimonio(vista: str = 'dashboard') -> dict:
    """Consulta dashboard, summary, positions, cost-basis, fixed-income-projection o chat. Incluye los propietarios Jorge y Julia cuando hay datos."""
    paths = {v: '/api/portfolio/' + v for v in ('dashboard', 'summary', 'positions', 'cost-basis', 'fixed-income-projection')}
    paths['chat'] = '/api/transactions/chat'
    if vista not in paths:
        raise ValueError('Vista no permitida')
    return api(paths[vista])

@mcp.tool()
def proponer_transaccion(propietario: str, mensaje: str) -> dict:
    """Prepara una propuesta pendiente desde texto; no modifica posiciones hasta aprobación."""
    return api('/api/transactions/chat', fields={'owner': propietario, 'message': mensaje})

@mcp.tool()
def decidir_transaccion(propuesta_id: str, accion: str) -> dict:
    """Aprueba o rechaza una propuesta: approve/reject. Aprobar cambia el patrimonio; requiere instrucción explícita del usuario sobre la propuesta."""
    if accion not in ('approve','reject'):
        raise ValueError('Accion invalida')
    return api('/api/transactions/proposals/' + quote(propuesta_id, safe=''), {'action': accion})

@mcp.tool()
def importar_documento(ruta: str, fuente: str, propietario: str, tipo: str = '', fecha_referencia: str = '') -> dict:
    """Importa archivo local B3, Avenue o pension con deduplicación. Usar por pedido del usuario; preserva original y revisiones."""
    if fuente not in ('b3','avenue','pension'):
        raise ValueError('Fuente invalida')
    return api('/api/import/' + fuente, fields={'owner': propietario,'kind': tipo,'reference_date': fecha_referencia}, file_path=ruta)

@mcp.tool()
def guardar_costo(propietario: str, activo: str, moneda: str, cantidad: float, costo_unitario: float, fecha: str) -> dict:
    """Registra costo manual con autorización del usuario; fecha YYYY-MM-DD, moneda BRL/USD."""
    return api('/api/portfolio/cost-basis', {'owner': propietario,'instrument_code': activo,'currency': moneda,'quantity': cantidad,'average_unit_cost': costo_unitario,'as_of': fecha})

@mcp.tool()
def resolver_revision(registro_id: int, decision: str, nota: str = '') -> dict:
    """Resuelve revisión usando las decisiones admitidas por la API; requiere instrucción del usuario."""
    return api('/api/portfolio/reviews/' + str(registro_id), {'decision': decision,'note': nota})

@mcp.tool()
def actualizar_cotizaciones() -> dict:
    """Actualiza las cotizaciones públicas utilizadas por el dashboard."""
    return api('/api/market/refresh', {})

if __name__ == '__main__':
    mcp.run(transport='stdio')
