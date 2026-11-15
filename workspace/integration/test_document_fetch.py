import asyncio, io, socket, time, unittest
from unittest.mock import patch
import document_fetch as d

class Response:
    def __init__(self, status=200, headers=None, body=b'%PDF-synthetic'):
        self.status, self.headers, self.body = status, headers or {}, io.BytesIO(body)
    def getheader(self, key, default=None): return self.headers.get(key, default)
    def read(self, n): return self.body.read(n)
class Conn:
    replies, calls, sock = [], [], None
    def __init__(self, host, port, ip, timeout): self.calls.append((host,port,ip))
    def request(self, method, target, headers): self.calls.append((method,target))
    def getresponse(self): return self.replies.pop(0)
    def close(self): pass

def fetch(url='https://example.test/?token=fixture'):
    return d.download(url, resolver=lambda *args: ['8.8.8.8'], connection=Conn)

class Tests(unittest.TestCase):
    def setUp(self):
        Conn.calls = []

    def test_redirect(self):
        Conn.replies = [Response(302, {'Location':'https://other.test/doc'}), Response()]
        self.assertEqual(fetch(), b'%PDF-synthetic')
        self.assertEqual([x[0] for x in Conn.calls if len(x)==3], ['example.test','other.test'])
    def test_status(self):
        for status, code in [(401,'authentication_required'),(403,'authentication_required'),(404,'expired_or_not_found'),(410,'expired_or_not_found'),(500,'network_error')]:
            Conn.replies = [Response(status)]
            with self.assertRaises(d.FetchError) as e: fetch()
            self.assertEqual(str(e.exception), code)
            self.assertNotIn('secret', str(e.exception))
    def test_redirect_block(self):
        Conn.replies = [Response(302, {'Location':'http://127.0.0.1/'})]
        with self.assertRaises(d.FetchError) as e: fetch()
        self.assertEqual(e.exception.code,'unsafe_destination')
        self.assertEqual(len(Conn.calls),2)
    def test_dns(self):
        for ip in ['127.0.0.1','10.0.0.1','169.254.169.254','::1','::ffff:8.8.8.8']:
            with patch.object(d,'_dns_lookup',return_value=['8.8.8.8',ip]):
                with self.assertRaises(d.FetchError) as e: d.resolve('example.test',443,time.monotonic()+1)
                self.assertEqual(e.exception.code,'unsafe_destination')
    def test_limits(self):
        for response, code in [(Response(200,{'Content-Length':str(d.MAX_BYTES+1)}),'size_limit'),(Response(body=b'html'),'unsupported_format')]:
            Conn.replies=[response]
            with self.assertRaises(d.FetchError) as e: fetch()
            self.assertEqual(e.exception.code,code)
        Conn.replies=[Response(302,{'Location':'/again'}) for _ in range(d.MAX_REDIRECTS+1)]
        with self.assertRaises(d.FetchError) as e: fetch()
        self.assertEqual(e.exception.code,'redirect_limit')
        with patch.object(d,'MAX_BYTES',8):
            Conn.replies=[Response(body=b'%PDF-123456')]
            with self.assertRaises(d.FetchError) as e: fetch()
            self.assertEqual(e.exception.code,'size_limit')
    def test_network_timeout(self):
        with patch.object(Conn,'request',side_effect=OSError('secret')):
            with self.assertRaises(d.FetchError) as e: fetch()
            self.assertEqual(str(e.exception),'network_error')
        with self.assertRaises(d.FetchError) as e: d.remaining(time.monotonic()-1)
        self.assertEqual(e.exception.code,'timeout')
    def test_tls(self):
        with patch.object(d.socket,'create_connection') as connect, patch.object(d.ssl,'create_default_context') as context:
            conn=d.PinnedHTTPSConnection('example.test',443,'8.8.8.8',4); conn.connect()
            connect.assert_called_once_with(('8.8.8.8',443),4)
            context.return_value.wrap_socket.assert_called_once_with(connect.return_value,server_hostname='example.test')
    def test_extract_synthetic_pdf(self):
        objects = [b'<< /Type /Catalog /Pages 2 0 R >>', b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>', b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
        stream = b'BT /F1 12 Tf 20 100 Td (Synthetic document) Tj ET'
        objects.append(b'<< /Length %d >>\nstream\n' % len(stream) + stream + b'\nendstream')
        pdf = bytearray(b'%PDF-1.4\n'); offsets = [0]
        for i, obj in enumerate(objects, 1):
            offsets.append(len(pdf)); pdf.extend(b'%d 0 obj\n' % i + obj + b'\nendobj\n')
        xref = len(pdf); pdf.extend(b'xref\n0 6\n0000000000 65535 f \n')
        for offset in offsets[1:]: pdf.extend(b'%010d 00000 n \n' % offset)
        pdf.extend(b'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n' % xref)
        self.assertIn('Synthetic document', d.read_pdf(bytes(pdf), time.monotonic()+5))
    def test_missing_tool_and_read(self):
        with patch.object(d.subprocess,'Popen',side_effect=FileNotFoundError()):
            with self.assertRaises(d.FetchError) as e: d.read_pdf(b'%PDF-test',time.monotonic()+2)
            self.assertEqual(e.exception.code,'tool_unavailable')
        with patch.object(d,'download',side_effect=d.FetchError('network_error')):
            result=d.retrieve('https://example.test/?secret=fixture')
            self.assertEqual(result['code'],'network_error'); self.assertNotIn('abc',str(result))
        with patch.object(d,'download',return_value=b'%PDF-test'), patch.object(d,'read_pdf',return_value='contenido sintético') as read:
            result=d.retrieve('https://example.test/')
            self.assertEqual(result['text'],'contenido sintético'); self.assertFalse(result['imported']); read.assert_called_once()
            self.assertNotIn('handle', result)
            self.assertNotIn('https://', str(result))

    def test_read_tool_is_registered_without_temporary_import_tool(self):
        # This checks registration on a new server; it does not imply activation in an existing MCP session.
        from test_mcp_postgres_authority import load_mcp_server
        server = load_mcp_server()
        if hasattr(server.mcp, 'registered_tools'):
            names = set(server.mcp.registered_tools)
        else:
            names = {tool.name for tool in asyncio.run(server.mcp.list_tools())}
        self.assertIn('leer_enlace_documental', names)
        self.assertIn('importar_documento', names)
        self.assertNotIn('importar_documento_temporario', names)

if __name__ == '__main__': unittest.main()
