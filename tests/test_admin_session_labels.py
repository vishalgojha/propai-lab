from types import SimpleNamespace
import pytest
from storage.supabase import SupabaseStorage

class Query:
    def __init__(self, client, table): self.client, self.table = client, table
    def select(self, value):
        assert '(' not in value, 'Ambiguous PostgREST embed must not return'
        return self
    def order(self, *args, **kwargs): return self
    def in_(self, column, values): self.values = values; return self
    def execute(self):
        if self.table == 'org_whatsapp_connections':
            if self.client.fail_sessions: raise RuntimeError('sessions unavailable')
            return SimpleNamespace(data=self.client.rows)
        self.client.batches.append(self.values)
        if self.client.fail_labels: raise RuntimeError('labels unavailable')
        return SimpleNamespace(data=[{'id': v, 'name': 'Workspace '+v} for v in self.values if v != 'missing'])

class Client:
    def __init__(self, rows, fail_labels=False, fail_sessions=False):
        self.rows=rows;self.fail_labels=fail_labels;self.fail_sessions=fail_sessions;self.batches=[]
    def table(self, table): return Query(self,table)

def run(client):
    storage=object.__new__(SupabaseStorage);storage._client=client
    return storage.list_all_whatsapp_connections()

def test_explicit_ids_keep_order_missing_and_cross_workspace_labels():
    rows=[{'id':1,'organization_id':'b'},{'id':2,'organization_id':'a'},{'id':3,'organization_id':'missing'},{'id':4,'organization_id':None}]
    result=run(Client(rows))
    assert [r['id'] for r in result]==[1,2,3,4]
    assert [r['organizations']['id'] if r['organizations'] else None for r in result]==['b','a',None,None]
    assert 'organizations' not in rows[0]

def test_label_failure_does_not_hide_sessions():
    result=run(Client([{'id':1,'organization_id':'a'}],fail_labels=True))
    assert result==[{'id':1,'organization_id':'a','organizations':None}]

def test_base_failure_propagates_not_false_empty():
    with pytest.raises(RuntimeError,match='sessions unavailable'):run(Client([],fail_sessions=True))

def test_empty_and_bounded_unique_batches():
    client=Client([]);assert run(client)==[];assert not client.batches
    client=Client([{'id':i,'organization_id':str(i)} for i in range(205)])
    assert len(run(client))==205;assert list(map(len,client.batches))==[100,100,5]

def test_production_rest_adapter_uses_two_unambiguous_gets():
    import httpx
    from storage.supabase import _RestClient
    requests=[]
    def handle(request):
        requests.append(request)
        if request.url.path.endswith('/org_whatsapp_connections'):
            if '(' in request.url.params.get('select',''):
                return httpx.Response(300,json={'code':'PGRST201'})
            return httpx.Response(200,json=[{'id':7,'organization_id':'workspace-a'}])
        assert request.url.path.endswith('/organizations')
        assert request.url.params['id']=='in.(workspace-a)'
        return httpx.Response(200,json=[{'id':'workspace-a','name':'Fixture'}])
    client=_RestClient('https://fixture.invalid','fixture-only')
    client._http=httpx.Client(transport=httpx.MockTransport(handle))
    result=run(client)
    assert len(requests)==2 and all(r.method=='GET' for r in requests)
    assert result[0]['organizations']['name']=='Fixture'
