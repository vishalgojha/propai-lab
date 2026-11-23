"""Disposable local DB rehearsal. See docs/usage-tracking.md for requirements.

Mounts real search/usage routers, JWT verification and SupabaseStorage. Other
product routers/jobs are deliberately not started. PostgreSQL is PGlite behind
real PostgREST, not a hand-written response adapter. Run network-isolated.
"""
import json, os, sys, subprocess, tempfile, time, signal
from pathlib import Path
from datetime import datetime, timezone, timedelta
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
ORG='11111111-1111-1111-1111-111111111111'
USER='22222222-2222-2222-2222-222222222222'
OTHER='33333333-3333-3333-3333-333333333333'


def app():
    from fastapi import FastAPI
    from storage import SupabaseStorage
    from routers import common, search, usage
    import usage_events
    store=SupabaseStorage()
    common.storage._real=store
    usage_events._storage=store
    api=FastAPI(); api.include_router(search.router); api.include_router(usage.router)
    return api


def main():
    import httpx, jwt
    from storage.supabase import _typed_read_columns, _TYPED_LISTING_TABLE_NAMES
    required=['POSTGREST_BIN','PGLITE_MODULE','PGLITE_SOCKET_MODULE']
    for name in required:
        assert os.environ.get(name), f'{name} required'
    assert os.environ.get('USAGE_REHEARSAL_ISOLATED')=='1', 'Run in a network namespace with loopback enabled'
    evidence=Path(os.environ.get('EVIDENCE_DIR','/tmp/usage-db-evidence')); evidence.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='usage-db-') as tmp:
        tmp=Path(tmp); procs=[]; logs=[]
        schema="""
        create role anon nologin; create role authenticated nologin;
        create role service_role nologin bypassrls;
        grant usage on schema public to service_role;
        create table organizations(id uuid primary key,name text,slug text,is_active boolean,created_at timestamptz default now());
        create table organization_members(id serial primary key,organization_id uuid references organizations(id),user_id uuid,is_active boolean default true);
        create table super_admins(id serial primary key,user_id uuid);
        create table org_whatsapp_connections(id serial primary key,organization_id uuid references organizations(id),secondary_org_id uuid references organizations(id),phone_number text,is_active boolean,created_at timestamptz default now());
        create table org_whatsapp_phone_directory(id serial primary key,organization_id uuid,phone_number text,created_at timestamptz default now());
        create table buildings(id bigint,canonical_name text,address text,micro_market text,latitude numeric,longitude numeric);
        create table building_name_aliases(building_id bigint,alias text,canonical_name text);
        create table workspace_blocked_brokers(id bigserial primary key,organization_id uuid,broker_key text,broker_name text,broker_phone text,reason text,created_at timestamptz);
        """
        for table in _TYPED_LISTING_TABLE_NAMES:
            columns=_typed_read_columns(table).split(',')
            typed={c: ('bigint' if c in ('id','raw_message_id','listing_index','building_id','repost_count') else 'uuid' if c=='tenant_id' else 'timestamptz' if c in ('created_at','updated_at','last_seen_at','expires_at') else 'numeric' if c in ('monthly_rent','price','carpet_area_sqft') else 'text') for c in columns}
            schema += f'create table {table} (' + ','.join('"'+c+'" '+t for c,t in typed.items()) + ');\n'
        schema+=f"""
        insert into organizations(id,name,slug,is_active) values ('{ORG}','DB Rehearsal Realty','db-rehearsal',true),('{OTHER}','Never Searched Realty','never-searched',true);
        insert into organization_members(organization_id,user_id) values ('{ORG}','{USER}');
        insert into super_admins(user_id) values ('{USER}');
        insert into org_whatsapp_connections(organization_id,phone_number,is_active) values ('{ORG}','Unpaired:local-fixture',false);
        insert into residential_rent_listings(id,tenant_id,building_name,micro_market,bhk,monthly_rent,created_at,updated_at,transaction_type,asset_type) values (1,'{ORG}','DB Rehearsal Tower','Bandra West','3',125000,now(),now(),'rent','residential');
        """
        schema+=(ROOT/'supabase/migrations/20261122130000_broker_usage_events.sql').read_text()
        schema+='grant select on all tables in schema public to service_role;'
        (tmp/'seed.sql').write_text(schema)
        (tmp/'postgrest.conf').write_text('''db-uri = "postgresql://postgres@127.0.0.1:55431/postgres"
db-schemas = "public"
db-anon-role = "service_role"
db-pool = 1
db-prepared-statements = false
db-channel-enabled = false
server-host = "127.0.0.1"
server-port = 55432
''')
        env=os.environ.copy(); env.update(SUPABASE_URL='http://127.0.0.1:55432',SUPABASE_SERVICE_KEY='local-fixture-only',SUPABASE_JWT_SECRET='synthetic-local-test-signing-key-not-a-real-account')
        # Storage's production REST client adds /rest/v1. PostgREST's proxy-uri
        # does not mount it, so use its native OpenAPI path config via an actual
        # HTTP prefix proxy, preserving every request and response unchanged.
        def start(args,name,**kw):
            log=open(evidence/(name+'.log'),'w'); logs.append(log)
            p=subprocess.Popen(args,stdout=log,stderr=subprocess.STDOUT,env=env,**kw);procs.append(p);return p
        def wait(url):
            for _ in range(100):
                try:
                    r=httpx.get(url,timeout=.5)
                    if r.status_code<500:return
                except Exception:pass
                time.sleep(.1)
            raise RuntimeError('Not ready: '+url)
        try:
            start(['node',str(ROOT/'tests/usage_db_rehearsal_db.mjs'),str(tmp/'seed.sql')],'postgres')
            # Wait for the actual TCP socket, not a guessed startup delay.
            import socket
            for _ in range(100):
                try:
                    with socket.create_connection(('127.0.0.1',55431),timeout=.1):break
                except OSError:time.sleep(.1)
            start([env['POSTGREST_BIN'],str(tmp/'postgrest.conf')],'postgrest');wait('http://127.0.0.1:55432/')
            # Production REST base is /rest/v1, stripped by a transport-only
            # reverse proxy. No fixture data or database response is fabricated.
            (tmp/'prefix_proxy.py').write_text('''from fastapi import FastAPI, Request, Response
import httpx
api=FastAPI()
@api.api_route('/rest/v1/{path:path}',methods=['GET','POST','PATCH','DELETE','OPTIONS'])
async def proxy(path:str,request:Request):
    async with httpx.AsyncClient() as c:
        r=await c.request(request.method,'http://127.0.0.1:55432/'+path,params=request.query_params,content=await request.body(),headers={k:v for k,v in request.headers.items() if k.lower() not in ('host','authorization','apikey')})
    return Response(r.content,status_code=r.status_code,headers={k:v for k,v in r.headers.items() if k.lower() not in ('content-encoding','transfer-encoding','content-length')})
''')
            env['SUPABASE_URL']='http://127.0.0.1:55433'
            start([sys.executable,'-m','uvicorn','prefix_proxy:api','--host','127.0.0.1','--port','55433','--app-dir',str(tmp)],'prefix-proxy');wait('http://127.0.0.1:55433/rest/v1/')
            start([sys.executable,'-m','uvicorn','usage_db_rehearsal:app','--app-dir',str(ROOT/'tests'),'--factory','--host','127.0.0.1','--port','8138'], 'api',cwd=ROOT);wait('http://127.0.0.1:8138/openapi.json')
            token=jwt.encode({'sub':USER,'aud':'authenticated','exp':datetime.now(timezone.utc)+timedelta(hours=1)},env['SUPABASE_JWT_SECRET'],algorithm='HS256')
            headers={'Authorization':'Bearer '+token,'X-Tenant-ID':ORG}
            base='http://127.0.0.1:8138'
            c=httpx.Client(base_url=base,headers=headers,timeout=15)
            r=c.get('/api/admin/usage/brokers'); assert r.status_code==200,r.text
            before=r.json(); assert all(t['searches_last_7_days']==0 for t in before['tenants'])
            r=c.get('/api/search/market?q=DB%20Rehearsal'); assert r.status_code==200,r.text
            assert r.json()['total']==1,r.text
            assert r.json()['results'][0]['building_name']=='DB Rehearsal Tower',r.text
            # Wait for the real best-effort queue to persist; do not swap it
            # for a synchronous recorder or monkeypatch insert/query methods.
            for _ in range(100):
                stored=httpx.get('http://127.0.0.1:55432/broker_usage_events',timeout=5).json()
                if len(stored)==1:break
                time.sleep(.05)
            assert len(stored)==1,stored
            assert stored[0]['origin']=='app'
            assert set(stored[0])=={'id','tenant_id','surface','action','origin','created_at'}
            synthetic=[{'tenant_id':ORG,'surface':'assistant','origin':'assistant_unlabeled','action':'search'} for _ in range(1201)]
            seeded=httpx.post('http://127.0.0.1:55432/broker_usage_events',json=synthetic,timeout=15)
            assert seeded.status_code==201,seeded.text
            r=c.get('/api/admin/usage/brokers'); assert r.status_code==200,r.text
            after=r.json(); (evidence/'usage-db-summary.json').write_text(json.dumps(after,indent=2))
            by_id={t['tenant_id']:t for t in after['tenants']}
            assert by_id[ORG]['searches_last_7_days']==1 and by_id[OTHER]['searches_last_7_days']==0
            assert 'per_user' not in by_id[ORG]
            assert by_id[ORG]['assistant_unlabeled']['searches_last_7_days']==1201
            assert after['partial'] is False
            own=c.get('/api/usage/summary'); assert own.status_code==200,own.text
            assert own.json()['searches_last_7_days']==1,own.text
            assert own.json()['assistant_unlabeled']['searches_last_7_days']==1201,own.text
            assert httpx.get(base+'/api/admin/usage/brokers').status_code==401
            nonadmin=jwt.encode({'sub':OTHER,'aud':'authenticated','exp':datetime.now(timezone.utc)+timedelta(hours=1)},env['SUPABASE_JWT_SECRET'],algorithm='HS256')
            assert httpx.get(base+'/api/admin/usage/brokers',headers={'Authorization':'Bearer '+nonadmin}).status_code==403
            print('PASS real JWT -> search route -> production SupabaseStorage -> actual local PostgreSQL listing -> background queue -> actual usage row -> admin/workspace summaries; 1,201 separate assistant events across real pages; unauthenticated 401 and nonadmin 403',flush=True)
            ui=os.environ.get('USAGE_UI_DIR')
            if ui:
                session={'id':USER,'email':'fixture@example.invalid','aud':'authenticated','role':'authenticated','app_metadata':{},'user_metadata':{}}
                (tmp/'session.json').write_text(json.dumps({'user':session,'token':token}))
                start(['node','node_modules/next/dist/bin/next','start','-H','127.0.0.1','-p','3137'],'frontend',cwd=ui)
                wait('http://127.0.0.1:3137/admin/usage')
                subprocess.run(['node',str(ROOT/'tests/usage_db_rehearsal_ui.mjs'),str(tmp/'session.json'),str(evidence)],env=env,check=True)
        finally:
            for p in reversed(procs):
                p.terminate()
                try:p.wait(timeout=5)
                except subprocess.TimeoutExpired:p.kill();p.wait()
            for log in logs:log.close()

if __name__=='__main__': main()
