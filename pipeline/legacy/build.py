"""LEGACY pilot pipeline (superseded by network.py ... tiles.py); kept for reference.

Build site data: trail spines with elevation, grades, flags, access points and POIs.

Inputs: cache/osm_pilot.json, cache/osm_gaps.json, cache/osm_features.json (from fetch_osm.py),
        data/curated.json (hand-maintained, authority-sourced).
Outputs: docs/data/trails.json, docs/gpx/*.gpx
"""
import json
import pathlib
import re
import xml.sax.saxutils as sx

import elevation
import geo
import net

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
CACHE = ROOT / "cache"
OUT = ROOT / "docs"

ROADS = {"motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential",
         "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link"}
PAVED = {"asphalt", "concrete", "paved", "paving_stones", "concrete:plates", "wood", "metal"}
GROOMED = {"compacted", "fine_gravel"}

# per-sample flag bits
CLOSED, ROAD, DISMOUNT, BRIDGE = 1, 2, 4, 8
SURFACE_CODES = {"paved": 0, "groomed": 1, "rough": 2, "unknown": 3}


def bike_allowed(t):
    if t.get("highway") == "construction":
        return False
    b = t.get("bicycle")
    if b:
        return b != "no"
    return t.get("access") not in ("no", "private")


def surface_class(t):
    s = t.get("surface")
    if s in PAVED:
        return "paved"
    if s in GROOMED:
        return "groomed"
    return "unknown" if s is None else "rough"


def flags(t):
    f = 0
    if not bike_allowed(t):
        f |= CLOSED
    if t.get("highway") in ROADS or t.get("highway") == "service" and t.get("service") != "parking_aisle":
        f |= ROAD
    if t.get("bicycle") == "dismount" or t.get("highway") == "steps":
        f |= DISMOUNT
    if t.get("bridge", "no") != "no" or t.get("tunnel", "no") != "no":
        f |= BRIDGE
    return f


def _route(adj, a, b):
    if a not in adj or b not in adj:
        return None
    best, prev = geo._dijkstra(adj, a)
    if b not in best:
        return None
    ways, n = [], b
    while n != a:
        p, w = prev[n]
        ways.append(w)
        n = p
    return best[b], ways


def connect_gaps(trail_ways, network, max_gap=600):
    """Bridge gaps between trail pieces through the local network.

    A closed way that spans the gap almost directly is the trail itself, closed: keep it
    (flagged CLOSED) rather than inventing a street detour the authority doesn't sanction.
    Otherwise prefer open routes, then closed ones. Detours much longer than the gap are
    rejected: they are not the trail.
    """
    open_adj = geo.build_graph([w for w in network if bike_allowed(w["tags"])])
    all_adj = geo.build_graph(network)
    ways = list(trail_ways)
    while True:
        adj = geo.build_graph(ways)
        comps = geo.components(adj)
        ends = [[n for n in c if len(adj[n]) == 1] for c in comps]
        cands = []
        for i in range(len(comps)):
            for j in range(i + 1, len(comps)):
                pairs = [(geo.dist(a, b), a, b) for a in ends[i] for b in ends[j]]
                if pairs:
                    cands.append(min(pairs))
        added = False
        for gap, a, b in sorted(cands):
            if gap > max_gap:
                break
            limit = max(2 * gap, gap + 150)
            direct = _route(all_adj, a, b)
            if direct and direct[0] <= 1.3 * gap + 30 and not all(bike_allowed(w["tags"]) for w in direct[1]):
                ways += [w for w in direct[1] if w not in ways]
                added = True
                break
            for g in (open_adj, all_adj):
                r = _route(g, a, b)
                if r and r[0] <= limit:
                    ways += [w for w in r[1] if w not in ways]
                    added = True
                    break
            if not added and gap < 25:
                # unmapped crossing or node mismatch: join directly
                ways.append({"id": f"join-{len(ways)}", "tags": {"highway": "path"},
                             "geometry": [{"lat": a[0], "lon": a[1]}, {"lat": b[0], "lon": b[1]}]})
                added = True
            if added:
                break
        if not added:
            return ways


def correct_bridges(samples, ele):
    """DEMs show ground under bridges; interpolate elevation across bridge spans."""
    n = len(samples)
    i = 0
    while i < n:
        if samples[i]["f"] & BRIDGE:
            j = i
            while j < n and samples[j]["f"] & BRIDGE:
                j += 1
            lo, hi = max(i - 1, 0), min(j, n - 1)
            for k in range(i, j):
                t = (samples[k]["d"] - samples[lo]["d"]) / max(samples[hi]["d"] - samples[lo]["d"], 1)
                ele[k] = ele[lo] + (ele[hi] - ele[lo]) * t
            i = j
        else:
            i += 1


def smooth(vals, half=2):
    out = []
    for i in range(len(vals)):
        w = vals[max(0, i - half):i + half + 1]
        out.append(sum(w) / len(w))
    return out


