"""
Terminal WhatsApp QR connector — displays QR in terminal like opencode.

Usage:
    python3 -m lab.connect

Requires: qrcode, pyzbar, httpx, Pillow
"""
import base64
import json
import io
import os
import time
from pathlib import Path

import httpx
from PIL import Image

from lab.config import BAILEYS_STATUS_FILE, EVOLUTION_API_URL, EVOLUTION_API_KEY, EVOLUTION_INSTANCE

PROJECT_DIR = Path(__file__).resolve().parent
LOCAL_STATUS_FILE = BAILEYS_STATUS_FILE if BAILEYS_STATUS_FILE.is_absolute() else PROJECT_DIR / BAILEYS_STATUS_FILE


C = {
    "reset": "\033[0m",
    "bold": "\033[1m",
    "dim": "\033[2m",
    "green": "\033[32m",
    "cyan": "\033[36m",
    "yellow": "\033[33m",
    "red": "\033[31m",
    "blue": "\033[34m",
    "magenta": "\033[35m",
    "grey": "\033[90m",
    "bg_green": "\033[42m",
    "bg_blue": "\033[44m",
    "bg_grey": "\033[100m",
    "white": "\033[97m",
    "rev": "\033[7m",
}
W = 62


def get_api_key():
    key = EVOLUTION_API_KEY
    if not key:
        key_path = Path(__file__).parent / ".api_key"
        if key_path.exists():
            key = key_path.read_text().strip()
    return key or "propai-dev-key"


def api_get(path: str) -> dict:
    key = get_api_key()
    url = f"{EVOLUTION_API_URL}/{path.lstrip('/')}"
    try:
        r = httpx.get(url, headers={"apikey": key}, timeout=15)
        return r.json()
    except httpx.ConnectError as e:
        return {
            "_error": f"Could not reach Evolution API at {EVOLUTION_API_URL}. Is it running?",
            "_detail": str(e),
        }
    except httpx.TimeoutException as e:
        return {
            "_error": f"Timed out contacting Evolution API at {EVOLUTION_API_URL}.",
            "_detail": str(e),
        }
    except Exception as e:
        return {"_error": str(e)}


def fetch_qr() -> dict:
    return api_get(f"instance/connect/{EVOLUTION_INSTANCE}")


def read_baileys_status() -> dict:
    try:
        if LOCAL_STATUS_FILE.exists():
            data = json.loads(LOCAL_STATUS_FILE.read_text())
            if isinstance(data, dict):
                return data
    except Exception:
        pass
    return {}


def fetch_backend_connection() -> dict:
    try:
        r = httpx.get("http://localhost:8000/api/sync/connection", timeout=5)
        if r.status_code == 200:
            data = r.json()
            if isinstance(data, dict):
                return data
    except Exception:
        pass
    return {}


def decode_qr_content(base64_png: str) -> str:
    if "," in base64_png:
        base64_png = base64_png.split(",")[1]
    img = Image.open(io.BytesIO(base64.b64decode(base64_png)))
    from pyzbar.pyzbar import decode as qr_decode
    decoded = qr_decode(img)
    return decoded[0].data.decode("utf-8") if decoded else ""


def render_qr(text: str) -> str:
    import qrcode
    qr = qrcode.QRCode(border=2)
    qr.add_data(text)
    qr.make(fit=True)
    out = io.StringIO()
    qr.print_ascii(out=out, invert=True)
    return out.getvalue()


def check_connected() -> bool:
    status = read_baileys_status()
    if status:
        return bool(status.get("connected")) or str(status.get("connection_state", "")).lower() in ("open", "connected", "syncing")
    backend = fetch_backend_connection()
    if backend:
        return bool(backend.get("connected")) or str(backend.get("connection_state", "")).lower() in ("open", "connected", "syncing")
    data = api_get(f"instance/connectionState/{EVOLUTION_INSTANCE}")
    state = data.get("instance", {}).get("state", "")
    if state.lower() in ("open", "connected", "syncing"):
        return True
    info = get_connection_info()
    return str(info.get("status", "")).lower() in ("open", "connected", "syncing")


