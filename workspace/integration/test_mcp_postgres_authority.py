import importlib.util
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch


def load_mcp_server():
    fake_mcp = types.ModuleType('mcp')
    fake_server = types.ModuleType('mcp.server')
    fake_fastmcp = types.ModuleType('mcp.server.fastmcp')

    class FastMCP:
        def __init__(self, name):
            self.name = name

        def tool(self):
            return lambda function: function

        def run(self, **kwargs):
            pass

    fake_fastmcp.FastMCP = FastMCP
    fake_mcp.server = fake_server
    fake_server.fastmcp = fake_fastmcp
    with patch.dict(sys.modules, {'mcp': fake_mcp, 'mcp.server': fake_server, 'mcp.server.fastmcp': fake_fastmcp}):
        module_path = Path(__file__).with_name('mcp_server.py')
        spec = importlib.util.spec_from_file_location('juanca_mcp_server_test', module_path)
        module = importlib.util.module_from_spec(spec)
        original_read_text = Path.read_text

        def read_text(path, *args, **kwargs):
            if path.name == 'credentials.json' and path.parent == module_path.parent:
                return json.dumps({'token': 'test-token', 'user_id': 'test-family'})
            return original_read_text(path, *args, **kwargs)

        with patch.object(Path, 'read_text', read_text):
            spec.loader.exec_module(module)
    return module


mcp_server = load_mcp_server()


class FakeResponse:
    def __init__(self, payload):
        self.payload = json.dumps(payload).encode()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self):
        return self.payload

    def __getitem__(self, key):
        return None


