#!/usr/bin/env python3
"""Lokales Depot-Dashboard.

Start:  python3 server.py   ->  http://127.0.0.1:8765
Positionen stehen in holdings.json (im Dashboard bearbeitbar).
Kurse: Yahoo Finance (inoffiziell, ggf. 15 Min. verzögert). Nur Standardbibliothek.
"""
import json
import os
import ssl
import subprocess
import threading
import uuid
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST, PORT = "127.0.0.1", 8765
BASE = os.path.dirname(os.path.abspath(__file__))
HOLDINGS = os.path.join(BASE, "holdings.json")
UA = {"User-Agent": "Mozilla/5.0 (depot-dashboard)"}

# python.org-Python auf macOS bringt oft keine CA-Zertifikate mit -> Systemzertifikate nutzen
_CA = next((p for p in ("/etc/ssl/cert.pem",) if os.path.exists(p)), None)
SSL_CTX = ssl.create_default_context(cafile=_CA) if _CA else ssl.create_default_context()

# Bevorzugte Börsenplätze bei ISIN-Suche (deutsche Plätze in EUR zuerst)
PREFERRED_SUFFIX = [".DE", ".F", ".MU", ".SG", ".DU", ".BE", ".HM", ".HA", ".AS", ".PA", ".MI"]

_cache = {}
_lock = threading.Lock()
_file_lock = threading.Lock()


def http_json(url, ttl):
    now = time.time()
    with _lock:
        hit = _cache.get(url)
        if hit and now - hit[0] < ttl:
            return hit[1]
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=12, context=SSL_CTX) as r:
        data = json.load(r)
    with _lock:
        _cache[url] = (now, data)
    return data


def resolve_symbol(ident):
    """ISIN/Name -> Yahoo-Symbol. Tickers (mit Punkt oder ohne ISIN-Form) werden direkt genutzt."""
    ident = ident.strip()
    is_isin = len(ident) == 12 and ident[:2].isalpha() and ident[2:].isalnum()
    if not is_isin:
        return ident
    q = urllib.parse.quote(ident)
    data = http_json(f"https://query2.finance.yahoo.com/v1/finance/search?q={q}&quotesCount=10&newsCount=0", 86400)
    symbols = [x["symbol"] for x in data.get("quotes", []) if x.get("symbol")]
    if not symbols:
        raise ValueError(f"Kein Kurs-Symbol für {ident} gefunden")
    rank = lambda s: next((i for i, suf in enumerate(PREFERRED_SUFFIX) if s.endswith(suf)), len(PREFERRED_SUFFIX))
    symbols.sort(key=rank)
    # Nur Börsenplätze mit brauchbarer Kurshistorie; EUR-Notierung bevorzugt
    valid = []
    for s in symbols[:6]:
        try:
            h = chart(s, "1y", "1d", 3600)
            closes = [c for c in ((h.get("indicators", {}).get("quote") or [{}])[0].get("close") or []) if c]
            if len(closes) >= 20:
                valid.append((h["meta"].get("currency") != "EUR", rank(s), s))
        except Exception:
            pass
    if not valid:
        raise ValueError(f"Für {ident} keine Kurshistorie gefunden – bitte Ticker angeben (z. B. VWCE.DE)")
    return min(valid)[2]


def chart(symbol, rng, interval, ttl):
    s = urllib.parse.quote(symbol)
    data = http_json(f"https://query1.finance.yahoo.com/v8/finance/chart/{s}?range={rng}&interval={interval}", ttl)
    res = (data.get("chart") or {}).get("result")
    if not res:
        err = (data.get("chart") or {}).get("error") or {}
        raise ValueError(err.get("description") or f"Keine Daten für {symbol}")
    return res[0]


def eur_factor(currency):
    """Faktor, um einen Preis in `currency` in EUR umzurechnen."""
    if currency in (None, "EUR"):
        return 1.0
    div = 1.0
    if currency in ("GBp", "GBX"):
        currency, div = "GBP", 100.0
    meta = chart(f"EUR{currency}=X", "1d", "1d", 600)["meta"]
    return 1.0 / (meta["regularMarketPrice"] * div)


def load_holdings():
    with _file_lock:
        if not os.path.exists(HOLDINGS):
            return []
        with open(HOLDINGS, encoding="utf-8") as f:
            return json.load(f)


def save_holdings(items):
    with _file_lock:
        tmp = HOLDINGS + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(items, f, ensure_ascii=False, indent=2)
        os.replace(tmp, HOLDINGS)


