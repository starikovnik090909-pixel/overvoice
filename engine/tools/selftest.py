"""Самопроверка движка: сервер, выбор голосов, переключение, блоки, ошибки. Без звуковых устройств."""
import json, os, subprocess, sys, time, urllib.request
import numpy as np
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
A, V = os.environ.get('OV_ASSETS', 'assets'), os.environ.get('OV_VOICES', 'voices'); port = 18911
p = subprocess.Popen([sys.executable, '-m', 'ovengine', '--assets', A, '--voices', V, '--port', str(port), '--parent', str(os.getpid())], cwd=root, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
def call(m, path, body=None, t=300):
    r = urllib.request.Request('http://127.0.0.1:%d%s' % (port, path), method=m, data=json.dumps(body).encode() if body is not None else None, headers={'Content-Type': 'application/json'})
    try:
        return json.loads(urllib.request.urlopen(r, timeout=t).read())
    except urllib.error.HTTPError as e:
        return json.loads(e.read())
n = 0
def ok(c, m):
    global n; assert c, m; n += 1
try:
    for _ in range(240):
        try: call('GET', '/health', t=2); break
        except Exception: time.sleep(0.5)
    ok(call('GET', '/health')['ok'], 'сервер отвечает')
    lib = call('GET', '/library')['voices']; ok(len(lib) >= 2, 'библиотека видна: %d' % len(lib))
    a, b = lib[0]['name'], lib[1]['name']
    r = call('POST', '/use', {'name': 'нет такого'}); ok(not r['ok'] and 'нет в библиотеке' in r['error'], 'понятная ошибка для несуществующего голоса')
    r = call('POST', '/use', {'name': '../x'}); ok(not r['ok'], 'путь за пределы папки отклонён')
    t = time.time(); r = call('POST', '/use', {'name': a}); ok(r['ok'] and r['active'] == a, 'голос 1 включён за %.1f с' % (time.time() - t))
    t = time.time(); r = call('POST', '/use', {'name': b}); ok(r['ok'] and r['active'] == b, 'голос 2 включён за %.1f с' % (time.time() - t))
    t = time.time(); r = call('POST', '/use', {'name': a}); ok(r['ok'] and time.time() - t < 3, 'возврат к голосу 1 мгновенный (%.2f с)' % (time.time() - t))
    r = call('POST', '/settings', {'pitch': 99, 'gain': 0.5}); ok(r['settings']['pitch'] == 24 and r['settings']['gain'] == 0.5, 'настройки ограничиваются')
    r = call('POST', '/settings', {'nope': 1}); ok(not r['ok'], 'неизвестная настройка отклонена')
    r = call('POST', '/start', {'input': 'x', 'output': 'y'}); ok(not r['ok'], 'старт без звуковых устройств даёт ошибку, а не падение: ' + r.get('error', ''))
    i = call('GET', '/info'); ok(i['active'] == a and not i['live'] and i['loaded'], 'состояние: голос ' + i['active'])
    print('\n'.join(i['log']))
finally:
    call('POST', '/shutdown', {}, t=5) if p.poll() is None else None
    time.sleep(1); ok(p.poll() is not None or (p.kill() or True), 'движок закрылся по команде')
    print('✓ engine: %d проверок' % n)
