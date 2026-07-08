#!/usr/bin/env python3
"""
proxy-health.py — health of the browser-channel account proxies.

Reads the channel /health (:9100), then for each account tests its proxy by
doing an HTTPS CONNECT to chat.qwen.ai through it, and classifies:

  OK           proxy reaches Qwen (HTTP 200)
  NO-INTERNET  proxy port is open (service up) but it can't tunnel out
               (tinyproxy "500 Unable to connect" / curl 000) -> the proxy HOST
               lost its internet uplink (WAN / gateway / DNS)
  DOWN         proxy host/port unreachable (service or host is down)

Also surfaces the channel's own per-account lastError / reqToday so you can
line up the live symptom (upstream_unreachable) with the proxy verdict.

Usage:
  python3 proxy-health.py                  one-shot table of all accounts
  python3 proxy-health.py --watch [SEC]    repeat every SEC (default 30) and
                                           announce RECOVERED / FAILED transitions
                                           (Ctrl-C to stop) — use this to track recovery
"""
import sys, json, time, socket, subprocess, urllib.request
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlparse

HEALTH = "http://localhost:9100/health"
TARGET = "https://chat.qwen.ai/"


def accounts():
    with urllib.request.urlopen(HEALTH, timeout=8) as r:
        return json.load(r).get("accounts", [])


def host_port(proxy):
    u = urlparse(proxy if "://" in proxy else "http://" + proxy)
    return u.hostname, (u.port or 8888)


def tcp_open(host, port, t=3):
    try:
        with socket.create_connection((host, port), timeout=t):
            return True
    except Exception:
        return False


def probe(proxy):
    """Return (classification, http_code) for one proxy."""
    if not proxy or proxy.strip().lower() in ("direct", "none", "-", ""):
        return "DIRECT", "-"   # account uses the container's own network, no proxy to probe
    try:
        code = subprocess.run(
            ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
             "-x", proxy, "--max-time", "12", TARGET],
            capture_output=True, text=True, timeout=15).stdout.strip() or "ERR"
    except Exception:
        code = "ERR"
    if code == "200":
        return "OK", code
    host, port = host_port(proxy)
    return ("NO-INTERNET" if tcp_open(host, port) else "DOWN"), code


def sweep():
    accts = [a for a in accounts() if a.get("proxy")]
    out = {}
    with ThreadPoolExecutor(max_workers=8) as ex:
        verdicts = list(ex.map(lambda a: probe(a["proxy"]), accts))
    for a, (cls, code) in zip(accts, verdicts):
        out[a["name"]] = dict(proxy=a["proxy"], cls=cls, code=code,
                              err=a.get("lastError"), req=a.get("reqToday"))
    return out


def table(res):
    print(f"{'account':16} {'proxy':26} {'verdict':12} {'code':5} {'lastError':20} req")
    for name, v in res.items():
        mark = "" if v["cls"] in ("OK", "DIRECT") else "  <-- problem"
        print(f"  {name:16} {v['proxy']:26} {v['cls']:12} {v['code']:5} "
              f"{str(v['err']):20} {v['req']}{mark}")


def watch(interval):
    prev = {}
    print(f"watching proxies every {interval}s (Ctrl-C to stop)...")
    while True:
        res = sweep()
        ts = subprocess.run(["date", "-u", "+%H:%M:%S"],
                            capture_output=True, text=True).stdout.strip()
        bad = [n for n, v in res.items() if v["cls"] not in ("OK", "DIRECT")]
        print(f"[{ts}Z] OK {len(res) - len(bad)}/{len(res)}" +
              (f"  problem: {', '.join(bad)}" if bad else "  all proxies OK"), flush=True)
        for name, v in res.items():
            was = prev.get(name)
            if was is not None and was != v["cls"]:
                tag = "RECOVERED" if v["cls"] == "OK" else "FAILED"
                print(f"    >>> {name} ({v['proxy']}): {was} -> {v['cls']}  {tag}", flush=True)
            prev[name] = v["cls"]
        time.sleep(interval)


if __name__ == "__main__":
    a = sys.argv[1:]
    if a and a[0] == "--watch":
        watch(int(a[1]) if len(a) > 1 and a[1].isdigit() else 30)
    else:
        table(sweep())