def quote_position(h):
    out = dict(h)
    try:
        sym = h.get("symbol") or resolve_symbol(h["id"])
        out["symbol"] = sym
        day = chart(sym, "1d", "5m", 60)
        meta = day["meta"]
        fx = eur_factor(meta.get("currency"))
        price = meta["regularMarketPrice"] * fx
        prev = (meta.get("chartPreviousClose") or meta.get("previousClose") or meta["regularMarketPrice"]) * fx
        hist = chart(sym, "1y", "1d", 3600)
        ts = hist.get("timestamp") or []
        closes = (hist.get("indicators", {}).get("quote") or [{}])[0].get("close") or []
        series = [[t, c * fx] for t, c in zip(ts, closes) if c is not None]
        qty = float(h.get("anteile") or 0)
        out.update(
            price=price,
            prev=prev,
            value=price * qty,
            day_abs=(price - prev) * qty,
            day_pct=(price / prev - 1) * 100 if prev else 0,
            currency_src=meta.get("currency"),
            exchange=meta.get("exchangeName"),
            market_time=meta.get("regularMarketTime"),
            history=series,
            error=None,
        )
        cost = h.get("einstand")
        if cost not in (None, ""):
            cost = float(cost)
            out["pl_abs"] = out["value"] - cost
            out["pl_pct"] = (out["value"] / cost - 1) * 100 if cost else None
    except Exception as e:  # einzelne Position darf das Dashboard nicht kippen
        out.update(error=str(e), value=0, day_abs=0, history=[])
    return out


def portfolio():
    items = load_holdings()
    with ThreadPoolExecutor(max_workers=8) as ex:
        rows = list(ex.map(quote_position, items))
    # aufgelöste Symbole merken, damit die ISIN-Suche nur einmal läuft
    changed = False
    for src, row in zip(items, rows):
        if row.get("symbol") and not src.get("symbol") and not row.get("error"):
            src["symbol"] = row["symbol"]
            changed = True
    if changed:
        save_holdings(items)
    return {"positions": rows, "generated": time.time()}


# ---------------------------------------------------------------- Alerts
ALERTS = os.path.join(BASE, "alerts.json")
CHECK_EVERY = 60  # Sekunden
_alert_lock = threading.Lock()
DEFAULT_RULES = [
    {"id": "default-day", "type": "day_move", "target": "*", "value": 5, "enabled": True},
    {"id": "default-pf", "type": "portfolio_day_move", "target": "*", "value": 3, "enabled": True},
]
TYPES = {"day_move", "portfolio_day_move", "price_above", "price_below", "pl_below"}


def de(v, d=2):
    return f"{v:,.{d}f}".replace(",", "X").replace(".", ",").replace("X", ".")


def load_alerts():
    with _alert_lock:
        if os.path.exists(ALERTS):
            with open(ALERTS, encoding="utf-8") as f:
                a = json.load(f)
        else:
            a = {}
    a.setdefault("rules", [dict(r) for r in DEFAULT_RULES])
    a.setdefault("state", {})
    a.setdefault("log", [])
    return a


def save_alerts(a):
    with _alert_lock:
        tmp = ALERTS + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(a, f, ensure_ascii=False, indent=2)
        os.replace(tmp, ALERTS)


def notify(title, message):
    esc = lambda s: s.replace("\\", "\\\\").replace('"', '\\"')
    try:
        subprocess.run(["osascript", "-e",
                        f'display notification "{esc(message)}" with title "{esc(title)}" sound name "Glass"'],
                       timeout=10, check=False)
    except Exception:
        pass


def evaluate_alerts(pf):
    a = load_alerts()
    today = time.strftime("%Y-%m-%d")
    pos = [p for p in pf["positions"] if not p.get("error")]
    fired = []

    def once_per_day(key, title, msg):
        k = f"d:{today}:{key}"
        if not a["state"].get(k):
            a["state"][k] = True
            fired.append((title, msg))

    def edge(key, cond, title, msg):
        # feuert beim Überschreiten, wird scharf geschaltet, sobald die Bedingung wieder falsch ist
        if cond and not a["state"].get(key):
            fired.append((title, msg))
        if cond:
            a["state"][key] = True
        else:
            a["state"].pop(key, None)

    for r in a["rules"]:
        if not r.get("enabled", True):
            continue
        t, v, tgt = r["type"], float(r["value"]), r.get("target", "*")
        sel = [p for p in pos if tgt == "*" or p["id"] == tgt]
        name = lambda p: p.get("name") or p["id"]
        if t == "day_move":
            for p in sel:
                if abs(p["day_pct"]) >= v:
                    once_per_day(f'{r["id"]}:{p["id"]}', f'{name(p)} {"+" if p["day_pct"] >= 0 else ""}{de(p["day_pct"])} % heute',
                                 f'Kurs {de(p["price"], 2 if p["price"] >= 1 else 4)} € · Positionswert {de(p["value"])} € ({p.get("depot","")})')
        elif t == "portfolio_day_move":
            total = sum(p["value"] for p in pos)
            day = sum(p["day_abs"] for p in pos)
            pct = day / (total - day) * 100 if total - day else 0
            if abs(pct) >= v:
                once_per_day(r["id"], f'Portfolio {"+" if pct >= 0 else ""}{de(pct)} % heute',
                             f'{"+" if day >= 0 else ""}{de(day)} € · Gesamtwert {de(total)} €')
        elif t in ("price_above", "price_below"):
            for p in sel:
                cond = p["price"] >= v if t == "price_above" else p["price"] <= v
                word = "über" if t == "price_above" else "unter"
                edge(f'{r["id"]}:{p["id"]}', cond, f'{name(p)} {word} {de(v, 2 if v >= 1 else 4)} €',
                     f'Aktueller Kurs {de(p["price"], 2 if p["price"] >= 1 else 4)} €')
        elif t == "pl_below":
            for p in sel:
                if p.get("pl_pct") is None:
                    continue
                edge(f'{r["id"]}:{p["id"]}', p["pl_pct"] <= -abs(v), f'{name(p)} {de(p["pl_pct"])} % seit Kauf',
                     f'G/V {de(p["pl_abs"])} € · Grenze −{de(abs(v), 0)} %')

    # alte Tages-Marker aufräumen
    a["state"] = {k: s for k, s in a["state"].items() if not k.startswith("d:") or k.startswith(f"d:{today}:")}
    for title, msg in fired:
        a["log"].insert(0, {"time": time.time(), "title": title, "message": msg})
        notify(title, msg)
    a["log"] = a["log"][:200]
    save_alerts(a)
    return fired


