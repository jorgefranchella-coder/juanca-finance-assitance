"""Consistently export only the legacy cost-basis rows for a private in-memory preflight."""
import hashlib
import json
import os
import sqlite3
import sys
import tempfile

source=os.path.abspath(sys.argv[1])
with tempfile.NamedTemporaryFile(prefix='juanca-cost-basis-',suffix='.sqlite') as tmp:
    src=sqlite3.connect(f'file:{source}?mode=ro',uri=True)
    dst=sqlite3.connect(tmp.name)
    try: src.backup(dst)
    finally: src.close()
    rows=[]
    for row in dst.execute("SELECT id,owner,instrument_code,currency,quantity,average_unit_cost,as_of,source FROM cost_basis ORDER BY owner,instrument_code"):
        rows.append(dict(zip(['id','owner','instrument_code','currency','quantity','average_unit_cost','as_of','source'],row)))
    dst.close()
payload={'format':'juanca-cost-basis-v1','rows':rows}
canonical=json.dumps(payload,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
print(json.dumps({'sha256':hashlib.sha256(canonical).hexdigest(),'payload':payload},separators=(',',':'),ensure_ascii=False))
