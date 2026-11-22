import os,json,subprocess,sys,shutil
from pathlib import Path
from tests.test_broker_market_realpg import db,seeded

def test_existing_mcp_actual_wrapper_round_trip(seeded):
 c,_=seeded
 with c.cursor() as q:
  q.execute(Path('supabase/migrations/20261119100000_broker_market_mcp_reader_grants.sql').read_text())
  q.execute(Path('supabase/migrations/20261121100000_shared_read_default_and_review.sql').read_text())
  q.execute('select organization_id from organization_group_connections where id=11');org=str(q.fetchone()[0])
  q.execute('select id from auth.users limit 1');user=str(q.fetchone()[0])
 mcp=Path(os.environ.get('MARKET_MCP_DIR','/tmp/propai-cand-mcp/apps/mcp'))
 shutil.copyfile('tests/brokerMarketRealPg.run.mjs',mcp/'dist/brokerMarketRealPg.run.mjs')
 env={**os.environ,'MARKET_PYTHON':sys.executable,'MARKET_SQL_BRIDGE':str(Path('tests/market_sql_bridge.py').resolve()),'MARKET_TEST_DSN':c.dsn,'MARKET_OWNER':json.dumps([org,user])}
 result=subprocess.run(['node','--experimental-test-module-mocks','dist/brokerMarketRealPg.run.mjs'],cwd=mcp,env=env,text=True,capture_output=True)
 assert result.returncode==0,result.stdout+'\n'+result.stderr
 print(result.stdout)

def test_staged_indexes_are_concurrent_and_valid(seeded):
 c,_=seeded
 source=Path('ops/broker-market/indexes.concurrent.sql').read_text()
 assert source.count('create index concurrently ')==2
 with c.cursor() as q:
  q.execute("select indisvalid,indisready from pg_index where indexrelid in ('public.broker_market_source_time_idx'::regclass,'public.broker_market_text_fts_idx'::regclass)")
  assert q.fetchall()==[(True,True),(True,True)]
