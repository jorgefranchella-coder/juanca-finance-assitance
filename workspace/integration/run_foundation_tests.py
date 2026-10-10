"""Build and exercise isolated Wrangler data. Never seeds or mutates the live state."""
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import tempfile
import time
from urllib.request import Request,urlopen

ROOT=Path(__file__).resolve().parents[1]
WEB=ROOT/'apps/web'


def seed(state):
    databases=[p for p in state.rglob('*.sqlite') if 'd1' in p.parts and not p.name.startswith('metadata')]
    if len(databases)!=1:raise ValueError('Expected one isolated database')
    with sqlite3.connect(databases[0]) as db:
        for name,date,created,quantity in [('base','2026-08-01','2026-08-02',10),('stale','2026-07-01','2026-09-01',100)]:
            db.execute("INSERT INTO imports(id,user_id,owner,file_type,file_name,sha256,reference_date,object_key,record_count,status,created_at) VALUES(?,'fixture-family','Jorge','positions','fixture',?,?,?,1,'processed',?)",(name,name,date,'chat://fixture',created))
            payload={'kind':'position','owner':'Jorge','instrument_code':'PETR4','quantity':quantity,'unit_price':30,'market_value_cents':quantity*3000,'reference_date':date,'asset_class':'equity'}
            db.execute("INSERT INTO import_records(import_id,record_kind,source_sheet,source_row,payload) VALUES(?,'position','Fixture',1,?)",(name,json.dumps(payload)))
        db.execute("INSERT INTO imports(id,user_id,owner,file_type,file_name,sha256,reference_date,object_key,record_count,status) VALUES('usd','fixture-family','Julia','avenue_statement','fixture','usd','2026-08-01','chat://usd',1,'processed')")
        db.execute("INSERT INTO import_records(import_id,record_kind,source_sheet,source_row,payload) VALUES('usd','position','Fixture',1,?)",(json.dumps({'kind':'position','owner':'Julia','instrument_code':'AAPL','currency':'USD','quantity':2,'unit_price':225,'market_value_minor':45000,'reference_date':'2026-08-01','asset_class':'international_equity'}),))
        for suffix in ['1','2']:
            db.execute("INSERT INTO chat_messages(id,user_id,role,content,object_key,attachment_name) VALUES(?,'fixture-family','user','fixture',?,?)",('source-'+suffix,'chat://source-'+suffix,'correct-'+suffix+'.txt'))
            db.execute("INSERT INTO chat_messages(id,user_id,role,content) VALUES(?,'fixture-family','assistant','fixture')",('assistant-'+suffix,))
            db.execute("INSERT INTO transaction_proposals(id,message_id,source_message_id,user_id,owner,side,instrument_code,quantity,unit_price,currency,trade_date,source,confidence,evidence) VALUES(?,?,?,'fixture-family','Jorge','sell','PETR4',7,30,'BRL','2026-08-02','fixture',1,'fixture')",('proposal-'+suffix,'assistant-'+suffix,'source-'+suffix))


def main():
    config=WEB/'dist/server/wrangler.json'
    if not config.exists():raise SystemExit('Build first with npm run build in an isolated checkout')
    data=json.loads(config.read_text());data['d1_databases'][0]['migrations_dir']='../../drizzle';config.write_text(json.dumps(data))
    with tempfile.TemporaryDirectory(prefix='juanca-synthetic-') as name:
        root=Path(name);state=root/'state'
        tool=[str(WEB/'node_modules/.bin/wrangler')]
        subprocess.run(tool+['d1','migrations','apply','DB','--local','--config',str(config),'--persist-to',str(state)],cwd=WEB,check=True,stdout=subprocess.DEVNULL)
        seed(state)
        with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
        if port in (3040,3041,8644):raise ValueError('Reserved port')
        with (root/'worker.log').open('w') as log:
            process=subprocess.Popen(tool+['dev','--local','--config',str(config),'--ip','127.0.0.1','--port',str(port),'--persist-to',str(state)],cwd=WEB,stdout=log,stderr=log,start_new_session=True)
            try:
                base=f'http://127.0.0.1:{port}'
                for _ in range(100):
                    if process.poll() is not None:raise RuntimeError('Fixture Worker failed to start')
                    try:
                        with urlopen(Request(base+'/api/portfolio/positions',headers={'oai-authenticated-user-id':'fixture-family'}),timeout=1) as r:
                            if r.status==200:break
                    except OSError:time.sleep(0.2)
                else:raise RuntimeError('Fixture Worker not ready')
                env=dict(os.environ,JUANCA_TEST_WORKER_URL=base,JUANCA_TEST_STATE_PATH=str(state))
                subprocess.run(['python3','-m','unittest','discover','-s','integration','-p','test_foundation_http.py','-v'],cwd=ROOT,env=env,check=True)
            finally:
                import signal
                os.killpg(process.pid,signal.SIGTERM)
                try:process.wait(timeout=10)
                except subprocess.TimeoutExpired:os.killpg(process.pid,signal.SIGKILL);process.wait()

if __name__=='__main__':main()
