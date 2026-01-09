#!/usr/bin/env python3
import socket
import json
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

from config import load_settings

settings = load_settings()["alarm_listener"]
ONLY_START_EVENTS = settings["only_start_events"]
LOG_RAW_PAYLOAD = settings["log_raw_payload"]
HOST = settings["listen_host"]
PORT = settings["listen_port"]

EVENTS_PATH = Path("data/events.jsonl")
EVENTS_PATH.parent.mkdir(parents=True, exist_ok=True)

EXECUTOR = ThreadPoolExecutor(max_workers=4)

def recv_until(conn, marker: bytes) -> bytes:
    data = b""
    while marker not in data:
        chunk = conn.recv(4096)
        if not chunk:
            break
        data += chunk
    return data


def parse_content_length(headers: bytes) -> int:
    for line in headers.split(b"\r\n"):
        if line.lower().startswith(b"content-length:"):
            return int(line.split(b":", 1)[1].strip())
    return 0


def read_http_like_request(conn) -> bytes:
    header_bytes = recv_until(conn, b"\r\n\r\n")
    if b"\r\n\r\n" not in header_bytes:
        return header_bytes

    headers, remainder = header_bytes.split(b"\r\n\r\n", 1)
    content_length = parse_content_length(headers)

    body = remainder
    while len(body) < content_length:
        chunk = conn.recv(4096)
        if not chunk:
            break
        body += chunk

    return headers + b"\r\n\r\n" + body


def parse_json_from_payload(payload: bytes) -> dict | None:
    text = payload.decode(errors="ignore")
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None
    return json.loads(text[start : end + 1])


def process_payload(payload: bytes, addr):
    print(f"\n[ALARM] Connection from {addr}", flush=True)

    # Print raw full payload (optional)
    #print("[ALARM] Full request:", flush=True)
    #print(payload.decode(errors="ignore"), flush=True)

    # Try to parse JSON
    try:
        alarm = parse_json_from_payload(payload)
        if not alarm:
            print("[ALARM] No JSON found in payload", flush=True)
            return

        action = alarm.get("Action")
        code = alarm.get("Code")
        data = alarm.get("Data", {}) or {}
        event_seq = data.get("EventSeq")
        ip = data.get("IP")
        locale_time = data.get("LocaleTime")

        if ONLY_START_EVENTS and action != "Start":
            print(f"[ALARM] Ignoring Action={action} (ONLY_START_EVENTS enabled)", flush=True)
            return

        event = {
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "camera_ip": ip,
            "action": action,
            "code": code,
            "event_seq": event_seq,
            "locale_time": locale_time,
            "raw": alarm,
        }

        with EVENTS_PATH.open("a", encoding="utf-8") as f:
            f.write(json.dumps(event, ensure_ascii=False) + "\n")

        print(f"[ALARM] Logged: {action} {code} seq={event_seq} ip={ip}", flush=True)

        from automations import handle_event
        handle_event(event)

    except Exception as e:
        print(f"[ALARM] Failed to parse/log alarm JSON: {e}", flush=True)


def main():
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((HOST, PORT))
    sock.listen(5)

    print(f"[ALARM] Listening on {HOST}:{PORT}", flush=True)

    while True:
        conn, addr = sock.accept()
        try:
            payload = read_http_like_request(conn)
            EXECUTOR.submit(process_payload, payload, addr)
        finally:
            conn.close()


if __name__ == "__main__":
    main()
