"""Exact already deployed MCP78eb, no new MCP production code."""
import os,json,subprocess,sys,shutil
from pathlib import Path
from tests.test_independent_raw_sharing import db,seeded,grant,message


def test_independent_raw_source_to_zero_phone_reader_through_actual_mcp(seeded):
 c,a,b,u,v=seeded
 with c.cursor() as q:
  q.execute(Path('supabase/migrations/20261119100000_broker_market_mcp_reader_grants.sql').read_text())
  q.execute('delete from org_whatsapp_connections where id=2')
  q.execute('select count(*) from org_whatsapp_connections where organization_id=%s',(b,));assert q.fetchone()[0]==0
  q.execute('select count(*) from raw_messages where tenant_id=%s',(b,));assert q.fetchone()[0]==0
 grant(seeded);message(seeded)
 mcp=Path(os.environ['MARKET_MCP_DIR'])
 shutil.copyfile('tests/independentRawMcp.run.mjs',mcp/'dist/independentRawMcp.run.mjs')
 env={**os.environ,'MARKET_PYTHON':sys.executable,'MARKET_SQL_BRIDGE':str(Path('tests/market_sql_bridge.py').resolve()),'MARKET_TEST_DSN':c.dsn,'MARKET_OWNER':json.dumps([b,v]),'MARKET_SOURCE':json.dumps([a,u])}
 result=subprocess.run(['node','--experimental-test-module-mocks','dist/independentRawMcp.run.mjs'],cwd=mcp,env=env,text=True,capture_output=True)
 assert result.returncode==0,result.stdout+'\n'+result.stderr
 print(result.stdout)
