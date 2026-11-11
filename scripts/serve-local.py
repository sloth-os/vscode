#!/usr/bin/env python3
"""Threaded local static server for testing the prepared site.

Serves a directory so that the site is reachable under /vscode/ — the base
path the generated index.html/sw.js/manifest expect (matching the GitHub
Pages URL https://sloth-os.github.io/vscode/).

Usage:
    python3 scripts/serve-local.py <site-dir> [port]

    # with the vscode-web package at /path/to/vscode-web:
    mkdir /tmp/serve && ln -s /path/to/vscode-web /tmp/serve/vscode
    python3 scripts/serve-local.py /tmp/serve

Must be threaded: the service worker install fires ~1400 precache fetches
and a single-threaded server serializes them until fetches time out.

Not a faithful GitHub Pages stand-in for headers/caching — just for
functional smoke tests (scripts/smoke-test-*.mjs).
"""
import http.server
import socketserver
import os
import sys

root = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'vscode-web')
port = int(sys.argv[2]) if len(sys.argv) > 2 else 8765
os.chdir(os.path.abspath(root))


class ThreadedServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


Handler = http.server.SimpleHTTPRequestHandler
# Correct MIME types so the browser treats the files as modules/manifest.
Handler.extensions_map.update({
    '.js': 'application/javascript',
    '.mjs': 'application/javascript',
    '.wasm': 'application/wasm',
    '.json': 'application/json',
    '.webmanifest': 'application/manifest+json',
    '.css': 'text/css',
})

httpd = ThreadedServer(('127.0.0.1', port), Handler)
print(f'serving {os.getcwd()} at http://127.0.0.1:{port}/vscode/ (threaded)', flush=True)
httpd.serve_forever()
