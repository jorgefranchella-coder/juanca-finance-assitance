"""Read one coherent SQLite snapshot; never writes the source database."""
import argparse,hashlib,json,os,sqlite3
from pathlib import Path
from datetime import datetime,timezone
TABLES=['imports','import_records','review_decisions','cost_basis','market_quotes','chat_messages','transaction_proposals','portfolio_revisions','proposal_applications','fx_observations']
def export(source,target,chat=None):
 with sqlite3.connect(source.resolve().as_uri()+'?mode=ro',uri=True) as db:
  db.row_factory=sqlite3.Row;db.execute('BEGIN')
  if db.execute('PRAGMA integrity_check').fetchone()[0]!='ok':raise ValueError('Source integrity')
  tables={name:[dict(row) for row in db.execute('SELECT * FROM '+name+' ORDER BY rowid')] for name in TABLES}
  db.rollback()
 archives=[]
 if chat:
  with sqlite3.connect(chat.resolve().as_uri()+'?mode=ro',uri=True) as db:
   db.row_factory=sqlite3.Row
   archives=[dict(row) for row in db.execute('SELECT * FROM messages ORDER BY seq')]
 content={'format':1,'tables':tables,'conversation_archive':archives}
 canonical=json.dumps(content,ensure_ascii=False,sort_keys=True,separators=(',',':'))
 envelope={'source_sha256':hashlib.sha256(canonical.encode()).hexdigest(),'exported_at':datetime.now(timezone.utc).isoformat(),'canonical_content':canonical,'content':content}
 target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
 fd=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(fd,'w') as stream:json.dump(envelope,stream,ensure_ascii=False)
 print(json.dumps({'exported':True,'counts':{k:len(v) for k,v in tables.items()},'archive_messages':len(archives)}))
if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--source',type=Path,required=True);p.add_argument('--destination',type=Path,required=True);p.add_argument('--chat',type=Path);a=p.parse_args();export(a.source,a.destination,a.chat)
