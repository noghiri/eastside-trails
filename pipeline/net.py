"""Small cached HTTP helper. Responses are cached under cache/ keyed by request hash.

Requests are sequential only; per the Overpass usage policy, back off 30 s on 429/406.
"""
import hashlib
import json
import pathlib
import time
import urllib.parse
import urllib.request

CACHE = pathlib.Path(__file__).resolve().parent.parent / "cache"
UA = "eastside-trails/0.1 (+https://github.com/noghiri/eastside-trails)"


def fetch(url, data=None, cache=True):
    key = hashlib.sha256((url + "\n" + (data or "")).encode()).hexdigest()[:24]
    path = CACHE / key
    if cache and path.exists():
        return path.read_bytes()
    body = data.encode() if data is not None else None
    req = urllib.request.Request(url, data=body, headers={"User-Agent": UA})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                out = r.read()
            break
        except urllib.error.HTTPError as e:
            if e.code in (406, 429, 502, 503, 504) and attempt < 3:
                time.sleep(30 * (attempt + 1))
                continue
            raise
    CACHE.mkdir(exist_ok=True)
    path.write_bytes(out)
    return out


def overpass(query):
    data = urllib.parse.urlencode({"data": query})
    return json.loads(fetch("https://overpass-api.de/api/interpreter", data))


_last_nominatim = [0.0]


def geocode(q):
    """Forward geocode via Nominatim: one request at a time, >=1 s apart, cached (OSMF policy)."""
    url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode(
        {"q": q, "format": "jsonv2", "limit": 1, "countrycodes": "us"})
    key = hashlib.sha256((url + "\n").encode()).hexdigest()[:24]
    if not (CACHE / key).exists():
        wait = 1.1 - (time.time() - _last_nominatim[0])
        if wait > 0:
            time.sleep(wait)
        _last_nominatim[0] = time.time()
    res = json.loads(fetch(url))
    return (float(res[0]["lat"]), float(res[0]["lon"])) if res else None
