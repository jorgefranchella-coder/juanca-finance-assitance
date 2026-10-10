from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import Mock
from juanca_chat import ChatStore, answer

class JuancaChatTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.store=ChatStore(Path(self.temp.name)/'chat.db')
    def tearDown(self): self.temp.cleanup()
    def test_reads_allowlisted_views_and_reports_partial_valuation(self):
        api=Mock(return_value={'owners':[{'owner':'Julia','value_cents':30000}], 'valuation_complete':False, 'reference_date':'2026-08-01','portfolio_version':'fixture'})
        result=answer('¿Cuál es el patrimonio de Julia?', 'family',api)
        api.assert_called_once_with('/api/portfolio/dashboard')
        self.assertIn('Julia',result['content']);self.assertIn('incompleta',result['content'])
        self.assertEqual(result['evidence']['portfolio_version'],'fixture')
    def test_action_messages_never_mutate_portfolio(self):
        api=Mock(side_effect=AssertionError('No API allowed for an action'))
        result=answer('Comprei 2 PETR4 a R$ 30 em 02/08/2026','Jorge',api)
        self.assertEqual(result['actions'][0]['type'],'prepare_transaction')
        self.assertEqual(answer('Aprovar proposta 12','Jorge',api)['actions'][0]['type'],'open_transactions')
        api.assert_not_called()
    def test_idempotency_survives_restart_and_rejects_payload_mismatch(self):
        state,lease=self.store.reserve('family','request001','Resumo','family')
        self.assertEqual(state,'ready');self.assertTrue(self.store.finish('family','request001',lease,{'content':'fixture'}))
        restarted=ChatStore(self.store.path)
        self.assertEqual(restarted.reserve('family','request001','Resumo','family')[0],'done')
        self.assertEqual(restarted.reserve('family','request001','Outro','family')[0],'mismatch')
        self.assertEqual(len(restarted.history('family')),2)
    def test_expired_worker_cannot_finish_new_lease(self):
        state,old=self.store.reserve('family','request001','Resumo','family')
        self.assertEqual(self.store.reserve('family','request002','Carteira','family')[0],'busy')
        with self.store.connect() as db: db.execute('UPDATE requests SET started=0')
        state,new=self.store.reserve('family','request001','Resumo','family')
        self.assertEqual(state,'ready');self.assertNotEqual(old,new)
        self.assertFalse(self.store.finish('family','request001',old,{'content':'old'}))
        self.assertTrue(self.store.finish('family','request001',new,{'content':'new'}))
    def test_history_and_queries_are_scoped(self):
        state,lease=self.store.reserve('a','request001','Resumo','family');self.store.finish('a','request001',lease,{'content':'A'})
        self.assertEqual(self.store.history('b'),[])
        api=Mock(return_value={'positions':[{'owner':'Jorge','instrument_code':'PETR4','quantity':1,'market_value_cents':3000},{'owner':'Julia','instrument_code':'AAPL','quantity':1,'market_value_cents':None,'market_value_minor':45000,'currency':'USD'}]})
        result=answer('Qual a carteira da Julia?','family',api)
        self.assertIn('US$ 450,00',result['content']);self.assertNotIn('PETR4',result['content'])
    def test_legacy_import_selects_only_web_session_and_is_idempotent(self):
        path=Path(self.temp.name)/'legacy.db'
        with sqlite3.connect(path) as db:
            db.execute('CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,content TEXT,timestamp REAL)')
            db.executemany('INSERT INTO messages VALUES(?,?,?,?,0)',[(1,'web','user','Hello'),(2,'web','assistant','Reply'),(3,'telegram','user','Private'),(4,'web','tool','Hidden')])
        self.store.import_legacy('family',path,'web');self.store.import_legacy('family',path,'web')
        rows=self.store.history('family');self.assertEqual(len(rows),2)
        self.assertTrue(all(r['origin']=='hermes_archive' and r['archived'] for r in rows))
    def test_unknown_question_discloses_guided_mode(self):
        api=Mock();r=answer('Tell me a joke','family',api)
        api.assert_not_called();self.assertIn('não está configurada',r['content'])

if __name__=='__main__': unittest.main()
