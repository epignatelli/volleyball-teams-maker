#!/usr/bin/env python3
"""
Local dev server. Use instead of `python3 -m http.server 8080`.

Extra API endpoints (used by KQOTC QR check-in):
  GET  /api/ip                        → {"ip": "192.168.x.x"}
  POST /api/checkin?s=SESSION_ID      ← {"name": "Alice"}
  GET  /api/players?s=SESSION_ID&after=N → {"players": [...], "total": N}
"""
import http.server, socket, json, sys, threading
from urllib.parse import urlparse, parse_qs

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080

# session_id -> [name, ...]
_sessions = {}
_lock = threading.Lock()

def get_lan_ip():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(('8.8.8.8', 80))
            return s.getsockname()[0]
    except Exception:
        return '127.0.0.1'

def json_response(handler, data, status=200):
    body = json.dumps(data).encode()
    handler.send_response(status)
    handler.send_header('Content-Type', 'application/json')
    handler.send_header('Content-Length', len(body))
    handler.send_header('Access-Control-Allow-Origin', '*')
    handler.end_headers()
    handler.wfile.write(body)

class Handler(http.server.SimpleHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        qs     = parse_qs(parsed.query)

        if parsed.path == '/api/ip':
            json_response(self, {'ip': get_lan_ip()})

        elif parsed.path == '/api/players':
            sid   = qs.get('s', [''])[0]
            after = int(qs.get('after', ['0'])[0])
            with _lock:
                all_players = _sessions.get(sid, [])
                new_players = all_players[after:]
            json_response(self, {'players': new_players, 'total': len(all_players)})

        else:
            super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        qs     = parse_qs(parsed.query)

        if parsed.path == '/api/checkin':
            sid    = qs.get('s', [''])[0]
            length = int(self.headers.get('Content-Length', 0))
            body   = self.rfile.read(length).decode().strip()
            try:
                name = json.loads(body).get('name', '').strip()
            except Exception:
                name = body
            if sid and name:
                with _lock:
                    _sessions.setdefault(sid, []).append(name)
                print(f'  [{sid}] checked in: {name}')
            json_response(self, {'ok': bool(sid and name)})
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, fmt, *args):
        pass

ip = get_lan_ip()
print(f'Serving on http://localhost:{PORT}  (LAN: http://{ip}:{PORT})')
with http.server.HTTPServer(('', PORT), Handler) as httpd:
    httpd.serve_forever()
