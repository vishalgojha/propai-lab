"""Local candidate for an assistant adapter, not a deployed connector or CLI.

The host must supply an authenticated HTTP transport and an approved durable
secret store. Never run connection creation/collection during a preview.
The store implementation is deliberately not a plaintext file fallback.
"""
from dataclasses import dataclass, field
from typing import Callable, Protocol
from urllib.parse import urlsplit


class SecretStore(Protocol):
    def save(self, name: str, value: str) -> None: ...
    def retrieve(self, name: str) -> str: ...


class SetupError(RuntimeError):
    pass


@dataclass(repr=False)
class PendingConnection:
    device_code: str = field(repr=False)
    approval_url: str
    user_code: str
    interval: int

    def __repr__(self):
        return 'PendingConnection(<private>)'


class AssistantConnection:
    """Host transport signature: (method,path,body,token)->(status,json).
    The host owns TLS, exact origin, timeouts, no-secret logs and scheduling.
    Methods do not print or return persistent credentials.
    """
    def __init__(self, transport: Callable, store: SecretStore):
        self.transport, self.store = transport, store
        self.pending = None
        self.workspace_id = None
        self.store_name = None

    def start(self):
        try:
            code, data = self.transport('POST', '/connect/sessions', {'label':'Instinct','write_access':False}, None)
        except Exception:
            raise SetupError('Could not start setup') from None
        if code != 201:
            raise SetupError('Could not start setup')
        url = urlsplit(str(data.get('connect_url', '')))
        if url.scheme != 'https' or url.netloc != 'app.propai.live' or url.path != '/connect' or url.username or url.password:
            raise SetupError('Approval destination was not recognized')
        device = data.get('device_code')
        if not isinstance(device,str) or len(device)<20:
            raise SetupError('Setup response was incomplete')
        self.store_name = 'PropAI connection ' + str(data.get('user_code',''))
        self.pending = PendingConnection(device,data['connect_url'],str(data.get('user_code','')),max(5,int(data.get('interval',5))))
        return {'approval_url':self.pending.approval_url,'user_code':self.pending.user_code,'interval':self.pending.interval,'state':'awaiting_approval'}

    def collect_and_check(self):
        if self.pending is None:
            raise SetupError('No approval is waiting')
        try:
            code,data = self.transport('GET','/connect/sessions/'+self.pending.device_code,None,None)
        except Exception:
            raise SetupError('Could not check approval. Do not start another connection yet.') from None
        if code == 202:
            return {'state':'awaiting_approval','retry_after':self.pending.interval}
        if code != 200 or data.get('status')!='approved':
            self.pending = None
            raise SetupError('Approval was declined, expired or could not be collected')
        value=data.get('token')
        self.pending=None  # One-use collection must never be repeated on failure.
        if not isinstance(value,str) or not value.startswith('ppai_'):
            raise SetupError('Connection details were incomplete')
        try:
            self.store.save(self.store_name,value)
            saved=self.store.retrieve(self.store_name)
            if saved != value:
                raise SetupError('Secure storage check failed')
        except Exception:
            raise SetupError('Secure storage did not complete. Review and remove unfinished access before retrying.') from None
        return self.check_saved()

    def check_saved(self):
        try:
            saved=self.store.retrieve(self.store_name)
            code,data=self.transport('GET','/connection-check',None,saved)
        except Exception:
            raise SetupError('Could not check the saved connection') from None
        if code!=200 or data.get('ok') is not True or data.get('groups_read_verified') is not True or not data.get('workspace_id'):
            raise SetupError('Read check failed. Connection is unfinished.')
        if self.workspace_id is not None and self.workspace_id != data['workspace_id']:
            raise SetupError('Account changed. Review access again.')
        self.workspace_id=data['workspace_id']
        return {'state':'read_verified','workspace_id':self.workspace_id,'checked_at':data.get('checked_at'),
                'groups_only':True,'live_capture_verified':False,'pool_verified':False}
