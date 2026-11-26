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


# --- Share-class boundaries, grounded in the live broker directory ----------
# Names below are real group names from the production directory. The rule:
# property-listing groups classify property; personal/social/religious/food/
# wellness groups classify non_property and can never be shared; industry
# chatter (proptech events, founder circles) and product/broadcast groups
# stay unclear and need an explicit per-group include.

import broker_market_policy as policy


@pytest.mark.parametrize('name', [
    'Realtors Community 1',
    'B2 Divine Estates - Requirement and Availabilty',
    'STAR ESTATE - DANISH',
    'BKS estate agents',
    'QURESHI ESTATE AGENT/ Watsup/7738575534 ,, Normalcal/ 77387 59739',
    '6 - VIVEK CHHABRIA - SHUBH ESTATES',
    'MILLIONS ACRE MBRE GROUP',
    'Chariot 3Bhk Lease',
    'Expat homes🤝Raymond Mahim',
    'Fahad Galaxy Realtors Broadcast',
    'Lakhani Realtors Broadcast Bandra West',
    'Top Professional Realtors',
    'Per Sqft (PG / 1BHK Rent)',
    'Distress/Urgent-Sale/Rent & Requirement',
])
def test_grounded_property_names_classify_property(name):
    assert policy.classify_group_share_topic(name) == ('property', None)


@pytest.mark.parametrize('name,topic', [
    ('❤️❤️❤️Shahrukh Khan - Personal Broadcast', 'personal or family'),
    ('Singles Mumbai Group 🤗', 'social or dating'),
    ('Let’s Socialise Mumbai (2nd Community)', 'social or dating'),
    ('Music Jamming - Mumbai', 'music'),
    ('Healing Together', 'health or wellness'),
    ('Vrindavan  Bhagwat Katha group C', 'religious or devotional'),
])
def test_grounded_non_property_names_never_shareable(name, topic):
    assert policy.classify_group_share_topic(name) == ('non_property', topic)


@pytest.mark.parametrize('name', [
    # Industry chatter is not a listing group: no silent property promotion.
    'India Proptech Demo Day 2026 (3rd Edition)',
    'RealtyNXT - Proptech/ConTech Founders',
    'Founder’s Circle',
    # Product/broadcast names stay on the explicit per-group path.
    'PropAI', 'PropAI Live', 'Propi - New Launches', 'PropNxT Western',
    'Dreams2Realty | Exclusive Deals & Requirements | Broadcast 1 | Pravin Makhija',
    # False-positive guards: food/home businesses must not become property.
    'Home Bakers Andheri',
    '3 महाराष्ट्र केटरिंग बिझनेस नेटवर्क',
])
def test_non_listing_names_stay_unclear(name):
    assert policy.classify_group_share_topic(name) == ('unclear', None)


def test_food_names_classify_non_property_not_property():
    # Bare "home" must not promote food businesses; food hints catch them.
    assert policy.classify_group_share_topic('Home Chefs Tiffin Service')[0] == 'non_property'


def test_gate_blocks_non_property_even_with_allow_unclear():
    names = {'1@g.us': 'Singles Mumbai Group 🤗', '2@g.us': 'Vrindavan  Bhagwat Katha group C'}
    blocked, held = policy.validate_group_share_eligibility(['1@g.us', '2@g.us'], ['1@g.us', '2@g.us'], names)
    assert len(blocked) == 2 and held == []


def test_gate_holds_newly_unclear_industry_groups_without_explicit_include():
    names = {'3@g.us': 'India Proptech Demo Day 2026 (3rd Edition)', '4@g.us': 'PropAI Live'}
    blocked, held = policy.validate_group_share_eligibility(['3@g.us', '4@g.us'], [], names)
    assert blocked == [] and len(held) == 2
    assert policy.validate_group_share_eligibility(['3@g.us'], ['3@g.us'], names) == ([], [])


def test_bulk_restore_payload_boundary():
    # A restore-review bulk confirm sends every ticked group at once. The gate
    # must pass property groups plus explicitly-included unclear groups, and
    # must still block any non-property group smuggled into the same payload.
    names = {
        'p1@g.us': 'Mumbai Buy Sell Flat 2bhk',
        'p2@g.us': 'Gurgaon Property Listings',
        'u1@g.us': 'City Deals Network',
        'n1@g.us': 'Singles Mumbai Group 🤗',
    }
    blocked, held = policy.validate_group_share_eligibility(
        ['p1@g.us', 'p2@g.us', 'u1@g.us'], ['u1@g.us'], names)
    assert blocked == [] and held == []
    # The unclear group without its exact include is held back, not shared.
    blocked, held = policy.validate_group_share_eligibility(
        ['p1@g.us', 'p2@g.us', 'u1@g.us'], [], names)
    assert blocked == [] and held == ['City Deals Network']
    # A non-property group inside the same bulk payload blocks the write.
    blocked, held = policy.validate_group_share_eligibility(
        ['p1@g.us', 'u1@g.us', 'n1@g.us'], ['u1@g.us', 'n1@g.us'], names)
    assert len(blocked) == 1 and 'Singles Mumbai Group' in blocked[0] and held == []
    # Groups absent from the name directory are left to the existence check.
    blocked, held = policy.validate_group_share_eligibility(
        ['p1@g.us', 'zz9@g.us'], [], names)
    assert blocked == [] and held == []
