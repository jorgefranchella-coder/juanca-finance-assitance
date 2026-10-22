"""Run against a Wrangler instance with synthetic data ONLY (see run_foundation_tests.py)."""
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sqlite3
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request,urlopen

ROOT=Path(__file__).parent
sys.path.insert(0,str(ROOT))
WORKER=os.environ.get('JUANCA_TEST_WORKER_URL')

def error_body(error):
    body=error.read()
    try:return json.loads(body)
    except (json.JSONDecodeError,UnicodeDecodeError):return {'non_json_response':body.decode(errors='replace')}

@unittest.skipUnless(WORKER, 'Run the synthetic harness; never point this at production.')
class FoundationHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert urlsplit(WORKER).hostname=='127.0.0.1' and urlsplit(WORKER).port not in (3040,3041,8644)
        cls.temp=tempfile.TemporaryDirectory();root=Path(cls.temp.name)
        shutil.copy(ROOT/'server.py',root/'server.py');shutil.copytree(ROOT/'browser-auth',root/'browser-auth')
        (root/'credentials.json').write_text(json.dumps({'password':'fixture','token':'fixture-token','user_id':'fixture-family'}))
        spec=importlib.util.spec_from_file_location('synthetic_gateway',root/'server.py');cls.gateway=importlib.util.module_from_spec(spec)
        with patch.dict(os.environ,{'JUANCA_WORKER_PORT':str(urlsplit(WORKER).port)}):spec.loader.exec_module(cls.gateway)
        cls.server=cls.gateway.ThreadingHTTPServer(('127.0.0.1',0),cls.gateway.Gateway)
        cls.thread=threading.Thread(target=cls.server.serve_forever,daemon=True);cls.thread.start()
        cls.base=f'http://127.0.0.1:{cls.server.server_port}'
    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown();cls.server.server_close();cls.thread.join();cls.temp.cleanup()
    def worker(self,path,body=None,user='fixture-family',form=None):
        headers={'oai-authenticated-user-id':user,'Content-Type':'application/json'}
        if form:
            boundary='foundation-fixture';headers['Content-Type']='multipart/form-data; boundary='+boundary
            payload=''.join(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n' for k,v in form.items())+f'--{boundary}--\r\n'
            data=payload.encode()
        else:data=json.dumps(body).encode() if body is not None else None
        try:
            with urlopen(Request(WORKER+path,data=data,headers=headers),timeout=20) as r:return r.status,json.load(r)
        except HTTPError as e:return e.code,error_body(e)
    def gateway_request(self,path,body=None,token=True,**extra):
        headers={'Authorization':'Bearer fixture-token'} if token else {}
        headers.update({'Content-Type':'application/json',**extra})
        try:
            with urlopen(Request(self.base+path,data=json.dumps(body).encode() if body is not None else None,headers=headers),timeout=25) as r:return r.status,json.load(r)
        except HTTPError as e:return e.code,error_body(e)
    def test_01_reference_dates_shared_totals_and_missing_fx(self):
        status,positions=self.worker('/api/portfolio/positions');self.assertEqual(status,200)
        status,dashboard=self.worker('/api/portfolio/dashboard');self.assertEqual(status,200)
        self.assertEqual(positions['portfolio_version'],dashboard['portfolio_version'])
        self.assertEqual(positions['total_value_cents'],180000);self.assertEqual(positions['total_value_cents'],dashboard['total_value_cents'])
        self.assertFalse(positions['valuation_complete'])
        usd=[p for p in positions['positions'] if p['currency']=='USD'];self.assertIsNone(usd[0]['market_value_cents'])
    def test_02_concurrent_distinct_sales_and_replay(self):
        _,view=self.worker('/api/portfolio/positions');revision=view['facts_revision']
        with ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda i:self.worker('/api/transactions/proposals/proposal-'+i,{'action':'approve','expected_revision':revision}),['1','2']))
        self.assertEqual(sorted(s for s,_ in results),[200,409])
        winner='1' if results[0][0]==200 else '2';self.__class__.winner=winner
        _,after=self.worker('/api/portfolio/positions');p=[p for p in after['positions'] if p['instrument_code']=='PETR4'][0]
        self.assertEqual(p['quantity'],3)
        status,replayed=self.worker('/api/transactions/proposals/proposal-'+winner,{'action':'approve','expected_revision':revision})
        self.assertEqual(status,200);self.assertTrue(replayed['replayed'])
        loser='2' if winner=='1' else '1'
        status,result=self.worker('/api/transactions/proposals/proposal-'+loser,{'action':'approve'})
        self.assertEqual(status,409);self.assertEqual(result['code'],'INSUFFICIENT_POSITION')
        self.assertEqual(self.worker('/api/transactions/proposals/proposal-'+winner,{'action':'approve'},user='other-family')[0],404)
    def test_03_source_link_and_no_guessed_settlement(self):
        # Validate through the same authenticated conversation API.
        status,result=self.worker('/api/transactions/chat');self.assertEqual(status,200)
        self.assertTrue(any(p['status']=='applied' for m in result['messages'] for p in m['proposals']))
        state=os.environ.get('JUANCA_TEST_STATE_PATH')
        if state:
            path=next(p for p in Path(state).rglob('*.sqlite') if 'd1' in p.parts and not p.name.startswith('metadata'))
            with sqlite3.connect(path.resolve().as_uri()+'?mode=ro',uri=True) as db:
                key,name,payload=db.execute("SELECT i.object_key,i.file_name,r.payload FROM imports i JOIN import_records r ON r.import_id=i.id WHERE i.file_type='chat_transaction'").fetchone()
                self.assertEqual(key,'chat://source-'+self.winner);self.assertEqual(name,'correct-'+self.winner+'.txt')
                self.assertIsNone(json.loads(payload)['settlement_date'])
    def test_04_spanish_creates_pending_draft_with_explicit_source(self):
        status,result=self.worker('/api/transactions/chat',form={'owner':'Julia','message':'Compré 2 AAPL a USD 225 en 02/08/2026, comisiones 1'})
        self.assertEqual(status,200)
        pending=[p for m in result['messages'] for p in m['proposals'] if p['owner']=='Julia']
        self.assertEqual(len(pending),1);self.assertEqual(pending[0]['status'],'pending');self.assertEqual(pending[0]['fees_minor'],100)
    def test_05_chat_http_requires_auth_and_never_contacts_hermes(self):
        self.assertEqual(self.gateway_request('/api/juanca/chat',token=False)[0],401)
        original=urlopen
        def restricted(req,**kwargs):
            parsed=urlsplit(req.full_url)
            self.assertEqual(parsed.hostname,'127.0.0.1');self.assertEqual(parsed.port,urlsplit(WORKER).port)
            self.assertTrue(parsed.path.startswith('/api/portfolio/'))
            return original(req,**kwargs)
        body={'request_id':'guided001','message':'¿Cuál es el patrimonio de Julia?','owner':'family'}
        with patch('juanca_chat.urlopen',side_effect=restricted) as network:
            status,result=self.gateway_request('/api/juanca/chat',body);self.assertEqual(status,200)
            self.assertFalse(result['hermes_required']);self.assertIn('incompleta',result['messages'][-1]['content']);network.assert_called_once()
            status,replay=self.gateway_request('/api/juanca/chat',body);self.assertEqual(status,200);self.assertTrue(replay['replayed']);network.assert_called_once()
            self.assertEqual(self.gateway_request('/api/juanca/chat',{**body,'message':'Other'})[0],409)
    def test_06_chat_transaction_only_opens_review_flow(self):
        body={'request_id':'guided002','message':'Comprei 2 PETR4 a R$ 30 em 02/08/2026','owner':'Jorge'}
        with patch('juanca_chat.urlopen',side_effect=AssertionError('No network for action')):
            status,result=self.gateway_request('/api/juanca/chat',body)
        self.assertEqual(status,200);self.assertEqual(result['messages'][-1]['actions'][0]['type'],'prepare_transaction')
        _,view=self.worker('/api/portfolio/positions');self.assertEqual([p for p in view['positions'] if p['instrument_code']=='PETR4'][0]['quantity'],3)
    def test_07_b3_upload_and_duplicate_use_existing_api_without_agent(self):
        with tempfile.TemporaryDirectory() as name:
            file=Path(name)/'fixture.xlsx'
            script="""import * as XLSX from 'xlsx'; import {writeFileSync} from 'node:fs';
                const book=XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([
                  ['Produto','Instituição','Código','Quantidade','Valor Atualizado MTM'],
                  ['CDB - FIXTURE - BANCO','BANCO','FIXTURE',2,1200]
                ]),'Renda Fixa');writeFileSync(process.argv[1], XLSX.write(book,{type:'buffer',bookType:'xlsx'}));"""
            subprocess.run(['node','--input-type=module','-e',script,str(file)],cwd=ROOT.parent/'apps/web',check=True)
            boundary='fixture-upload'
            parts=[]
            for key,value in {'owner':'Julia','kind':'positions','reference_date':'2026-08-01'}.items():
                parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode())
            parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="fixture.xlsx"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n'.encode()+file.read_bytes()+b'\r\n')
            parts.append(f'--{boundary}--\r\n'.encode())
            headers={'oai-authenticated-user-id':'fixture-family','Content-Type':'multipart/form-data; boundary='+boundary}
            for duplicate in (False,True):
                with urlopen(Request(WORKER+'/api/import/b3',data=b''.join(parts),headers=headers),timeout=20) as r:
                    result=json.load(r);self.assertEqual(r.status,200);self.assertEqual(result['duplicate'],duplicate);self.assertEqual(result['records'],1)

    def test_08_confirmation_queue_is_idempotent_scoped_and_audited(self):
        payload={
            'owner':'Jorge','category':'Fixture','title':'Synthetic confirmation',
            'context':{'instrumento':'FIXTURE'},'evidence':['synthetic evidence'],
            'actions':[{'key':'resolve','label':'Resolve'},
                       {'key':'later','label':'Check later','keeps_open':True}],
            'source_key':'fixture:confirmation:1',
        }
        status,created=self.worker('/api/portfolio/confirmations',payload)
        self.assertEqual(status,201);self.assertTrue(created['saved']);self.assertFalse(created['duplicate'])
        status,duplicate=self.worker('/api/portfolio/confirmations',payload)
        self.assertEqual(status,201);self.assertTrue(duplicate['duplicate']);self.assertEqual(duplicate['id'],created['id'])

        status,other_family=self.worker('/api/portfolio/confirmations',user='other-family')
        self.assertEqual(status,200);self.assertEqual(other_family['open_count'],0);self.assertEqual(other_family['items'],[])

        item_path='/api/portfolio/confirmations/'+created['id']
        status,updated=self.worker(item_path+'/context',{
            'context':{'instrumento':'FIXTURE','account_id':'fixture-account'},
            'evidence':['synthetic evidence','synthetic account attribution'],
        })
        self.assertEqual(status,200);self.assertTrue(updated['saved'])
        status,invalid=self.worker(item_path,{'action_key':'missing','note':'fixture'})
        self.assertEqual(status,400)
        status,kept_open=self.worker(item_path,{'action_key':'later','note':'fixture follow-up'})
        self.assertEqual(status,200);self.assertEqual(kept_open['status'],'open')
        status,listed=self.worker('/api/portfolio/confirmations')
        self.assertEqual(status,200);self.assertEqual(listed['open_count'],1)
        saved=next(item for item in listed['items'] if item['id']==created['id'])
        self.assertEqual(saved['context']['account_id'],'fixture-account')
        self.assertEqual(saved['decision']['action_key'],'later')
        self.assertEqual(saved['decision']['note'],'fixture follow-up')

        status,resolved=self.worker(item_path,{'action_key':'resolve','note':'fixture resolved'})
        self.assertEqual(status,200);self.assertEqual(resolved['status'],'resolved')
        status,closed_context=self.worker(item_path+'/context',{
            'context':{'instrumento':'FIXTURE'},'evidence':[],
        })
        self.assertEqual(status,409)
        status,final=self.worker('/api/portfolio/confirmations')
        self.assertEqual(status,200);self.assertEqual(final['open_count'],0)

    def test_09_later_owner_reference_keeps_earlier_maturity_and_same_day_buy_unapplied(self):
        status,result=self.worker('/api/portfolio/fixed-income-projection')
        self.assertEqual(status,200)
        jorge=next(item for item in result['items'] if item['instrument_code']=='FIXTURE-CDB-J')
        julia=next(item for item in result['items'] if item['instrument_code']=='FIXTURE-CDB-U')
        self.assertEqual((jorge['reference_date'],jorge['maturity_date']),('2026-08-01','2026-08-20'))
        self.assertEqual(julia['reference_date'],'2026-09-01')
        self.assertLess(jorge['maturity_date'],julia['reference_date'])
        self.assertEqual(jorge['observationCount'],1)
        self.assertNotIn('b3_movement',jorge['observation_sources'])

if __name__=='__main__':unittest.main()