def get_connection_info() -> dict:
    status = read_baileys_status()
    if status:
        phone = status.get("phone_number", "")
        if phone and not str(phone).startswith("+"):
            phone = f"+{phone}" if str(phone).isdigit() else phone
        return {
            "phone": phone or "—",
            "name": status.get("display_name") or status.get("profile_name") or "—",
            "status": status.get("connection_state", "unknown"),
            "jid": status.get("phone_number", ""),
            "created": status.get("connected_since", ""),
        }

    backend = fetch_backend_connection()
    if backend:
        phone = backend.get("phone_number", "") or backend.get("phone", "")
        profile = backend.get("display_name", "") or backend.get("profile", "")
        return {
            "phone": phone or "—",
            "name": profile or "—",
            "status": backend.get("connection_state", backend.get("state", "unknown")),
            "jid": backend.get("phone_number", "") or "",
            "created": backend.get("connected_since", ""),
        }

    data = api_get("instance/fetchInstances")
    instances = data if isinstance(data, list) else []
    for inst in instances:
        if inst.get("name") == EVOLUTION_INSTANCE:
            jid = inst.get("ownerJid", "")
            number = jid.split("@")[0] if jid else ""
            formatted = f"+{number[:2]} {number[2:7]} {number[7:]}" if number else "—"
            return {
                "phone": formatted,
                "name": inst.get("profileName", "—"),
                "status": inst.get("connectionStatus", "unknown"),
                "jid": jid,
                "created": inst.get("createdAt", ""),
            }
    return {"phone": "—", "name": "—", "status": "unknown"}


def box(title: str, lines: list[str], color: str = "cyan"):
    """Draw a bordered box with title."""
    tl, tr, bl, br = "╭", "╮", "╰", "╯"
    h, v = "─", "│"
    c = C.get(color, "")
    print(f"{c}{tl}{h * (W - 2)}{tr}{C['reset']}")
    if title:
        pad = W - 4 - len(title)
        print(f"{c}{v}{C['reset']}  {C['bold']}{title}{C['reset']}{' ' * pad}{c}{v}{C['reset']}")
        print(f"{c}{v}{h * (W - 2)}{v}{C['reset']}")
    for line in lines:
        clean = line.replace(C["reset"], "").replace(C["bold"], "").replace(C["dim"], "")
        visible = len(clean.encode("ascii", "ignore")) if any(ord(ch) > 127 for ch in clean) else len(clean)
        # Strip ANSI for width calc
        import re
        ansi_clean = re.sub(r'\033\[[0-9;]*m', '', line)
        vis_len = len(ansi_clean)
        pad = max(0, W - 4 - vis_len)
        print(f"{c}{v}{C['reset']} {line}{' ' * pad} {c}{v}{C['reset']}")
    print(f"{c}{bl}{h * (W - 2)}{br}{C['reset']}")


def banner():
    """Big PropAI logo text."""
    print(f"""
{C['cyan']}╔════════════════════════════════════════════════════════╗
║                                                            ║
║                         {C['bold']}{C['white']}PropAI{C['cyan']}                        ║
║                  {C['dim']}AI Operating System for Realtors{C['cyan']}                 ║
║                                                            ║
╚════════════════════════════════════════════════════════╝{C['reset']}
""")


def hr():
    print(f"  {C['grey']}{'─' * (W - 4)}{C['reset']}")


