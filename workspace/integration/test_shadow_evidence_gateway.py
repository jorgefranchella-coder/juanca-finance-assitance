"""Exercise the authenticated gateway-to-shadow evidence path without financial data."""
import hashlib
import http.client
import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import server


class ShadowStub(BaseHTTPRequestHandler):
    calls = []

    def log_message(self, *args):
        pass

    def do_POST(self):
        body = self.rfile.read(int(self.headers['Content-Length']))
        self.calls.append((self.command, self.path, body, dict(self.headers)))
        response = json.dumps({'upload_id': '12345678-1234-1234-1234-123456789abc'}).encode()
        self.send_response(202 if self.path.endswith(('/photos', '/documents')) else 201)
        self.send_header('Content-Length', str(len(response)))
        self.end_headers()
        self.wfile.write(response)

    def do_GET(self):
        self.calls.append((self.command, self.path, b'', dict(self.headers)))
        response = json.dumps({'position_count': 1, 'positions': [], 'status_counts': {}, 'portfolio_changed': False}).encode()
        self.send_response(200)
        self.send_header('Content-Length', str(len(response)))
        self.end_headers()
        self.wfile.write(response)

    def do_PUT(self):
        body = self.rfile.read(int(self.headers['Content-Length']))
        self.calls.append((self.command, self.path, body, dict(self.headers)))
        response = b'{"status":"stored"}'
        self.send_response(201)
        self.send_header('Content-Length', str(len(response)))
        self.end_headers()
        self.wfile.write(response)


class GatewayEvidenceTest(unittest.TestCase):
    def test_acquisition_reconciliation_is_forwarded_to_authenticated_shadow_api(self):
        with tempfile.TemporaryDirectory() as root:
            stub = ThreadingHTTPServer(('127.0.0.1', 0), ShadowStub)
            gateway = ThreadingHTTPServer(('127.0.0.1', 0), server.Gateway)
            old = server.SHADOW_CONFIG_PATH
            server.SHADOW_CONFIG_PATH = Path(root) / 'shadow.json'
            server.SHADOW_CONFIG_PATH.write_text(json.dumps({'token': 'x' * 64, 'port': stub.server_port}))
            ShadowStub.calls = []
            threads = [threading.Thread(target=s.serve_forever, daemon=True) for s in (stub, gateway)]
            for thread in threads:
                thread.start()
            try:
                connection = http.client.HTTPConnection('127.0.0.1', gateway.server_port)
                connection.request('GET', '/api/shadow/position-identities/acquisition-reconciliation', headers={
                    'Authorization': 'Bearer ' + server.CONFIG['token'],
                })
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                self.assertEqual(json.loads(response.read())['portfolio_changed'], False)
                connection.close()
                self.assertEqual(len(ShadowStub.calls), 1)
                command, path, _, headers = ShadowStub.calls[0]
                self.assertEqual(command, 'GET')
                self.assertEqual(path, '/v1/position-identities/acquisition-reconciliation')
                self.assertEqual(headers['Authorization'], 'Bearer ' + 'x' * 64)
            finally:
                server.SHADOW_CONFIG_PATH = old
                gateway.shutdown()
                stub.shutdown()
                gateway.server_close()
                stub.server_close()
                for thread in threads:
                    thread.join(timeout=2)

    def test_photo_is_hashed_and_stored_through_two_shadow_calls(self):
        with tempfile.TemporaryDirectory() as root:
            stub = ThreadingHTTPServer(('127.0.0.1', 0), ShadowStub)
            gateway = ThreadingHTTPServer(('127.0.0.1', 0), server.Gateway)
            old = server.SHADOW_CONFIG_PATH
            server.SHADOW_CONFIG_PATH = Path(root) / 'shadow.json'
            server.SHADOW_CONFIG_PATH.write_text(json.dumps({'token': 'x' * 64, 'port': stub.server_port}))
            ShadowStub.calls = []
            threads = [threading.Thread(target=s.serve_forever, daemon=True) for s in (stub, gateway)]
            for thread in threads:
                thread.start()
            try:
                image = b'\x89PNG\r\n\x1a\nsynthetic-image'
                connection = http.client.HTTPConnection('127.0.0.1', gateway.server_port)
                connection.request('POST', '/api/shadow/evidence/photo-file', body=image, headers={
                    'Authorization': 'Bearer ' + server.CONFIG['token'],
                    'Content-Type': 'image/png',
                    'X-Juanca-Owner': 'Jorge',
                    'X-Juanca-File-Name': 'sample.png',
                    'X-Juanca-Request-Id': 'gateway-test.photo',
                })
                response = connection.getresponse()
                self.assertEqual(response.status, 201)
                response.read()
                connection.close()
                self.assertEqual(len(ShadowStub.calls), 2)
                first = json.loads(ShadowStub.calls[0][2])
                self.assertEqual(first['content_sha256'], hashlib.sha256(image).hexdigest())
                self.assertEqual(first['owner'], 'Jorge')
                self.assertEqual(ShadowStub.calls[1][2], image)
                self.assertEqual(ShadowStub.calls[1][1], '/v1/evidence/photos/12345678-1234-1234-1234-123456789abc/content')
            finally:
                server.SHADOW_CONFIG_PATH = old
                gateway.shutdown()
                stub.shutdown()
                gateway.server_close()
                stub.server_close()
                for thread in threads:
                    thread.join(timeout=2)

    def test_b3_document_keeps_report_date_and_original_hash(self):
        with tempfile.TemporaryDirectory() as root:
            stub = ThreadingHTTPServer(('127.0.0.1', 0), ShadowStub)
            gateway = ThreadingHTTPServer(('127.0.0.1', 0), server.Gateway)
            old = server.SHADOW_CONFIG_PATH
            server.SHADOW_CONFIG_PATH = Path(root) / 'shadow.json'
            server.SHADOW_CONFIG_PATH.write_text(json.dumps({'token': 'x' * 64, 'port': stub.server_port}))
            ShadowStub.calls = []
            threads = [threading.Thread(target=s.serve_forever, daemon=True) for s in (stub, gateway)]
            for thread in threads:
                thread.start()
            try:
                document = b'PK\x03\x04synthetic-xlsx'
                connection = http.client.HTTPConnection('127.0.0.1', gateway.server_port)
                connection.request('POST', '/api/shadow/evidence/document-file', body=document, headers={
                    'Authorization': 'Bearer ' + server.CONFIG['token'],
                    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                    'X-Juanca-Owner': 'Jorge', 'X-Juanca-Source': 'b3',
                    'X-Juanca-File-Type': 'positions',
                    'X-Juanca-File-Name': 'posicao-2026-10-09.xlsx',
                    'X-Juanca-Request-Id': 'gateway-b3-001',
                    'X-Juanca-Reference-Date': '2026-10-09',
                })
                response = connection.getresponse()
                self.assertEqual(response.status, 201)
                response.read()
                connection.close()
                self.assertEqual(len(ShadowStub.calls), 2)
                first = json.loads(ShadowStub.calls[0][2])
                self.assertEqual(first['source'], 'b3')
                self.assertEqual(first['file_type'], 'positions')
                self.assertEqual(first['reference_date'], '2026-10-09')
                self.assertEqual(first['content_sha256'], hashlib.sha256(document).hexdigest())
                self.assertEqual(ShadowStub.calls[1][2], document)
            finally:
                server.SHADOW_CONFIG_PATH = old
                gateway.shutdown()
                stub.shutdown()
                gateway.server_close()
                stub.server_close()
                for thread in threads:
                    thread.join(timeout=2)


if __name__ == '__main__':
    unittest.main()
