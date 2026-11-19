"""Opt-in disposable PostgreSQL + PostgREST real-handler latency experiment.
Run with: PYTHONPATH=. python tests/profile_auth_real_postgres.py
Uses its own database, drops it on exit. No production access.
"""
import asyncio
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import httpx
from routers import common, auth_org
from storage.supabase import SupabaseStorage

PSQL = '/usr/local/lib/python3.10/dist-packages/pgserver/pginstall/bin/psql'
DB = 'auth_latency_v4_test'
def sql(s, db=DB):
    return subprocess.check_output([PSQL,'-h','/tmp','-U','postgres','-d',db,'-v','ON_ERROR_STOP=1','-Atc',s],text=True)

async def run(storage):
    common.storage._real = storage
    user = {'id':'user-a','phone':'919876543210','email':'','user_metadata':{}}
    async def request():
        state = common._RequestMemoState(); token = common._REQUEST_READ_MEMO.set(state)
        start = time.monotonic()
        try:
            tid = await common.get_tenant_context(user,None)
            result = await auth_org.auth_me(user,tid)
            assert result['authenticated'] and tid == 'org-a'
            return round(time.monotonic()-start,3)
        finally:
            state.open=False;state.data.clear();common._REQUEST_READ_MEMO.reset(token)
    print('single_seconds',await request())
    print('four_concurrent_seconds', await asyncio.gather(*(request() for _ in range(4))))
    sql('delete from org_whatsapp_connections; delete from org_whatsapp_phone_directory;')
    await asyncio.gather(*(request() for _ in range(4)))
    assert sql('select count(*) from org_whatsapp_connections').strip() == '1'
    assert sql('select count(*) from org_whatsapp_phone_directory').strip() == '1'
    print('real_phone_concurrent_create_one', True)
    sql('delete from org_whatsapp_connections; delete from org_whatsapp_phone_directory;')
    await request()
    assert sql('select count(*) from org_whatsapp_connections').strip() == '1'
    print('delete_next_request_reprovision',True)


def main():
    sql(f'drop database if exists {DB}', 'postgres')
    sql(f'create database {DB}', 'postgres')
    process = None
    try:
        sql('''
        create table organizations(id text primary key, created_at timestamptz default now());
        create table organization_members(user_id text,organization_id text references organizations(id),is_active boolean);
        create table super_admins(id serial primary key,user_id text);
        create table org_whatsapp_connections(id serial primary key,organization_id text references organizations(id),phone_number text,instance_name text,broker_id text,extraction_status text,created_at timestamptz default now());
        create table org_whatsapp_phone_directory(id serial primary key,organization_id text references organizations(id),broker_id text,phone_number text,display_label text,is_active boolean,created_at timestamptz default now());
        insert into organizations(id) values('org-a');
        insert into organization_members values('user-a','org-a',true);
        insert into org_whatsapp_connections(organization_id,phone_number) values('org-a','919876543210');
        insert into org_whatsapp_phone_directory(organization_id,phone_number) values('org-a','919876543210');
        ''')
        with socket.socket() as sock:
            sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
        with tempfile.TemporaryDirectory() as tmp:
            conf=Path(tmp)/'postgrest.conf'
            conf.write_text(f'db-uri = "postgres://postgres@127.0.0.1:5432/{DB}"\ndb-schemas = "public"\ndb-anon-role = "postgres"\nserver-port = {port}\n')
            with open(Path(tmp)/'log','w+') as log:
                process=subprocess.Popen(['/tmp/pgrst/postgrest',str(conf)],stdout=log,stderr=log)
                for _ in range(100):
                    try:
                        r=httpx.get(f'http://127.0.0.1:{port}/organizations');r.raise_for_status();break
                    except Exception: time.sleep(.05)
                else:
                    log.seek(0);raise RuntimeError(log.read())
                # _RestClient appends /rest/v1. Strip only that prefix in a
                # real HTTP transport shim; method/query/body go to PostgREST.
                class PrefixTransport(httpx.BaseTransport):
                    def __init__(self): self.transport=httpx.HTTPTransport()
                    def handle_request(self,request):
                        request.url=request.url.copy_with(path=request.url.path.removeprefix('/rest/v1'))
                        time.sleep(.06)
                        return self.transport.handle_request(request)
                storage=SupabaseStorage(f'http://127.0.0.1:{port}','local-fixture')
                storage._client._http.close()
                storage._client._http=httpx.Client(transport=PrefixTransport(),headers={'Content-Type':'application/json','Prefer':'return=representation'})
                asyncio.run(run(storage))
    finally:
        if process:
            process.terminate();process.wait(timeout=5)
        sql(f'drop database {DB} with (force)', 'postgres')

if __name__ == '__main__': main()
