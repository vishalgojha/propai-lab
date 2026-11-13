from routers import common


class FakeStorage:
    def __init__(self):
        self.connections = []
        self.directory = []

    def list_org_whatsapp_connections(self, _org_id):
        return list(self.connections)

    def list_org_whatsapp_phone_directory(self, _org_id):
        return list(self.directory)

    def add_org_whatsapp_connection(self, org_id, phone_number, instance_name, broker_id):
        row = {
            "organization_id": org_id,
            "phone_number": phone_number,
            "instance_name": instance_name,
            "broker_id": broker_id,
        }
        self.connections.append(row)
        return row

    def add_org_whatsapp_phone_directory(self, org_id, broker_id, phone_number, label, active):
        self.directory.append({
            "organization_id": org_id,
            "broker_id": broker_id,
            "phone_number": phone_number,
            "display_label": label,
            "is_active": active,
        })


def test_signup_without_phone_still_gets_qr_pairing_placeholder(monkeypatch):
    storage = FakeStorage()
    monkeypatch.setattr(common, "storage", storage)

    common._ensure_signup_whatsapp_phone({"user_metadata": {}}, "org-1")

    assert len(storage.connections) == 1
    assert storage.connections[0]["phone_number"].startswith("Unpaired:phone-")
    assert storage.directory == []

    common._ensure_signup_whatsapp_phone({"user_metadata": {}}, "org-1")
    assert len(storage.connections) == 1


def test_signup_phone_still_registers_real_number_and_directory(monkeypatch):
    storage = FakeStorage()
    monkeypatch.setattr(common, "storage", storage)

    common._ensure_signup_whatsapp_phone(
        {"user_metadata": {"phone": "09876543210"}}, "org-1"
    )

    assert storage.connections[0]["phone_number"] == "919876543210"
    assert storage.directory[0]["phone_number"] == "919876543210"