def show_connected():
    info = get_connection_info()
    status = str(info.get("status", "unknown")).lower()
    status_color = "green" if status in ("open", "connected", "syncing") else "yellow"

    boxes = [
        f"{C['green']}●{C['reset']}  {C['bold']}WhatsApp Connected{C['reset']}  {C['green']}✓{C['reset']}",
        "",
        f"  {C['dim']}Phone:{C['reset']}     {C['bold']}{info['phone']}{C['reset']}",
        f"  {C['dim']}Profile:{C['reset']}    {info['name']}",
        f"  {C['dim']}Instance:{C['reset']}   {EVOLUTION_INSTANCE}",
        f"  {C['dim']}Status:{C['reset']}     {C[status_color]}{info['status']}{C['reset']}",
        "",
        f"  {C['cyan']}→{C['reset']}  {C['bold']}http://localhost:8000{C['reset']}  {C['dim']}(dashboard){C['reset']}",
        f"  {C['cyan']}→{C['reset']}  propai sync  {C['dim']}(sync broker groups){C['reset']}",
        f"  {C['cyan']}→{C['reset']}  propai dashboard  {C['dim']}(open dashboard){C['reset']}",
    ]

    box("Connected", boxes, "green")


def show_qr_flow():
    refresh_count = 0
    max_refreshes = 20

    while refresh_count < max_refreshes:
        refresh_count += 1
        os.system("cls" if os.name == "nt" else "clear")
        banner()

        steps = [
            f"  {C['green']}✓{C['reset']}  Start WhatsApp on your phone",
            f"  {C['green']}✓{C['reset']}  Go to {C['bold']}Settings → Linked Devices{C['reset']}",
            f"  {C['green']}✓{C['reset']}  Tap {C['bold']}'Link a Device'{C['reset']}",
        ]
        for s in steps:
            print(f"  {s}")
        print()

        data = fetch_qr()

        if "_error" in data:
            lines = [
                f"  {C['red']}Error: {data['_error']}{C['reset']}",
                f"  {C['dim']}{data.get('_detail', '')}{C['reset']}" if data.get("_detail") else "",
                "",
                f"  Retrying in 3s...",
            ]
            box("Evolution API unreachable", [line for line in lines if line], "red")
            time.sleep(3)
            continue

        if data.get("count") == 0:
            if check_connected():
                os.system("cls" if os.name == "nt" else "clear")
                banner()
                show_connected()
                return
            box("Waiting", [f"  {C['yellow']}Instance is starting. Retrying...{C['reset']}"], "yellow")
            time.sleep(3)
            continue

        base64_png = data.get("base64", "")
        if not base64_png:
            lines = [
                f"  {C['yellow']}No QR code yet. Retrying...{C['reset']}",
            ]
            box("Waiting", lines, "yellow")
            time.sleep(3)
            continue

        qr_text = decode_qr_content(base64_png)
        if not qr_text:
            print(f"  {C['yellow']}Decoding QR...{C['reset']}")
            time.sleep(2)
            continue

        ascii_qr = render_qr(qr_text)
        qr_lines = ascii_qr.strip().split("\n")
        padded = [f"     {line}" for line in qr_lines]
        padded.append("")
        padded.append(f"  {C['cyan']}→{C['reset']}  {C['bold']}Scan this QR with WhatsApp{C['reset']}")
        padded.append(f"  {C['dim']}     Refresh #{refresh_count} | auto-refresh in 30s{C['reset']}")
        padded.append(f"  {C['grey']}     Or open http://localhost:8000/connect{C['reset']}")

        box("Scan QR Code", padded, "cyan")
        print()

        for i in range(30):
            if check_connected():
                os.system("cls" if os.name == "nt" else "clear")
                banner()
                show_connected()
                return
            time.sleep(1)

    print()
    box("Timeout", [
        f"  {C['yellow']}QR refresh limit reached.{C['reset']}",
        f"  Open browser: {C['bold']}http://localhost:8000/connect{C['reset']}",
    ], "yellow")


def main():
    os.system("cls" if os.name == "nt" else "clear")
    banner()

    if check_connected():
        show_connected()
        print()
        print(f"  {C['grey']}Already connected. Run {C['bold']}propai status{C['reset']}{C['grey']} or open {C['bold']}http://localhost:8000{C['reset']}{C['grey']}.{C['reset']}")
    else:
        show_qr_flow()

    print()


if __name__ == "__main__":
    main()
