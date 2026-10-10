"""Archive only the selected old web conversation, never replay tools or actions."""
import argparse
import json
import os
from pathlib import Path
from juanca_chat import ChatStore


def main():
    os.umask(0o077)
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',type=Path,required=True)
    parser.add_argument('--session-file',type=Path,required=True)
    parser.add_argument('--credentials',type=Path,required=True)
    parser.add_argument('--destination',type=Path,required=True)
    args=parser.parse_args()
    session=json.loads(args.session_file.read_text())
    if isinstance(session,str):session_id=session
    else:session_id=session.get('session_id') or session.get('id')
    if not isinstance(session_id,str) or not session_id:raise ValueError('No selected web session')
    config=json.loads(args.credentials.read_text())
    count=ChatStore(args.destination).import_legacy(config['user_id'],args.source,session_id)
    print(json.dumps({'archived_messages':count,'actions_replayed':0}))

if __name__=='__main__':main()
