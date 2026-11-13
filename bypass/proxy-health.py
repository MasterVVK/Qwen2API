#!/usr/bin/env python3
"""
proxy-health.py — health of the browser-channel account proxies.

Reads the channel /health (:9100), then for each account tests its proxy (a
request to chat.qwen.ai; when that fails, a second hostname and a raw-IP
request to tell apart what exactly is broken) and classifies:

  OK           proxy reaches Qwen (HTTP 200)
  SLOW         proxy reaches Qwen, but the request took longer than SLOW_AFTER
               seconds -> working, just sluggish (NOT a problem)
  QWEN-FAIL    another hostname AND a raw IP both work, only chat.qwen.ai does
               not -> DNS and uplink are fine; Qwen itself is unreachable from
               this exit (throttled, blocked, or an unlucky edge)
  DNS-FAIL     no hostname resolves but a raw-IP request works -> the proxy HOST
               has an internet uplink, only NAME RESOLUTION is broken
               (dead/unreachable DNS resolver)
  NO-UPLINK    port open, hostname AND raw-IP both fail -> the proxy HOST has no
               route out (WAN / gateway down)
  DOWN         proxy host/port unreachable (service or host is down)
  DIRECT       account has no proxy (uses the container network)

A slow proxy used to be reported as DNS-FAIL: the Qwen probe timed out while the
raw-IP probe answered instantly, which looked exactly like a broken resolver.
Hence the generous timeout, the retry, and the separate hostname probe below.

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


IP_TARGET = "http://1.1.1.1/"        # raw IP -> no DNS involved; a reachable proxy gets a 3xx from Cloudflare
NAME_TARGET = "http://example.com/"  # a second hostname -> proves the proxy's resolver works at all
MAX_TIME = 25                        # per request; these exits are occasionally slow, not broken
SLOW_AFTER = 8.0                     # a successful request above this is reported as SLOW


def curl_probe(proxy, url, max_time=MAX_TIME):
    """Return (http_code, seconds). Code is 'ERR' when curl itself failed."""
    try:
        r = subprocess.run(
            ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code} %{time_total}",
             "-x", proxy, "--max-time", str(max_time), url],
            capture_output=True, text=True, timeout=max_time + 5).stdout.split()
        return (r[0], float(r[1])) if len(r) == 2 else ("ERR", 0.0)
    except Exception:
        return "ERR", 0.0


def curl_code(proxy, url):
    return curl_probe(proxy, url)[0]


def probe(proxy):
    """Return (verdict, detail) for one proxy — see the module docstring.

    The Qwen probe is retried once: a single timeout on these exits means
    "slow right now", not "broken", and must not be reported as a failure.
    """
    if not proxy or proxy.strip().lower() in ("direct", "none", "-", ""):
        return "DIRECT", "-"

    host_code, secs = curl_probe(proxy, TARGET)   # hostname chat.qwen.ai -> needs DNS
    if host_code != "200":                        # one slow attempt proves nothing
        host_code, secs = curl_probe(proxy, TARGET)
    if host_code == "200":
        return ("SLOW", f"200 in {secs:.1f}s") if secs > SLOW_AFTER else ("OK", host_code)

    host, port = host_port(proxy)
    if not tcp_open(host, port):
        return "DOWN", host_code

    name_code = curl_code(proxy, NAME_TARGET)     # another hostname -> does the resolver work?
    ip_code = curl_code(proxy, IP_TARGET)         # raw IP -> no DNS
    name_ok, ip_ok = name_code[:1] in ("2", "3"), ip_code[:1] in ("2", "3")
    detail = f"qwen={host_code} name={name_code} ip={ip_code}"
    if name_ok and ip_ok:                         # DNS and uplink fine -> Qwen alone is out of reach
        return "QWEN-FAIL", detail
    if ip_ok:                                     # only names fail -> the resolver is really broken
        return "DNS-FAIL", detail
    return "NO-UPLINK", detail


def sweep():
    accts = [a for a in accounts() if a.get("proxy")]
    out = {}
    with ThreadPoolExecutor(max_workers=8) as ex:
        verdicts = list(ex.map(lambda a: probe(a["proxy"]), accts))
    for a, (cls, code) in zip(accts, verdicts):
        out[a["name"]] = dict(proxy=a["proxy"], cls=cls, code=code,
                              err=a.get("lastError"), req=a.get("reqToday"))
    return out


HEALTHY = ("OK", "SLOW", "DIRECT")   # verdicts that need no attention


def table(res):
    print(f"{'account':16} {'proxy':26} {'verdict':10} {'lastError':20} {'req':>4}  detail")
    for name, v in res.items():
        mark = "" if v["cls"] in HEALTHY else "  <-- problem"
        print(f"  {name:16} {v['proxy']:26} {v['cls']:10} "
              f"{str(v['err']):20} {str(v['req']):>4}  {v['code']}{mark}")
    print("  verdicts: OK | SLOW (works, just slow) | QWEN-FAIL (net ok, Qwen out of reach) | "
          "DNS-FAIL (uplink ok, DNS broken) | NO-UPLINK (no route out) | DOWN | DIRECT")


def watch(interval):
    prev = {}
    print(f"watching proxies every {interval}s (Ctrl-C to stop)...")
    while True:
        res = sweep()
        ts = subprocess.run(["date", "-u", "+%H:%M:%S"],
                            capture_output=True, text=True).stdout.strip()
        bad = [n for n, v in res.items() if v["cls"] not in HEALTHY]
        print(f"[{ts}Z] OK {len(res) - len(bad)}/{len(res)}" +
              (f"  problem: {', '.join(bad)}" if bad else "  all proxies OK"), flush=True)
        for name, v in res.items():
            was = prev.get(name)
            if was is not None and was != v["cls"]:
                tag = "RECOVERED" if v["cls"] in HEALTHY else "FAILED"
                print(f"    >>> {name} ({v['proxy']}): {was} -> {v['cls']}  {tag}", flush=True)
            prev[name] = v["cls"]
        time.sleep(interval)


if __name__ == "__main__":
    a = sys.argv[1:]
    if a and a[0] == "--watch":
        watch(int(a[1]) if len(a) > 1 and a[1].isdigit() else 30)
    else:
        table(sweep())
