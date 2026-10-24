#!/usr/bin/env python3
"""Read a local legacy D1 database consistently and emit only confirmation data."""
import hashlib
import json
import sqlite3
import sys
import tempfile
import os

source = os.path.abspath(sys.argv[1])
with tempfile.NamedTemporaryFile(prefix='juanca-confirmation-snapshot-', suffix='.sqlite') as tmp:
    src = sqlite3.connect(f'file:{source}?mode=ro', uri=True)
    dst = sqlite3.connect(tmp.name)
    try:
        src.backup(dst)
    finally:
        src.close()
    items = []
    for row in dst.execute("SELECT id,user_id,owner,category,title,context,evidence,actions,source_key,status,created_at,updated_at FROM confirmation_items ORDER BY user_id,created_at,id"):
        keys = ['id','legacy_user_id','owner','category','title','context','evidence','actions','source_key','status','created_at','updated_at']
        item = dict(zip(keys, row))
        for key in ['context','evidence','actions']:
            item[key] = json.loads(item[key])
        item['decisions'] = []
        for d in dst.execute("SELECT id,user_id,action_key,note,created_at FROM confirmation_decisions WHERE item_id=? AND user_id=? ORDER BY id", (item['id'], item['legacy_user_id'])):
            item['decisions'].append({'legacy_id': d[0], 'legacy_user_id': d[1], 'action_key': d[2], 'note': d[3], 'created_at': d[4]})
        items.append(item)
    dst.close()
payload = {'format':'juanca-confirmation-transfer-v1','items':items}
canonical = json.dumps(payload, sort_keys=True, separators=(',',':'), ensure_ascii=False).encode()
print(json.dumps({'sha256':hashlib.sha256(canonical).hexdigest(),'payload':payload},separators=(',',':'),ensure_ascii=False))
