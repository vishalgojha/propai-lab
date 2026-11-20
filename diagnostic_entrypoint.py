"""Temporary diagnostic entrypoint. Never changes the normal app module.

Off, malformed or expired configuration exports the original object unchanged.
This module needs an explicitly reviewed container command change to be used.
"""
import math
import os
import re
import time

from app import app as original_app
from services.correlated_timing import CorrelatedTiming


def configured_app(application, environ=None, now=None):
    env = os.environ if environ is None else environ
    current = time.time() if now is None else now
    run = env.get('PROPAI_DIAG_RUN', '')
    try:
        until = float(env.get('PROPAI_DIAG_UNTIL_MS', '0')) / 1000
    except (ValueError, TypeError, OverflowError):
        return application
    if not re.fullmatch(r'[a-f0-9]{16}', run) or not math.isfinite(until) or until <= current:
        return application
    return CorrelatedTiming(application, run_id=run, expiry=min(until, current + 180))


app = configured_app(original_app)
