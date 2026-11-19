import asyncio
from concurrent.futures import ThreadPoolExecutor
import json
from types import SimpleNamespace
import time

import pytest
from services.runtime_diagnostics import RuntimeDiagnostics


async def app(scope, receive, send):
    await send({'type':'http.response.start','status':200,'headers':[]})
    await send({'type':'http.response.body','body':b'ok'})


async def receive():
    return {'type':'http.request','body':b''}


async def send(message):
    pass


def scope(path='/api/phones'):
    return {'type':'http','path':path,'query_string':b'secret=do-not-log',
            'headers':[(b'authorization',b'Bearer never-log-this')]}


def test_default_off_no_task_no_logging(monkeypatch):
    monkeypatch.delenv('PROPAI_RUNTIME_DIAGNOSTICS',raising=False)
    records=[]
    diag=RuntimeDiagnostics(app, None, sink=records.append)
    asyncio.run(diag(scope(),receive,send))
    assert diag.task is None and records == []


def test_collects_loop_lag_and_real_executor_queue_then_self_stops():
    records=[]
    diag=RuntimeDiagnostics(app,None,enabled=True,window_seconds=2,sink=records.append)
    async def run():
        loop=asyncio.get_running_loop()
        loop.set_default_executor(ThreadPoolExecutor(max_workers=1))
        await diag(scope('/api/profile/123-private'),receive,send)
        await asyncio.sleep(.02)
        jobs=[asyncio.create_task(asyncio.to_thread(time.sleep,.65)) for _ in range(4)]
        await asyncio.sleep(.35)
        time.sleep(.4)  # Controlled synchronous handler blocking actual loop.
        await asyncio.gather(*jobs)
        await diag.task
        old=len(records)
        await diag(scope(),receive,send)
        assert len(records)==old
    asyncio.run(run())
    samples=[r for r in records if r['kind']=='sample']
    assert max(r['loop_lag_max_ms'] for r in samples)>150
    assert max(r['peaks'].get('executor_queued',0) for r in samples)>0
    assert records[-1]['kind']=='stopped'
    text=json.dumps(records)
    assert '123-private' not in text and 'do-not-log' not in text and 'never-log' not in text
    assert 'other' in text


def test_pool_snapshot_only_counts_never_requests():
    class Request:
        connection=None
        @property
        def url(self):
            pytest.fail('must not inspect private URL')
    pool=SimpleNamespace(_requests=[Request()],_connections=[object()],_max_connections=40)
    storage=SimpleNamespace(_real=SimpleNamespace(_client=SimpleNamespace(_http=SimpleNamespace(_transport=SimpleNamespace(_pool=pool)))))
    async def run():
        diag=RuntimeDiagnostics(app,storage,enabled=True)
        result=diag._snapshot(asyncio.get_running_loop())
        assert result['storage_http_unassigned']==1
        assert result['storage_http_max']==40
    asyncio.run(run())


def test_sampler_sink_failure_does_not_change_response():
    def fail(record):
        raise RuntimeError('broken logging')
    async def run():
        diag=RuntimeDiagnostics(app,None,enabled=True,window_seconds=1,sink=fail)
        await diag(scope(),receive,send)
        await diag.task
        assert diag.finished and diag.active==0
    asyncio.run(run())


def test_real_httpcore_pool_wait_snapshot_with_delayed_local_http():
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    import threading
    import httpx
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            time.sleep(.4)
            self.send_response(200);self.end_headers();self.wfile.write(b'ok')
        def log_message(self,*args):
            pass
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    client=httpx.Client(limits=httpx.Limits(max_connections=1))
    storage=SimpleNamespace(_real=SimpleNamespace(_client=SimpleNamespace(_http=client)))
    async def run():
        diag=RuntimeDiagnostics(app,storage,enabled=True)
        jobs=[asyncio.create_task(asyncio.to_thread(client.get,f'http://127.0.0.1:{server.server_port}/private-path?secret=never')) for _ in range(3)]
        await asyncio.sleep(.15)
        counts=diag._snapshot(asyncio.get_running_loop())
        assert counts['storage_http_max']==1
        assert counts['storage_http_outstanding']==3
        assert counts['storage_http_unassigned']==2
        await asyncio.gather(*jobs)
        assert diag._snapshot(asyncio.get_running_loop())['storage_http_outstanding']==0
    try:
        asyncio.run(run())
    finally:
        client.close();server.shutdown();server.server_close();thread.join()
