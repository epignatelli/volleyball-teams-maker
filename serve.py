#!/usr/bin/env python3
"""
Local dev server. Use instead of `python3 -m http.server 8080`.
Exposes GET /api/ip so the app can detect the LAN IP for QR codes.
"""
import http.server, socket, json, sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080

def get_lan_ip():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(('8.8.8.8', 80))   # no data sent; just routes the socket
            return s.getsockname()[0]
    except Exception:
        return '127.0.0.1'

class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/api/ip':
            body = json.dumps({'ip': get_lan_ip()}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', len(body))
            self.end_headers()
            self.wfile.write(body)
        else:
            super().do_GET()

    def log_message(self, fmt, *args):
        pass   # silence per-request noise

ip = get_lan_ip()
print(f'Serving on http://localhost:{PORT}  (LAN: http://{ip}:{PORT})')
with http.server.HTTPServer(('', PORT), Handler) as httpd:
    httpd.serve_forever()
