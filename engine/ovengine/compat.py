"""Совместимость: в коде RVC инференс обёрнут в run_cuda_graph. Здесь он просто вызывает функцию (быстро и без сюрпризов на любой карте)."""


def run_cuda_graph(model, key, fn, *args, **kwargs):
    return fn(*args, **kwargs)
