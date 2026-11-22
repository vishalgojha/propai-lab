import time
import pytest
from pydantic import ValidationError
from broker_market_policy import PropertySearch, redact_contacts, seal, unseal, search_bounds

@pytest.mark.parametrize('args', [{}, {'sender':'Alice'},{'query':'personal chats'}, {'locality':'9820056180'},{'building':'%foo%'},{'property_type':'office'},{'locality':'foo@example.com'}])
def test_query_denies_unscoped_contact_and_unknown_fields(args):
    with pytest.raises(ValidationError): PropertySearch(**args)

@pytest.mark.parametrize('args', [{'building':'Lodha World One'},{'locality':'Bandra'}, {'locality':'Mumbai district','property_type':'office'}, {'bedrooms':3,'transaction':'rent'}])
def test_useful_property_shapes(args):
    body=PropertySearch(**args)
    assert body.terms()

@pytest.mark.parametrize('text', ['Call +91 98200 56180','9820056180@s.whatsapp.net','https://wa.me/919820056180','me@example.com','９８２００５６１８０','123-456-7890'])
def test_contact_output_mask(text):
    out=redact_contacts(text)
    assert '98200' not in out and '456' not in out and '@' not in out and 'http' not in out


def test_references_bound_to_reader_kind_expiry_and_signature():
    token=seal({'kind':'option','reader':'a:k','exp':time.time()+10,'id':1},'test')
    assert unseal(token,'test',kind='option',reader='a:k')['id']==1
    for secret,kind,reader in [('bad','option','a:k'),('test','cursor','a:k'),('test','option','b:k')]:
        with pytest.raises(ValueError): unseal(token,secret,kind=kind,reader=reader)
    expired=seal({'kind':'option','reader':'a:k','exp':time.time()-1},'test')
    with pytest.raises(ValueError):unseal(expired,'test',kind='option',reader='a:k')


def test_cursor_query_binding():
    b=PropertySearch(building='Lodha')
    with pytest.raises(ValueError):search_bounds(b,{'query':'wrong'})
