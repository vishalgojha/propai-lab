"""Preparation only. Opt-in correlated ASGI timing, no auth/data behavior changes.

Wrap the app outermost so admission precedes auth/tenant dependencies. This
cannot measure time BEFORE the ASGI app is entered or after socket handoff.
"""
import asyncio
import json
import logging
import os
import re
import time

PATHS = frozenset(('/api/auth/me', '/api/phones', '/api/dashboard/whatsapp-status',
                   '/api/extraction/progress', '/api/stats'))
HEADER = b'x-propai-diag-id'
logger = logging.getLogger('propai.correlated_timing')


class CorrelatedTiming:
    def __init__(self, app, *, run_id='', expiry=0, max_requests=50,
                 sink=None, clock=time.time, monotonic=time.monotonic):
        self.app = app
        self.run_id = run_id if re.fullmatch(r'[a-f0-9]{16}', run_id or '') else ''
        self.clock, self.monotonic = clock, monotonic
        self.expiry = min(float(expiry), clock() + 180)
        self.max_requests = min(max(1, max_requests), 50)
        self.count = 0
        self.sink = sink or (lambda record: logger.warning('correlated_timing %s', json.dumps(record)))

    def emit(self, record):
        try:
            self.sink(record)
        except Exception:
            pass  # Diagnostics may not change the response or cancellation.

    async def __call__(self, scope, receive, send):
        if (scope['type'] != 'http' or scope.get('method') != 'GET'
                or scope.get('path') not in PATHS or not self.run_id
                or self.clock() >= self.expiry or self.count >= self.max_requests):
            return await self.app(scope, receive, send)
        ids = [v for k, v in scope.get('headers', []) if k.lower() == HEADER]
        value = ids[0].decode('ascii', errors='ignore') if len(ids) == 1 else ''
        if not re.fullmatch(self.run_id + r'-[a-f0-9]{16}', value):
            return await self.app(scope, receive, send)
        self.count += 1  # No await before cap increment, atomic in one event loop.
        start = self.monotonic()
        common = {'trace': value, 'path': scope['path'], 'pid': os.getpid()}
        self.emit({**common, 'stage': 'api_admit', 'wall_ms': round(self.clock()*1000)})
        first = False
        ended = False
        status = None

        async def measured_send(message):
            nonlocal first, ended, status
            if message['type'] == 'http.response.start' and not first:
                first = True
                status = message['status']
                self.emit({**common, 'stage': 'api_headers', 'wall_ms': round(self.clock()*1000),
                           'elapsed_ms': round((self.monotonic()-start)*1000, 2), 'status': status})
            await send(message)
            if message['type'] == 'http.response.body' and not message.get('more_body', False):
                ended = True

        outcome = 'completed'
        try:
            await self.app(scope, receive, measured_send)
        except asyncio.CancelledError:
            outcome = 'cancelled'
            raise
        except BaseException:
            outcome = 'raised'
            raise
        finally:
            self.emit({**common, 'stage': 'api_end', 'wall_ms': round(self.clock()*1000),
                       'elapsed_ms': round((self.monotonic()-start)*1000, 2),
                       'status': status, 'body_sent': ended, 'outcome': outcome})
