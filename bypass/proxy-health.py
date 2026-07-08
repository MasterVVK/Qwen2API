#!/usr/bin/env python3
"""
proxy-health.py — health of the browser-channel account proxies.

Reads the channel /health (:9100), then for each account tests its proxy (a
request to chat.qwen.ai, plus a raw-IP request when that fails) and classifies:

  OK           proxy reaches Qwen (HTTP 200)
  DNS-FAIL     port open, hostname fails but a raw-IP request works -> the proxy
               HOST has an internet uplink, only NAME RESOLUTION is broken
               (dead/unreachable DNS resolver)
  NO-UPLINK    port open, hostname AND raw-IP both fail -> the proxy HOST has no
               route out (WAN / gateway down)
  DOWN         proxy host/port unreachable (service or host is down)
  DIRECT       account has no proxy (uses the container network)

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


IP_TARGET = "http://1.1.1.1/"   # raw IP -> no DNS involved; a reachable proxy gets a 3xx from Cloudflare


def curl_code(proxy, url):
    try:
        return subprocess.run(
            ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
             "-x", proxy, "--max-time", "12", url],
            capture_output=True, text=True, timeout=15).stdout.strip() or "ERR"
    except Exception:
        return "ERR"


def probe(proxy):
    """Return (verdict, detail) for one proxy.

    OK         hostname reaches Qwen (200)
    DNS-FAIL   port open, hostname fails, but a raw-IP request succeeds -> the proxy host
               has an uplink; name resolution is broken (dead/unreachable DNS resolver)
    NO-UPLINK  port open, both hostname AND raw-IP fail -> the proxy host has no route out
    DOWN       proxy host/port unreachable (service or host down)
    DIRECT     account uses the container network, no proxy to probe
    """
    if not proxy or proxy.strip().lower() in ("direct", "none", "-", ""):
        return "DIRECT", "-"
    host_code = curl_code(proxy, TARGET)          # hostname chat.qwen.ai -> needs DNS
    if host_code == "200":
        return "OK", host_code
    host, port = host_port(proxy)
    if not tcp_open(host, port):
        return "DOWN", host_code
    ip_code = curl_code(proxy, IP_TARGET)         # raw IP -> no DNS
    if ip_code[:1] in ("2", "3"):                 # a real server answered -> the uplink is fine
        return "DNS-FAIL", f"host={host_code} ip={ip_code}"
    return "NO-UPLINK", f"host={host_code} ip={ip_code}"


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
    print(f"{'account':16} {'proxy':26} {'verdict':10} {'lastError':20} {'req':>4}  detail")
    for name, v in res.items():
        mark = "" if v["cls"] in ("OK", "DIRECT") else "  <-- problem"
        print(f"  {name:16} {v['proxy']:26} {v['cls']:10} "
              f"{str(v['err']):20} {str(v['req']):>4}  {v['code']}{mark}")
    print("  verdicts: OK | DNS-FAIL (uplink ok, DNS broken) | "
          "NO-UPLINK (no route out) | DOWN | DIRECT")


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
