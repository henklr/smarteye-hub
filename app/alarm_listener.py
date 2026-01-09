#!/usr/bin/env python3
import socket

HOST = "0.0.0.0"
PORT = 15000
BUF_SIZE = 8192

def run_alarm_listener():
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((HOST, PORT))
    sock.listen(5)

    print(f"[ALARM] Listening on {HOST}:{PORT}")

    while True:
        conn, addr = sock.accept()
        try:
            data = conn.recv(BUF_SIZE)
            if not data:
                print(f"[ALARM] {addr} connected but sent no data")
                continue

            print(f"\n[ALARM] Connection from {addr}")
            print("[ALARM] Decoded:")
            print(data.decode(errors="ignore"))

        except Exception as e:
            print(f"[ALARM] Error handling connection from {addr}: {e}")
        finally:
            conn.close()

if __name__ == "__main__":
    run_alarm_listener()
