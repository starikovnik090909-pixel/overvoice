import argparse
import logging
import os
import sys

# Родитель запускает нас скрытым процессом и следит за ним; если он умер, мы закрываемся сами (не висим в фоне).
def _watch_parent(pid):
    import threading, time
    def run():
        while True:
            time.sleep(3)
            try:
                if sys.platform == 'win32':
                    import ctypes
                    h = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)
                    if not h:
                        os._exit(0)
                    code = ctypes.c_ulong(); ctypes.windll.kernel32.GetExitCodeProcess(h, ctypes.byref(code)); ctypes.windll.kernel32.CloseHandle(h)
                    if code.value != 259:
                        os._exit(0)
                else:
                    os.kill(pid, 0)
            except OSError:
                os._exit(0)
    threading.Thread(target=run, daemon=True).start()


def main():
    ap = argparse.ArgumentParser(prog='ovengine')
    ap.add_argument('--assets', default='assets'); ap.add_argument('--voices', default='voices'); ap.add_argument('--port', type=int, default=18900)
    ap.add_argument('--parent', type=int, default=0, help='PID родителя: при его гибели движок закрывается сам')
    a = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    if a.parent:
        _watch_parent(a.parent)
    from ovengine.server import serve
    return serve(a.assets, a.voices, a.port)


if __name__ == '__main__':
    sys.exit(main())
