"""
Terminal WhatsApp QR connector — displays QR in terminal like opencode.

Usage:
    python3 -m lab.connect

Requires: qrcode, pyzbar, httpx, Pillow
"""
import base64
import io
import json
import os
import time
from pathlib import Path

import httpx
from PIL import Image

from lab.config import STATUS_FILE

PROJECT_DIR = Path(__file__).parent
LOCAL_STATUS_FILE = STATUS_FILE if STATUS_FILE.is_absolute() else PROJECT_DIR / STATUS_FILE


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


def read_status() -> dict:
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
    status = read_status()
    if status:
        return bool(status.get("connected")) or str(status.get("connection_state", "")).lower() in ("open", "connected", "syncing")
    backend = fetch_backend_connection()
    if backend:
        return bool(backend.get("connected")) or str(backend.get("connection_state", "")).lower() in ("open", "connected", "syncing")
    return False


def get_connection_info() -> dict:
    status = read_status()
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


def show_connected():
    info = get_connection_info()
    status = str(info.get("status", "unknown")).lower()
    status_color = "green" if status in ("open", "connected", "syncing") else "yellow"

    boxes = [
        f"{C['green']}●{C['reset']}  {C['bold']}WhatsApp Connected{C['reset']}  {C['green']}✓{C['reset']}",
        "",
        f"  {C['dim']}Phone:{C['reset']}     {C['bold']}{info['phone']}{C['reset']}",
        f"  {C['dim']}Profile:{C['reset']}    {info['name']}",
        f"  {C['dim']}Status:{C['reset']}     {C[status_color]}{info['status']}{C['reset']}",
        "",
        f"  {C['cyan']}→{C['reset']}  {C['bold']}http://localhost:8000{C['reset']}  {C['dim']}(dashboard){C['reset']}",
        f"  {C['cyan']}→{C['reset']}  propai sync  {C['dim']}(sync broker groups){C['reset']}",
        f"  {C['cyan']}→{C['reset']}  propai dashboard  {C['dim']}(open dashboard){C['reset']}",
    ]

    box("Connected", boxes, "green")


def main():
    os.system("cls" if os.name == "nt" else "clear")
    banner()

    if check_connected():
        show_connected()
        print()
        print(f"  {C['grey']}Already connected. Run {C['bold']}propai status{C['reset']}{C['grey']} or open {C['bold']}http://localhost:8000{C['reset']}{C['grey']}.{C['reset']}")
    else:
        print()
        print(f"  {C['yellow']}Not connected. Start the WhatsApp ingestor.{C['reset']}")
        print()

    print()


if __name__ == "__main__":
    main()