def fill_missing(ele):
    known = [i for i, e in enumerate(ele) if e is not None]
    if not known:
        raise RuntimeError("no elevation data")
    for i, e in enumerate(ele):
        if e is None:
            ele[i] = ele[min(known, key=lambda k: abs(k - i))]


def slug(name):
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def write_gpx(path, name, samples, ele):
    pts = "\n".join(
        f'      <trkpt lat="{s["lat"]:.6f}" lon="{s["lon"]:.6f}"><ele>{e:.1f}</ele></trkpt>'
        for s, e in zip(samples, ele))
    path.write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<gpx version="1.1" creator="eastside-trails" xmlns="http://www.topografix.com/GPX/1/1">\n'
        f'  <metadata><name>{sx.escape(name)}</name>'
        '<copyright author="OpenStreetMap contributors"><license>https://opendatacommons.org/licenses/odbl/</license></copyright>'
        '</metadata>\n'
        f'  <trk><name>{sx.escape(name)}</name>\n    <trkseg>\n{pts}\n    </trkseg>\n  </trk>\n</gpx>\n',
        encoding="utf-8")


def feature_point(e):
    c = e.get("center") or e
    return c["lat"], c["lon"]


def classify_feature(t):
    if t.get("amenity") == "toilets":
        return "toilets"
    if t.get("amenity") == "drinking_water":
        return "water"
    if t.get("tourism") == "viewpoint":
        return "viewpoint"
    if t.get("highway") == "trailhead":
        return "trailhead"
    if t.get("amenity") == "parking" and t.get("access") not in ("private", "customers", "no", "permit"):
        return "parking"
    return None


