"""Temporary bounded worker diagnostics. Off unless explicitly enabled.

Logs only aggregate counts/times and fixed route labels. Never logs headers,
bodies, identifiers, query values, storage URLs or exception text. Private
executor/httpcore counters are best-effort snapshots, not causal proof.
"""
import asyncio
from collections import defaultdict
import json
import logging
import os
import time

logger = logging.getLogger('propai.runtime_diagnostics')
LABELS = frozenset({
    '/api/auth/me', '/api/orgs/current', '/api/profile/sounds', '/api/profile',
    '/api/business-api/config', '/api/stats', '/api/extraction/progress',
    '/api/dashboard/whatsapp-status', '/api/phones', '/api/phone-directory',
    '/webhook', '/api/sync/status', '/health',
})


class RuntimeDiagnostics:
    def __init__(self, app, storage, enabled=None, *, window_seconds=180,
                 sample_seconds=.25, emit_seconds=1, sink=None):
        self.app = app
        self.storage = storage
        self.enabled = (os.getenv('PROPAI_RUNTIME_DIAGNOSTICS') == '1') if enabled is None else enabled
        # Hard bounds apply even to callers supplying constructor options.
        self.window = min(180, max(1, window_seconds))
        self.sample = max(.25, sample_seconds)
        self.emit = max(1, emit_seconds)
        self.sink = sink or self._log
        self.started = None
        self.task = None
        self.finished = False
        self.active = 0
        self.completed = defaultdict(lambda: [0, 0.0, 0.0])

    @staticmethod
    def _log(record):
        logger.warning('runtime_diag %s', json.dumps(record, separators=(',', ':')))

    def _emit(self, record):
        try:
            self.sink({'pid': os.getpid(), **record})
        except Exception:
            pass  # Diagnostics must never change an application result.

    def _snapshot(self, loop):
        result = {'active_http_requests': self.active}
        executor = getattr(loop, '_default_executor', None)
        if executor is not None:
            try:
                result.update(executor_max=executor._max_workers,
                              executor_threads=len(executor._threads),
                              executor_queued=executor._work_queue.qsize())
            except Exception:
                result['executor_snapshot_unavailable'] = True
        try:
            pool = self.storage._real._client._http._transport._pool
            # Copy only container references. Never inspect request URLs,
            # headers, bodies or stream content. Do not take a blocking lock.
            requests = tuple(pool._requests)
            connections = tuple(pool._connections)
            result.update(storage_http_outstanding=len(requests),
                          storage_http_unassigned=sum(r.connection is None for r in requests),
                          storage_http_connections=len(connections),
                          storage_http_max=pool._max_connections)
        except Exception:
            result['storage_snapshot_unavailable'] = True
        return result

    async def _sample_loop(self):
        loop = asyncio.get_running_loop()
        last_emit = loop.time()
        peak_lag = 0
        peaks = {}
        try:
            while loop.time() - self.started < self.window:
                expected = loop.time() + self.sample
                await asyncio.sleep(self.sample)
                now = loop.time()
                peak_lag = max(peak_lag, now - expected)
                current = self._snapshot(loop)
                for key, value in current.items():
                    if type(value) in (int, float):
                        peaks[key] = max(peaks.get(key, 0), value)
                    else:
                        peaks[key] = value
                if now-last_emit >= self.emit:
                    completed = dict(self.completed)
                    self.completed.clear()
                    self._emit({'kind': 'sample', 'elapsed_s': round(now-self.started, 3),
                                'loop_lag_max_ms': round(peak_lag*1000, 2),
                                'peaks': peaks, 'completed': completed})
                    peak_lag = 0
                    peaks = {}
                    last_emit = now
        finally:
            self.finished = True
            self.completed.clear()
            self._emit({'kind': 'stopped', 'reason': 'bounded_window_or_shutdown'})

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http' or not self.enabled or self.finished:
            return await self.app(scope, receive, send)
        loop = asyncio.get_running_loop()
        if self.started is None:
            self.started = loop.time()
            self.task = asyncio.create_task(self._sample_loop())
            self._emit({'kind': 'started', 'window_s': self.window,
                        'sample_s': self.sample, 'emit_s': self.emit})
        if loop.time()-self.started >= self.window:
            return await self.app(scope, receive, send)
        label = scope.get('path', '')
        if label not in LABELS:
            label = 'other'
        self.active += 1
        start = time.monotonic()
        try:
            return await self.app(scope, receive, send)
        finally:
            self.active -= 1
            if not self.finished:
                elapsed = round((time.monotonic()-start)*1000, 2)
                bucket = self.completed[label]
                bucket[0] += 1
                bucket[1] += elapsed
                bucket[2] = max(bucket[2], elapsed)