class PostgresMCPTest(unittest.TestCase):
    def setUp(self):
        self.requests = []

    def fake_urlopen(self, request, timeout=0):
        self.requests.append(request)
        path = request.full_url.removeprefix(mcp_server.BASE)
        if path == '/api/authority':
            payload = {'mode': 'postgres', 'authoritative': True}
        elif path == '/api/shadow/evidence/text':
            payload = {'id': 'evidence-1', 'interpretation': {'interpretation_status': 'parsed_review', 'fields': {
                'side': 'buy', 'instrument_code': 'PETR4', 'quantity': '2', 'unit_price': '30',
                'currency': 'BRL', 'trade_date': '2026-10-23', 'fees_minor': '0'}}}
        elif path == '/api/shadow/portfolio':
            payload = {'positions': [{'owner': 'Jorge', 'owner_id': 'owner-1', 'account_id': 'account-1',
                'identity_status': 'known', 'instrument_code': 'PETR4', 'currency': 'BRL', 'quantity': '10',
                'institution': 'Fixture Custodian'}]}
        elif path == '/api/shadow/accounts':
            payload = {'accounts': [{'id': 'account-1', 'owner_id': 'owner-1', 'owner': 'Jorge', 'identity_status': 'known'}]}
        elif path == '/api/shadow/proposals':
            payload = {'proposal_id': 'proposal-1'}
        elif path == '/api/shadow/evidence/text?status=all':
            payload = {'items': []}
        else:
            payload = {'ok': True}
        return FakeResponse(payload)

    def test_text_trade_uses_postgres_evidence_and_creates_pending_proposal(self):
        with patch.object(mcp_server, 'urlopen', self.fake_urlopen):
            result = mcp_server.proponer_transaccion('Jorge', 'Compré 2 PETR4 a R$ 30 el 23/10/2026')
        self.assertTrue(result['evidence_recorded'])
        self.assertTrue(result['proposal_created'])
        self.assertFalse(result['portfolio_changed'])
        paths = [request.full_url.removeprefix(mcp_server.BASE) for request in self.requests]
        self.assertIn('/api/shadow/evidence/text', paths)
        self.assertIn('/api/shadow/proposals', paths)
        self.assertFalse(any(path.startswith('/api/transactions/') for path in paths))
        proposal_request = next(request for request in self.requests if request.full_url.endswith('/api/shadow/proposals'))
        body = json.loads(proposal_request.data)
        self.assertEqual(body['source_evidence'], {'kind': 'manual_text', 'id': 'evidence-1'})
        self.assertEqual(body['account_id'], 'account-1')
        self.assertTrue(proposal_request.get_header('Idempotency-key'))

    def test_sale_lists_only_accounts_that_hold_the_asset_and_waits_for_selection(self):
        positions = [
            {'owner': 'Jorge', 'owner_id': 'owner-1', 'account_id': 'account-a', 'identity_status': 'known', 'instrument_code': 'CSAN3', 'currency': 'BRL', 'quantity': '4', 'institution': 'Itaú'},
            {'owner': 'Jorge', 'owner_id': 'owner-1', 'account_id': 'account-b', 'identity_status': 'known', 'instrument_code': 'CSAN3', 'currency': 'BRL', 'quantity': '8', 'institution': 'BTG'},
            {'owner': 'Jorge', 'owner_id': 'owner-1', 'account_id': 'account-c', 'identity_status': 'known', 'instrument_code': 'PETR4', 'currency': 'BRL', 'quantity': '100', 'institution': 'Avenue'},
        ]
        def urlopen(request, timeout=0):
            self.requests.append(request)
            path = request.full_url.removeprefix(mcp_server.BASE)
            if path == '/api/authority': payload = {'mode': 'postgres'}
            elif path == '/api/shadow/evidence/text': payload = {'intake_id': 'evidence-csan', 'interpretation': {'interpretation_status': 'parsed_review', 'fields': {'side': 'sell', 'instrument_code': 'CSAN3', 'quantity': '8', 'unit_price': '2.73', 'currency': 'BRL', 'trade_date': '2026-10-27', 'fees_minor': '0'}}}
            elif path == '/api/shadow/portfolio': payload = {'positions': positions}
            else: payload = {'proposal_id': 'proposal-1'}
            return FakeResponse(payload)
        with patch.object(mcp_server, 'urlopen', urlopen):
            result = mcp_server.proponer_transaccion('Jorge', 'Venda executada: 8 ações de CSAN3 por R$ 2,73 em 27/10/2026')
        self.assertTrue(result['needs_account_selection'])
        self.assertEqual([item['account_id'] for item in result['alternatives']], ['account-a', 'account-b'])
        self.assertFalse(result['proposal_created'])
        self.assertFalse(any(request.full_url.endswith('/api/shadow/proposals') for request in self.requests))

    def test_selected_asset_account_creates_pending_proposal_and_links_existing_photo(self):
        def urlopen(request, timeout=0):
            self.requests.append(request)
            path = request.full_url.removeprefix(mcp_server.BASE)
            if path == '/api/authority': payload = {'mode': 'postgres'}
            elif path == '/api/shadow/evidence/text': payload = {'intake_id': 'evidence-csan', 'interpretation': {'interpretation_status': 'parsed_review', 'fields': {'side': 'sell', 'instrument_code': 'CSAN3', 'quantity': '8', 'unit_price': '2.73', 'currency': 'BRL', 'trade_date': '2026-10-27', 'fees_minor': '0'}}}
            elif path == '/api/shadow/portfolio': payload = {'positions': [{'owner': 'Jorge', 'owner_id': 'owner-1', 'account_id': 'account-1', 'identity_status': 'known', 'instrument_code': 'CSAN3', 'currency': 'BRL', 'quantity': '10', 'institution': 'Itaú'}]}
            else: payload = {'proposal_id': 'proposal-1'}
            return FakeResponse(payload)
        with patch.object(mcp_server, 'urlopen', urlopen):
            result = mcp_server.proponer_transaccion('Jorge', 'Venta ejecutada: 8 acciones de CSAN3 por R$ 2,73 el 27/10/2026', 'account-1', 'photo-uuid')
        self.assertTrue(result['proposal_created'])
        self.assertFalse(result['portfolio_changed'])
        proposal_request = next(request for request in self.requests if request.full_url.endswith('/api/shadow/proposals'))
        body = json.loads(proposal_request.data)
        self.assertEqual(body['source_evidence'], {'kind': 'manual_photo', 'id': 'photo-uuid'})

    def test_unstructured_update_is_saved_as_evidence_without_mutating_portfolio(self):
        def urlopen(request, timeout=0):
            self.requests.append(request)
            if request.full_url.endswith('/api/authority'):
                return FakeResponse({'mode': 'postgres'})
            return FakeResponse({'id': 'evidence-2', 'interpretation': {'interpretation_status': 'not_detected', 'fields': {}}})

        with patch.object(mcp_server, 'urlopen', urlopen):
            result = mcp_server.proponer_transaccion('Jorge', 'Agregar PGBL plano 244090')
        self.assertTrue(result['evidence_recorded'])
        self.assertFalse(result['proposal_created'])
        self.assertFalse(result['portfolio_changed'])
        self.assertEqual(len(self.requests), 2)
        self.assertTrue(self.requests[1].full_url.endswith('/api/shadow/evidence/text'))

    def test_photo_upload_uses_new_postgres_evidence_gateway(self):
        with tempfile.TemporaryDirectory() as folder:
            photo = Path(folder) / 'statement.jpg'
            photo.write_bytes(b'fake-jpeg-content')
            with patch.object(mcp_server, 'urlopen', self.fake_urlopen):
                result = mcp_server.registrar_evidencia_foto('Jorge', str(photo))
        self.assertTrue(result['evidence_recorded'])
        upload = self.requests[-1]
        self.assertTrue(upload.full_url.endswith('/api/shadow/evidence/photo-file'))
        self.assertEqual(upload.data, b'fake-jpeg-content')
        self.assertEqual(upload.get_header('X-juanca-owner'), 'Jorge')
        self.assertEqual(upload.get_header('Content-type'), 'image/jpeg')

    def test_pension_document_is_stored_as_postgres_evidence(self):
        with tempfile.TemporaryDirectory() as folder:
            document = Path(folder) / 'pension.pdf'
            document.write_bytes(b'%PDF-fake')
            with patch.object(mcp_server, 'urlopen', self.fake_urlopen):
                result = mcp_server.importar_documento(str(document), 'pension', 'Jorge')
        self.assertTrue(result['evidence_recorded'])
        upload = self.requests[-1]
        self.assertTrue(upload.full_url.endswith('/api/shadow/evidence/document-file'))
        self.assertEqual(upload.data, b'%PDF-fake')
        self.assertEqual(upload.get_header('X-juanca-file-type'), 'pension_statement')
        self.assertEqual(upload.get_header('X-juanca-source'), 'pension')

    def test_compiled_pension_bundle_is_submitted_once_as_complete_snapshot(self):
        with patch.object(mcp_server, 'urlopen', self.fake_urlopen):
            result = mcp_server.registrar_snapshot_previdencia(
                'Jorge', 'BTG Pactual', '2026-10-24', 'bruto',
                json.dumps([{'numero': '244090', 'produto': 'PGBL', 'fund_name': 'Access A',
                             'cnpj': '12.345.678/0001-99', 'isin': 'BR123', 'codigo_anbima': 'ANBIMA1',
                             'saldo_bruto': 1200.50, 'saldo_liquido': 1000.25, 'regime_tributario': 'Regressivo'},
                            {'plan_number': '248784', 'product_name': 'PGBL',
                             'fund_cnpj': '12345678000199', 'gross_balance': 2000, 'net_balance': 1800,
                             'tax_regime': 'Regressivo'}]),
                json.dumps([{'tipo': 'captura', 'ruta': '/private/evidence/photo.jpg'}]))
        self.assertFalse(result['portfolio_changed'])
        self.assertEqual(len(self.requests), 2)
        request = self.requests[-1]
        self.assertTrue(request.full_url.endswith('/api/shadow/reconciliation/external/manual-snapshots'))
        body = json.loads(request.data)
        self.assertEqual(body['owner'], 'Jorge')
        self.assertEqual(body['institution'], 'BTG Pactual')
        self.assertEqual(body['valuation_basis'], 'gross')
        self.assertEqual(body['plans'][0]['fund_cnpj'], '12.345.678/0001-99')
        self.assertEqual(body['plans'][0]['plan_number'], '244090')
        self.assertEqual(body['plans'][0]['anbima_code'], 'ANBIMA1')
        self.assertEqual(body['plans'][0]['fund'], 'Access A')
        self.assertEqual(body['plans'][1]['fund'], 'Access A')
        self.assertEqual(body['evidence_refs'][0]['tipo'], 'captura')
        self.assertTrue(body['request_key'].startswith('telegram-pension-'))

    def test_approval_uses_postgres_revision_and_proposal_route(self):
        def urlopen(request, timeout=0):
            self.requests.append(request)
            path = request.full_url.removeprefix(mcp_server.BASE)
            if path == '/api/authority':
                payload = {'mode': 'postgres'}
            elif path == '/api/shadow/proposals?status=pending':
                payload = {'proposals': [{'id': 'proposal-1', 'version': 3, 'summary_hash': 'hash-3'}]}
            elif path == '/api/shadow/portfolio':
                payload = {'facts_revision': 8}
            else:
                payload = {'status': 'applied'}
            return FakeResponse(payload)

        with patch.object(mcp_server, 'urlopen', urlopen):
            result = mcp_server.decidir_transaccion('proposal-1', 'approve')
        self.assertEqual(result['authority'], 'postgres')
        self.assertTrue(result['portfolio_changed'])
        decision = self.requests[-1]
        self.assertTrue(decision.full_url.endswith('/api/shadow/proposals/proposal-1/approve'))
        self.assertEqual(json.loads(decision.data), {
            'version': 3, 'summary_hash': 'hash-3', 'expected_facts_revision': 8,
        })
        self.assertTrue(decision.get_header('Idempotency-key'))


if __name__ == '__main__':
    unittest.main()
