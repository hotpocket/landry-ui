#!/usr/bin/env python3
"""Local dev server with Range request support (needed for audio seeking)."""

import argparse
import os
from functools import partial
from http.server import SimpleHTTPRequestHandler
from socketserver import ThreadingMixIn, TCPServer


class ThreadingHTTPServer(ThreadingMixIn, TCPServer):
    allow_reuse_address = True

CHUNK_SIZE = 64 * 1024  # 64KB chunks for streaming


class RangeHTTPRequestHandler(SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        # Suppress noisy per-request logging, only show errors
        if args and isinstance(args[0], str) and args[0].startswith('code'):
            return
        super().log_message(format, *args)

    def do_GET(self):
        range_header = self.headers.get('Range')
        if not range_header:
            return super().do_GET()

        path = self.translate_path(self.path)
        if not os.path.isfile(path):
            return super().do_GET()

        file_size = os.path.getsize(path)
        range_spec = range_header.replace('bytes=', '')
        parts = range_spec.split('-')
        start = int(parts[0]) if parts[0] else 0
        end = int(parts[1]) if parts[1] else file_size - 1
        end = min(end, file_size - 1)
        length = end - start + 1

        self.send_response(206)
        self.send_header('Content-Type', self.guess_type(path))
        self.send_header('Content-Range', f'bytes {start}-{end}/{file_size}')
        self.send_header('Content-Length', str(length))
        self.send_header('Accept-Ranges', 'bytes')
        self.end_headers()

        try:
            with open(path, 'rb') as f:
                f.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = f.read(min(CHUNK_SIZE, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (ConnectionResetError, BrokenPipeError):
            pass  # Browser closed connection — normal for range requests

    def do_HEAD(self):
        path = self.translate_path(self.path)
        if os.path.isfile(path):
            file_size = os.path.getsize(path)
            self.send_response(200)
            self.send_header('Content-Type', self.guess_type(path))
            self.send_header('Content-Length', str(file_size))
            self.send_header('Accept-Ranges', 'bytes')
            self.end_headers()
        else:
            super().do_HEAD()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Dev server with Range support')
    parser.add_argument('-d', '--directory', default='output/site')
    parser.add_argument('-p', '--port', type=int, default=8000)
    args = parser.parse_args()

    handler = partial(RangeHTTPRequestHandler, directory=args.directory)
    server = ThreadingHTTPServer(('', args.port), handler)
    print(f'Serving {args.directory} at http://localhost:{args.port}/')
    server.serve_forever()