def alert_loop():
    while True:
        try:
            if load_holdings():
                evaluate_alerts(portfolio())
        except Exception as e:
            print("Alert-Prüfung fehlgeschlagen:", e)
        time.sleep(CHECK_EVERY)


# Erlaubte statische Dateien (feste Liste – keine beliebigen Pfade, damit holdings.json & Co. nie ausgeliefert werden)
STATIC = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/manifest.webmanifest": ("manifest.webmanifest", "application/manifest+json"),
    "/sw.js": ("sw.js", "text/javascript; charset=utf-8"),
    "/config.js": ("config.js", "text/javascript; charset=utf-8"),
    "/api.js": ("api.js", "text/javascript; charset=utf-8"),
    "/spiel.js": ("spiel.js", "text/javascript; charset=utf-8"),
    "/favicon.ico": ("icons/favicon-32.png", "image/png"),
    **{f"/icons/{n}": (f"icons/{n}", "image/png") for n in (
        "icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png", "favicon-32.png")},
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body, ctype="application/json; charset=utf-8"):
        data = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/index.html":
            path = "/"
        if path in STATIC:
            rel, ctype = STATIC[path]
            with open(os.path.join(BASE, rel), "rb") as f:
                return self.send(200, f.read(), ctype)
        if path == "/api/portfolio":
            return self.send(200, portfolio())
        if path == "/api/holdings":
            return self.send(200, load_holdings())
        if path == "/api/alerts":
            a = load_alerts()
            return self.send(200, {"rules": a["rules"], "log": a["log"][:50]})
        self.send(404, {"error": "not found"})

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"null")

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/alerts/test":
            notify("Depot-Alert: Test", "Benachrichtigungen funktionieren.")
            return self.send(200, {"ok": True})
        if path == "/api/alerts/check":
            return self.send(200, {"fired": evaluate_alerts(portfolio())})
        self.send(404, {"error": "not found"})

    def do_PUT(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/alerts/rules":
            try:
                rules = self.body()
                assert isinstance(rules, list)
                clean = []
                for r in rules:
                    assert r.get("type") in TYPES, f"Unbekannter Typ {r.get('type')}"
                    clean.append({"id": r.get("id") or uuid.uuid4().hex[:8], "type": r["type"],
                                  "target": str(r.get("target") or "*"),
                                  "value": float(str(r["value"]).replace(",", ".")),
                                  "enabled": bool(r.get("enabled", True))})
                a = load_alerts()
                a["rules"] = clean
                save_alerts(a)
                return self.send(200, clean)
            except Exception as e:
                return self.send(400, {"error": str(e)})
        if path != "/api/holdings":
            return self.send(404, {"error": "not found"})
        try:
            items = self.body()
            assert isinstance(items, list)
            clean = []
            for it in items:
                if not str(it.get("id", "")).strip():
                    continue
                clean.append({
                    "name": str(it.get("name", "")).strip(),
                    "id": str(it["id"]).strip(),
                    "depot": str(it.get("depot", "")).strip(),
                    "anteile": float(str(it.get("anteile") or 0).replace(",", ".")),
                    "einstand": (float(str(it["einstand"]).replace(",", "."))
                                 if str(it.get("einstand") or "").strip() else None),
                    **({"symbol": it["symbol"]} if it.get("symbol") else {}),
                })
            save_holdings(clean)
            self.send(200, clean)
        except Exception as e:
            self.send(400, {"error": str(e)})


if __name__ == "__main__":
    threading.Thread(target=alert_loop, daemon=True).start()
    print(f"Depot-Dashboard läuft auf http://{HOST}:{PORT}  (Strg+C beendet)")
    print(f"Alerts werden alle {CHECK_EVERY} s geprüft.")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
