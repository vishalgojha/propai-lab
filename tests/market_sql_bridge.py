import json,os,sys
import psycopg2
from psycopg2.extras import RealDictCursor
r=json.load(sys.stdin)
c=psycopg2.connect(os.environ['MARKET_TEST_DSN']);c.autocommit=True
with c.cursor(cursor_factory=RealDictCursor) as q:
 q.execute(r['query'],r['args']);rows=q.fetchall() if q.description else []
 print(json.dumps(rows,default=str))
c.close()
