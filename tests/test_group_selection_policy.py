from extraction_worker import _row_has_group_consent


def _row(group, broker, *, from_me=False):
    return {
        "tenant_id": "org-1",
        "group_name": group,
        "raw_payload": {
            "data": {
                "broker_id": broker,
                "key": {"fromMe": from_me},
            }
        },
    }


def test_primary_selected_group_is_extractable():
    policy = {
        "connections": {("org-1", "phone-1"): 1, ("org-1", "phone-2"): 2},
        "primary_by_org": {"org-1": 1},
        "selected": {("org-1", 1, "selected@g.us")},
    }

    assert _row_has_group_consent(_row("selected@g.us", "phone-1"), policy) is True


def test_secondary_number_is_raw_only_even_for_its_own_message():
    policy = {
        "connections": {("org-1", "phone-1"): 1, ("org-1", "phone-2"): 2},
        "primary_by_org": {"org-1": 1},
        "selected": {("org-1", 1, "selected@g.us")},
    }

    assert _row_has_group_consent(_row("secondary@g.us", "phone-2", from_me=True), policy) is False


def test_primary_unselected_group_is_not_extractable():
    policy = {
        "connections": {("org-1", "phone-1"): 1},
        "primary_by_org": {"org-1": 1},
        "selected": {("org-1", 1, "selected@g.us")},
    }

    assert _row_has_group_consent(_row("other@g.us", "phone-1"), policy) is False
