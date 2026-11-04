"""Локальный HTTP-интерфейс движка (только 127.0.0.1). Овервойс управляет им отсюда."""
import json
import logging
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from urllib.parse import parse_qs

from ovengine.core import Engine, EngineError
from ovengine import compat

log = logging.getLogger('ovengine')


def make_handler(eng, stop_evt):
    state = {'busy': ''}

    class H(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, *a):
            pass

        def send(self, code, obj):
            b = json.dumps(obj, ensure_ascii=False).encode('utf-8')
            self.send_response(code); self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)

        def body(self):
            n = int(self.headers.get('Content-Length') or 0)
            if n <= 0:
                return {}
            raw = self.rfile.read(n).decode('utf-8', 'replace')
            try:
                if 'json' not in (self.headers.get('Content-Type') or '') and '=' in raw and not raw.lstrip().startswith('{'):
                    return {k: v[0] for k, v in parse_qs(raw).items()}   # форма key=…&val=… как у VCClient
                return json.loads(raw)
            except Exception:
                raise EngineError('Тело запроса не JSON')

        def work(self, text, fn):
            state['busy'] = text
            try:
                return fn()
            finally:
                state['busy'] = ''

        def handle_any(self, method):
            path = urlparse(self.path).path
            try:
                if method == 'GET' and path in ('/', '/health'):
                    return self.send(200, {'ok': True})
                if method == 'GET' and path == '/info':
                    d = compat.vc_info(eng); d['busy'] = state['busy']; d['ok'] = True; return self.send(200, d)
                if method == 'GET' and path == '/devices':
                    return self.send(200, {'ok': True, 'devices': eng.devices()})
                if method == 'GET' and path == '/library':
                    return self.send(200, {'ok': True, 'voices': eng.library()})
                b = self.body() if method == 'POST' else {}
                if method == 'POST' and path == '/update_settings':
                    try:
                        known = compat.vc_set(eng, str(b.get('key', '')), b.get('val'), self.work)
                    except ValueError as e:
                        raise EngineError(str(e))
                    return self.send(200, {'ok': True, 'known': bool(known)})
                if method == 'POST' and path == '/use':
                    self.work('Готовлю голос «%s»…' % b.get('name'), lambda: eng.use(str(b.get('name', ''))))
                    return self.send(200, {'ok': True, 'active': eng.active})
                if method == 'POST' and path == '/preload':
                    self.work('Загружаю голос «%s»…' % b.get('name'), lambda: eng.load(str(b.get('name', ''))))
                    return self.send(200, {'ok': True})
                if method == 'POST' and path == '/settings':
                    return self.send(200, {'ok': True, 'settings': eng.settings(**b)})
                if method == 'POST' and path == '/start':
                    self.work('Включаю звук…', lambda: eng.start(b.get('input'), b.get('output')))
                    return self.send(200, {'ok': True})
                if method == 'POST' and path == '/stop':
                    eng.stop(); return self.send(200, {'ok': True})
                if method == 'POST' and path == '/shutdown':
                    self.send(200, {'ok': True}); stop_evt.set(); return
                self.send(404, {'ok': False, 'error': 'Нет такого запроса: ' + path})
            except EngineError as e:
                self.send(400, {'ok': False, 'error': str(e)})
            except Exception as e:
                log.exception('запрос %s упал', path); self.send(500, {'ok': False, 'error': '%s: %s' % (type(e).__name__, e)})

        def do_GET(self): self.handle_any('GET')
        def do_POST(self): self.handle_any('POST')
    return H


def _warm(eng):
    try:
        eng._shared()
    except Exception as e:
        eng.fail(e)


def serve(assets, voices, port=18900):
    eng = Engine(assets, voices)
    stop_evt = threading.Event()
    srv = ThreadingHTTPServer(('127.0.0.1', port), make_handler(eng, stop_evt)); srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    threading.Thread(target=lambda: _warm(eng), daemon=True).start()   # общие модели грузим сразу, чтобы первый голос включался быстро
    eng.say('Движок слушает порт %d, устройство: %s' % (port, eng.dev_name))
    stop_evt.wait(); eng.stop(); srv.shutdown()
    return 0