def densify(geom, step=10.0):
    pts = [(p["lat"], p["lon"]) for p in geom]
    out = [pts[0]]
    for a, b in zip(pts, pts[1:]):
        n = max(1, int(geo.dist(a, b) // step))
        out += [(a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n) for k in range(1, n + 1)]
    return out


def locate_access(a, pieces, roads, features_by_id, parking):
    """Resolve a curated access point to (piece index, sample index, parking lat/lon, lot)."""
    spec = a["locate"]
    if "osm" in spec:
        pt = feature_point(features_by_id[spec["osm"]])
    elif "geocode" in spec:
        pt = net.geocode(spec["geocode"])
    else:
        pts = [p for w in roads.get(spec["road"], []) for p in densify(w["geometry"])]
        best = None
        for k, (samples, _) in enumerate(pieces):
            for p in pts:
                i, off = geo.nearest(samples, p)
                if best is None or off < best[0]:
                    best = (off, p)
        pt = best[1] if best else None
    if pt is None:
        return None
    k, i, off = min(((k, *geo.nearest(s, pt)) for k, (s, _) in enumerate(pieces)), key=lambda x: x[2])
    if off > 400:
        return None
    lot = min(parking, key=lambda e: geo.dist(feature_point(e), pt))
    if "osm" not in spec and geo.dist(feature_point(lot), pt) > 150:
        lot = None
    elif "osm" in spec:
        lot = features_by_id[spec["osm"]]
    return k, i, feature_point(lot) if lot else pt, lot


def build_piece(samples):
    pts = [(s["lat"], s["lon"]) for s in samples]
    ele = elevation.sample(pts)
    fill_missing(ele)
    correct_bridges(samples, ele)
    return smooth(ele)


def main():
    trails_raw = json.loads((CACHE / "osm_pilot.json").read_text())["elements"]
    network = [e for e in json.loads((CACHE / "osm_gaps.json").read_text())["elements"]]
    features = json.loads((CACHE / "osm_features.json").read_text())["elements"]
    curated = json.loads((ROOT / "data" / "curated.json").read_text(encoding="utf-8"))
    crossings = [e for e in trails_raw if e["type"] == "node"]
    roads = {}
    for w in json.loads((CACHE / "osm_roads.json").read_text())["elements"]:
        roads.setdefault(w["tags"]["name"], []).append(w)
    features_by_id = {f"{e['type']}/{e['id']}": e for e in features}
    parking = [e for e in features if classify_feature(e.get("tags", {})) == "parking"]

    by_name = {}
    for w in trails_raw:
        if w["type"] == "way":
            by_name.setdefault(w["tags"]["name"], []).append(w)
    seen_net = {w["id"] for w in network}
    network += [w for ws in by_name.values() for w in ws if w["id"] not in seen_net]

    (OUT / "gpx").mkdir(parents=True, exist_ok=True)
    for old in (OUT / "gpx").glob("*.gpx"):
        old.unlink()
    (OUT / "data").mkdir(parents=True, exist_ok=True)
    out_trails = []
    for name, info in curated["trails"].items():
        tid = slug(name)
        named = [w for w in by_name[name] if w["tags"].get("highway") != "construction"
                 and (bike_allowed(w["tags"]) or w["tags"].get("bicycle") == "dismount")]
        ways = connect_gaps(named, network)
        adj = geo.build_graph(ways)
        pieces = []
        for comp in sorted(geo.components(adj), key=len, reverse=True):
            line = geo.main_line(adj, comp)
            samples = geo.resample(line)
            if samples[-1]["d"] < info.get("min_piece_m", 500):
                continue
            for s in samples:
                s["f"] = flags(s["way"]["tags"])
                cls = surface_class(s["way"]["tags"])
                if cls == "unknown" and "untagged_surface" in info:
                    cls = info["untagged_surface"]
                s["s"] = SURFACE_CODES[cls]
                s["w"] = s["way"]["id"]
            ele = build_piece(samples)
            pieces.append((samples, ele))

        # orient pieces consistently (curated start point), then order by distance from it
        start = info.get("orient_from")
        if start:
            for k, (samples, ele) in enumerate(pieces):
                if geo.dist((samples[-1]["lat"], samples[-1]["lon"]), start) < geo.dist(
                        (samples[0]["lat"], samples[0]["lon"]), start):
                    samples.reverse()
                    ele.reverse()
                    total = samples[0]["d"]
                    for s in samples:
                        s["d"] = total - s["d"]
                pieces[k] = (samples, ele)
            pieces.sort(key=lambda p: geo.dist((p[0][0]["lat"], p[0][0]["lon"]), start))

        access = [[] for _ in pieces]
        for a in info.get("access", []):
            r = locate_access(a, pieces, roads, features_by_id, parking)
            if r is None:
                print("  WARNING: could not place", a["name"])
                continue
            k, i, (lat, lon), lot = r
            t = lot["tags"] if lot else {}
            osm_addr = " ".join(filter(None, [t.get("addr:housenumber"), t.get("addr:street"), t.get("addr:city")]))
            access[k].append({
                "i": i, "name": a["name"], "lat": round(lat, 6), "lon": round(lon, 6),
                "address": a.get("address") or osm_addr or None,
                "address_source": a.get("address_source") or ("osm" if osm_addr else None),
                "source": a["source"], "verified": a.get("verified", True),
                "pass": a.get("pass"), "pass_source": a.get("pass_source"),
                "lot_osm": f"{lot['type']}/{lot['id']}" if lot else None,
                "capacity": t.get("capacity"), "notes": a.get("notes"),
            })
            print(f"  {a['name']}: piece {k + 1} at {pieces[k][0][i]['d'] / 1609.34:.2f} mi, lot {'yes' if lot else 'no'}")

        out_pieces = []
        for k, (samples, ele) in enumerate(pieces):
            gpx_name = f"{tid}-{k + 1}.gpx"
            write_gpx(OUT / "gpx" / gpx_name, f"{name} (piece {k + 1})", samples, ele)
            pois = []
            for e in features:
                kind = classify_feature(e.get("tags", {}))
                if not kind or kind == "parking":
                    continue
                idx, off = geo.nearest(samples, feature_point(e))
                if off <= 100:
                    t = e["tags"]
                    lat, lon = feature_point(e)
                    pois.append({"kind": kind, "i": idx, "lat": round(lat, 6), "lon": round(lon, 6),
                                 "name": t.get("name"), "fee": t.get("fee"),
                                 "addr": " ".join(filter(None, [t.get("addr:housenumber"), t.get("addr:street"),
                                                                t.get("addr:city")])) or None,
                                 "osm": f"{e['type']}/{e['id']}", "off_m": round(off)})
            xs = []
            for c in crossings:
                idx, off = geo.nearest(samples, (c["lat"], c["lon"]))
                if off < 5:
                    xs.append({"i": idx, "type": c.get("tags", {}).get("crossing", "unknown"),
                               "osm": f"node/{c['id']}"})
            out_pieces.append({
                "gpx": f"gpx/{gpx_name}",
                "lat": [round(s["lat"], 6) for s in samples],
                "lon": [round(s["lon"], 6) for s in samples],
                "d": [round(s["d"], 1) for s in samples],
                "ele": [round(e, 1) for e in ele],
                "f": [s["f"] for s in samples],
                "s": [s["s"] for s in samples],
                "access": sorted(access[k], key=lambda a: a["i"]),
                "pois": pois,
                "crossings": xs,
            })
        out_trails.append({"id": tid, "name": name, **{k: v for k, v in info.items()
                                                        if k not in ("orient_from", "min_piece_m", "access", "untagged_surface")},
                           "pieces": out_pieces})
        print(name, [round(p["d"][-1] / 1609.34, 2) for p in out_pieces], "mi")

    (OUT / "data" / "trails.json").write_text(json.dumps({
        "surface_codes": SURFACE_CODES,
        "flags": {"closed": CLOSED, "road": ROAD, "dismount": DISMOUNT, "bridge": BRIDGE},
        "sources": curated["sources"],
        "trails": out_trails,
    }, separators=(",", ":")), encoding="utf-8")


if __name__ == "__main__":
    main()
