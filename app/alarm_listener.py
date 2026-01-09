#!/usr/bin/env python3
import socket

HOST = "0.0.0.0"
PORT = 15000

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
    # 1) Read until end of headers
    header_bytes = recv_until(conn, b"\r\n\r\n")
    if b"\r\n\r\n" not in header_bytes:
        return header_bytes  # incomplete / weird

    headers, remainder = header_bytes.split(b"\r\n\r\n", 1)
    content_length = parse_content_length(headers)

    # 2) Read body until content length is satisfied
    body = remainder
    while len(body) < content_length:
        chunk = conn.recv(4096)
        if not chunk:
            break
        body += chunk

    return headers + b"\r\n\r\n" + body

def main():
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((HOST, PORT))
    sock.listen(5)

    print(f"[ALARM] Listening on {HOST}:{PORT}", flush=True)

    while True:
        conn, addr = sock.accept()
        try:
            raw = read_http_like_request(conn)

            print(f"\n[ALARM] Connection from {addr}", flush=True)
            print("[ALARM] Full request:", flush=True)
            print(raw.decode(errors="ignore"), flush=True)

        except Exception as e:
            print(f"[ALARM] Error handling connection from {addr}: {e}", flush=True)
        finally:
            conn.close()

if __name__ == "__main__":
    main()
