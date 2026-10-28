"""Exercise the reversible portfolio authority switch with synthetic payloads."""
import http.client
import importlib.util
import json
import shutil
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

server = None


class PortfolioStub(BaseHTTPRequestHandler):
    calls = []

    def log_message(self, *_args):
        pass

    def do_GET(self):
        self.__class__.calls.append((self.command, self.path, self.headers.get('X-Juanca-Actor')))
        payloads = {
            '/v1/portfolio': {
                'portfolio_version': 'fixture-version', 'facts_revision': '4', 'reference_date': '2026-10-21',
                'valuation_complete': True, 'unvalued_count': 0, 'total_value_cents': '13000',
                'ptax': {'rate': 5.2, 'date': '2026-10-23'},
                'positions': [
                    {'owner': 'Jorge', 'institution': 'BTG', 'account_id': 'acct-petr', 'instrument_code': 'PETR4', 'asset_class': 'equity', 'currency': 'BRL',
                     'market_value_cents': '10000', 'quantity': '2', 'price_as_of': '2026-10-23'},
                    {'owner': 'Julia', 'instrument_code': 'AAPL', 'asset_class': 'international_equity', 'currency': 'USD',
                     'market_value_cents': '3000', 'quantity': '1', 'price_as_of': '2026-10-23'},
                    {'owner': 'Jorge', 'instrument_code': 'USD_CASH', 'asset_class': 'cash', 'currency': 'USD',
                     'market_value_cents': '999999', 'quantity': '1', 'price_as_of': '2026-10-23'},
                ],
            },
            '/v1/fixed-income-projection': {'positions': [], 'mode': 'shadow', 'authoritative': False},
            '/v1/position-identities/acquisition-reconciliation': {'positions': [
                {'owner': 'Jorge', 'institution': 'BTG', 'custody_account_id': 'acct-petr', 'instrument_code': 'PETR4',
                 'currency': 'BRL', 'custody_identity_resolved': True, 'status': 'matches_snapshot',
                 'weighted_average_unit_price': '40'},
            ]},
            '/v1/confirmations?status=open': {'open_count': 2, 'items': []},
            '/v1/proposals?status=pending': {'proposals': [{'id': 'pending-1'}]},
            '/v1/reconciliation/b3/snapshots': {'snapshots': [{'published': True}, {'published': False, 'latest': True}]},
            '/v1/reconciliation/external/snapshots': {'snapshots': [{'published': True}]},
            '/v1/authority/readiness': {
                'ready': False, 'mode': 'shadow', 'authoritative': False,
                'blockers': ['legacy_financial_writers_still_active', 'final_cutover_delta_not_verified', 'cutover_and_rollback_not_rehearsed'],
                'gates': [{'id': gate, 'status': 'blocked', 'detail': 'Pendiente.'} for gate in (
                    'legacy_financial_writers_still_active', 'final_cutover_delta_not_verified', 'cutover_and_rollback_not_rehearsed')],
            },
        }
        body = json.dumps(payloads[self.path]).encode()
        self.send_response(200); self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)

    def do_POST(self):
        self.rfile.read(int(self.headers.get('Content-Length', '0')))
        self.__class__.calls.append((self.command, self.path, self.headers.get('X-Juanca-Actor')))
        body = b'{"saved":true}'
        self.send_response(201); self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)


class CutoverAuthorityGatewayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        global server
        cls.server_temp = tempfile.TemporaryDirectory()
        root = Path(cls.server_temp.name)
        source = Path(__file__).parent
        shutil.copy(source / 'server.py', root / 'server.py')
        shutil.copy(source / 'browser_sessions.py', root / 'browser_sessions.py')
        (root / 'credentials.json').write_text(json.dumps({'username': 'fixture', 'password': 'fixture',
                                                           'token': 't' * 64, 'user_id': 'fixture-user'}))
        sys.path.insert(0, str(root))
        spec = importlib.util.spec_from_file_location('cutover_test_server', root / 'server.py')
        server = importlib.util.module_from_spec(spec); spec.loader.exec_module(server)

    @classmethod
    def tearDownClass(cls):
        sys.path.remove(str(Path(cls.server_temp.name)))
        cls.server_temp.cleanup()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.old_authority = server.AUTHORITY_CONFIG_PATH
        self.old_shadow = server.SHADOW_CONFIG_PATH
        self.old_report_root = server.CUTOVER_REPORT_ROOT
        self.authority = self.root / 'authority.json'
        self.shadow_config = self.root / 'application.json'
        self.stub = ThreadingHTTPServer(('127.0.0.1', 0), PortfolioStub)
        self.shadow_config.write_text(json.dumps({'token': 's' * 64, 'port': self.stub.server_port}))
        self.authority.write_text(json.dumps({'mode': 'postgres'}))
        server.AUTHORITY_CONFIG_PATH = self.authority
        server.SHADOW_CONFIG_PATH = self.shadow_config
        server.CUTOVER_REPORT_ROOT = self.root / 'reports'
        PortfolioStub.calls = []
        self.gateway = ThreadingHTTPServer(('127.0.0.1', 0), server.Gateway)
        self.threads = [threading.Thread(target=item.serve_forever, daemon=True) for item in (self.stub, self.gateway)]
        for thread in self.threads: thread.start()

    def tearDown(self):
        self.gateway.shutdown(); self.stub.shutdown()
        self.gateway.server_close(); self.stub.server_close()
        for thread in self.threads: thread.join(timeout=2)
        server.AUTHORITY_CONFIG_PATH = self.old_authority
        server.SHADOW_CONFIG_PATH = self.old_shadow
        server.CUTOVER_REPORT_ROOT = self.old_report_root
        self.temp.cleanup()

    def request(self, method, path, body=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.gateway.server_port)
        payload = json.dumps(body).encode() if body is not None else None
        connection.request(method, path, body=payload, headers={'Authorization': 'Bearer ' + server.CONFIG['token'],
                           **({'Content-Type': 'application/json'} if payload else {})})
        response = connection.getresponse(); result = json.loads(response.read()); status = response.status
        connection.close(); return status, result

    def test_portfolio_reads_switch_to_postgres_and_exclude_cash(self):
        status, dashboard = self.request('GET', '/api/portfolio/dashboard')
        self.assertEqual(status, 200); self.assertTrue(dashboard['authoritative'])
        self.assertEqual(dashboard['mode'], 'postgres'); self.assertEqual(dashboard['total_value_cents'], 13000)
        self.assertEqual(dashboard['allocation'][0]['value_cents'], 10000)
        status, positions = self.request('GET', '/api/portfolio/positions')
        self.assertEqual(status, 200); self.assertEqual(positions['count'], 2)
        self.assertNotIn('USD_CASH', [row['instrument_code'] for row in positions['positions']])
        petr = next(row for row in positions['positions'] if row['instrument_code'] == 'PETR4')
        self.assertEqual(petr['cost_status'], 'available'); self.assertEqual(petr['cost_basis_cents'], 8000)
        self.assertEqual(petr['unrealized_pnl_cents'], 2000)

    def test_postgres_portfolio_and_projection_reads_report_active_authority(self):
        status, portfolio = self.request('GET', '/api/shadow/portfolio')
        self.assertEqual(status, 200); self.assertEqual(portfolio['mode'], 'postgres'); self.assertTrue(portfolio['authoritative'])
        status, projection = self.request('GET', '/api/shadow/fixed-income-projection')
        self.assertEqual(status, 200); self.assertEqual(projection['mode'], 'postgres'); self.assertTrue(projection['authoritative'])

    def test_legacy_writes_are_blocked_and_quality_summary_uses_postgres(self):
        status, result = self.request('POST', '/api/import/b3', {'file': 'not forwarded'})
        self.assertEqual(status, 409); self.assertEqual(result['code'], 'LEGACY_WRITER_DISABLED')
        status, summary = self.request('GET', '/api/portfolio/summary')
        self.assertEqual(status, 200); self.assertEqual(summary['import_count'], 2); self.assertEqual(summary['review_count'], 4)
        self.assertIn(('GET', '/v1/confirmations?status=open', None), PortfolioStub.calls)
        self.assertIn(('GET', '/v1/proposals?status=pending', None), PortfolioStub.calls)
        status, created = self.request('POST', '/api/shadow/confirmations', {
            'owner': 'Jorge', 'category': 'fixture', 'title': 'Fixture confirmation',
            'source_key': 'fixture:single-writer', 'context': {}, 'evidence': [],
            'actions': [{'key': 'accept', 'label': 'Accept'}, {'key': 'keep_open', 'label': 'Keep open', 'keeps_open': True}],
        })
        self.assertEqual(status, 201); self.assertTrue(created['saved'])
        self.assertIn(('POST', '/v1/confirmations', 'fixture-user'), PortfolioStub.calls)

    def test_malformed_authority_config_fails_closed(self):
        self.authority.write_text('{"mode":"unknown"}')
        status, result = self.request('POST', '/api/import/b3', {'file': 'not forwarded'})
        self.assertEqual(status, 503); self.assertEqual(result['code'], 'AUTHORITY_CONFIGURATION_UNAVAILABLE')

    def test_freeze_blocks_legacy_and_postgres_api_writes(self):
        self.authority.write_text('{"mode":"freeze"}')
        status, legacy = self.request('POST', '/api/import/b3', {'file': 'not forwarded'})
        self.assertEqual(status, 423); self.assertEqual(legacy['code'], 'CUTOVER_FREEZE')
        status, shadow = self.request('POST', '/api/shadow/confirmations', {'source_key': 'fixture:freeze'})
        self.assertEqual(status, 423); self.assertEqual(shadow['code'], 'CUTOVER_FREEZE')
        status, authority = self.request('GET', '/api/authority')
        self.assertEqual(status, 200); self.assertEqual(authority, {'mode': 'freeze', 'authoritative': False, 'frozen': True})
        self.assertEqual(PortfolioStub.calls, [])

    def test_readiness_reports_postgres_cutover_only_with_complete_approval_attestation(self):
        reports = self.root / 'reports'; reports.mkdir()
        (reports / 'cutover-approved-delta-2026-10-24.json').write_text(json.dumps({
            'format': 'juanca-cutover-approved-delta-v1', 'difference_count': 29, 'covered_count': 29,
            'uncovered': [], 'capture_stable': True, 'dates_match': True,
        }))
        status, result = self.request('GET', '/api/shadow/authority/readiness')
        self.assertEqual(status, 200); self.assertTrue(result['ready'])
        self.assertEqual(result['mode'], 'postgres'); self.assertTrue(result['authoritative'])
        self.assertEqual(result['active_authority'], {'mode': 'postgres', 'authoritative': True, 'frozen': False})
        self.assertEqual(result['blockers'], [])
        self.assertTrue(all(gate['status'] == 'passed' for gate in result['gates']))


if __name__ == '__main__':
    unittest.main()
