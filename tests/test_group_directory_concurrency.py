import asyncio
import threading
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from routers import whatsapp_group_controls as controls


def setup(monkeypatch, *, deny=False):
    calls = []
    owner_thread = threading.get_ident()
    async def permission(*args):
        calls.append('permission')
        if deny:
            raise HTTPException(403, 'denied')
    def check_thread(name):
        assert threading.get_ident() != owner_thread, name + ' blocks the event loop'
        assert calls[0] == 'permission'
        calls.append(name)
    monkeypatch.setattr(controls, '_require_org_permission', permission)
    monkeypatch.setattr(controls, '_connection', lambda *args: (check_thread('connection') or {'broker_id': 'phone'}))
    monkeypatch.setattr(controls, '_organization_has_unlimited_group_access', lambda *args: (check_thread('unlimited') or True))
    monkeypatch.setattr(controls, 'storage', SimpleNamespace(is_super_admin=lambda *args: (check_thread('admin') or True)))
    return calls, check_thread


def test_directory_and_cap_reads_parallel_off_loop_preserving_response(monkeypatch):
    calls, check = setup(monkeypatch)
    directory_started = threading.Event()
    cap_started = threading.Event()
    def directory(*args, **kwargs):
        check('directory')
        assert args == ('own', 'phone', 225)
        assert kwargs == {'include_overlap': False, 'allow_managed_selection': True}
        directory_started.set()
        assert cap_started.wait(2), 'cap lookup did not run concurrently'
        return [{'group_jid': 'fixture@g.us', 'connected': False}]
    def cap(*args, **kwargs):
        check('cap')
        assert args == ('own', 225) and kwargs == {'unlimited': True}
        cap_started.set()
        assert directory_started.wait(2)
        return {'selected_count': 0, 'cap': None}
    monkeypatch.setattr(controls, '_group_directory', directory)
    monkeypatch.setattr(controls, '_cap_state', cap)
    result = asyncio.run(controls.onboarding_groups(225, {'id': 'user'}, 'own'))
    assert result == {'groups': [{'group_jid': 'fixture@g.us', 'connected': False}], 'extraction_status': 'stopped', 'selected_count': 0, 'cap': None}
    assert set(calls) == {'permission', 'connection', 'unlimited', 'admin', 'directory', 'cap'}


def test_denied_request_does_not_read_directory_or_connection(monkeypatch):
    calls, _ = setup(monkeypatch, deny=True)
    with pytest.raises(HTTPException) as error:
        asyncio.run(controls.onboarding_groups(225, {'id': 'user'}, 'own'))
    assert error.value.status_code == 403
    assert calls == ['permission']


@pytest.mark.parametrize('failure', ['directory', 'cap', 'connection'])
def test_read_failure_is_unavailable_not_false_empty(monkeypatch, failure):
    setup(monkeypatch)
    def fail(*args, **kwargs):
        raise RuntimeError('fixture unavailable')
    monkeypatch.setattr(controls, '_group_directory', lambda *args, **kwargs: [])
    monkeypatch.setattr(controls, '_cap_state', lambda *args, **kwargs: {'selected_count': 0})
    monkeypatch.setattr(controls, {'directory': '_group_directory', 'cap': '_cap_state', 'connection': '_connection'}[failure], fail)
    with pytest.raises(HTTPException) as error:
        asyncio.run(controls.onboarding_groups(225, {'id': 'user'}, 'own'))
    assert error.value.status_code == 503
