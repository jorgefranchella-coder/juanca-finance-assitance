"""Exercise the real FastMCP dispatch and argument validation, with synthetic portfolio data."""
import importlib.util
import json
import unittest
from pathlib import Path
from unittest.mock import patch


def load():
    path = Path(__file__).with_name('mcp_server.py')
    spec = importlib.util.spec_from_file_location('juanca_real_mcp_test', path)
    module = importlib.util.module_from_spec(spec)
    original = Path.read_text
    def read_text(file, *args, **kwargs):
        return json.dumps({'token': 'synthetic', 'user_id': 'fixture'}) if file == path.parent / 'credentials.json' else original(file, *args, **kwargs)
    with patch.object(Path, 'read_text', read_text): spec.loader.exec_module(module)
    return module


class MaturityDispatchTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.app = load()
        self.items = [{'owner': owner, 'instrument_code': code, 'maturity_date': day, 'institution': 'Fixture', 'currency': 'BRL'}
                      for owner,code,day in [('Julia','J1','2026-11-10'),('Jorge','A1','2026-11-11'),('Julia','J2','2026-11-12'),('Jorge','A2','2026-11-13'),('Julia','J3','2026-11-14'),('Jorge','A3','2026-11-15'),('Jorge','A4','2026-11-16')]]
        self.authority = patch.object(self.app, 'authority_mode', return_value='postgres');self.authority.start()
        self.api = patch.object(self.app, 'api', return_value={'items':self.items});self.api_mock=self.api.start()
        self.addCleanup(self.authority.stop);self.addCleanup(self.api.stop)
    async def call(self, args):
        with patch.object(self.app.mcp, 'get_context', return_value=None):
            blocks = await self.app.mcp.call_tool('consultar_vencimientos', args)
            return json.loads(blocks[0].text)
    async def test_spanish_portuguese_alias_and_cursor_keep_owner(self):
        for field in ('propietario','proprietario'):
            args={field:'Jorge','fecha_corte':'2026-11-09','horizonte_dias':365,'limite':3}
            result=await self.call(args)
            self.assertEqual(result['filtro']['titular'],'Jorge')
            self.assertEqual([v['instrumento'] for v in result['vencimientos']],['A1','A2','A3'])
            self.assertTrue(result['siguiente_cursor'])
            next_page=await self.call({**args,'cursor':result['siguiente_cursor']})
            self.assertEqual(next_page['filtro']['titular'],'Jorge')
            self.assertEqual([v['instrumento'] for v in next_page['vencimientos']],['A4'])
        family=await self.call({'fecha_corte':'2026-11-09','limite':3})
        self.assertIsNone(family['filtro']['titular'])
        self.assertEqual([v['instrumento'] for v in family['vencimientos']],['J1','A1','J2'])
    async def test_unknown_and_conflicting_fields_fail_without_api_call(self):
        for args in ({'proprietar':'Jorge'}, {'propietario':'Jorge','proprietario':'Julia'}):
            with self.assertRaises(Exception): await self.call(args)
        self.api_mock.assert_not_called()
        tool=self.app.mcp._tool_manager.get_tool('consultar_vencimientos')
        self.assertFalse(tool.parameters.get('additionalProperties',True))
    async def test_filter_mismatch_fails_closed(self):
        with patch.object(self.app,'_compact_maturities',return_value={'filtro':{'titular':None}}):
            with self.assertRaises(Exception): await self.call({'propietario':'Jorge'})
