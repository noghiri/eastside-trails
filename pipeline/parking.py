"""Find parking lots that serve trails, from OSM, as unverified access points.

A lot qualifies when it is public (not private/customers/permit) and lies within NEAR_M of an
easy-bike trail edge (paved/groomed, bike-usable, part of a named trail of at least
MIN_TRAIL_M or of a park path network of at least MIN_PARK_PATHS_M). Tier "likely": it has
trail-parking context (inside a park, or a park/trail/beach/trailhead name). Tier "possible":
no context, but within ADJACENT_M of a long named trail. The best lot per SPACING_M of a named
trail (up to PARK_MAX per park) is kept, so a trail gets a parking point every so often.

Input: cache/pruned-, areas-<region>.json   Output: cache/autoparking-<region>.json
"""
import json
import math
import pathlib
import re
import sys

import classify
import geo

ROOT = pathlib.Path(__file__).resolve().parent.parent
NEAR_M = 150.0
MIN_TRAIL_M = 1500.0
MIN_PARK_PATHS_M = 800.0
SPACING_M = 1000.0      # along a named trail
PARK_SPACING_M = 200.0  # within one park
PARK_MAX = 3
ADJACENT_M = 30.0       # "possible" tier: right beside a long named trail, no park/name context
EXCLUDED_ACCESS = {"private", "customers", "permit", "no", "delivery", "employees", "residents"}
KEYWORDS = re.compile(r"\b(park|trail|trailhead|beach|lake|preserve|natural area|greenway|landing|marina|boat launch)\b", re.I)


class PointGrid:
    def __init__(self, cell=0.002):
        self.cell, self.cells = cell, {}

    def add(self, lat, lon, item):
        self.cells.setdefault((int(lat / self.cell), int(lon / self.cell)), []).append((lat, lon, item))

    def near(self, lat, lon, radius):
        r = int(radius / 111320 / self.cell) + 1
        ci, cj = int(lat / self.cell), int(lon / self.cell)
        for i in range(ci - r, ci + r + 1):
            for j in range(cj - 2 * r, cj + 2 * r + 1):
                for la, lo, item in self.cells.get((i, j), ()):
                    d = geo.dist((lat, lon), (la, lo))
                    if d <= radius:
                        yield d, item


def inside(pt, ring):
    """Ray-casting point-in-polygon on (lat, lon) rings."""
    y, x = pt
    hit = False
    for (y1, x1), (y2, x2) in zip(ring, ring[1:] + ring[:1]):
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            hit = not hit
    return hit


def densify(geom, step=10.0):
    out = [tuple(geom[0])]
    for a, b in zip(geom, geom[1:]):
        n = max(1, int(geo.dist(a, b) // step))
        out += [(a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n) for k in range(1, n + 1)]
    return out


def main(region="newcastle"):
    pruned = json.loads((ROOT / "cache" / f"pruned-{region}.json").read_text())
    areas = json.loads((ROOT / "cache" / f"areas-{region}.json").read_text())

    parks = areas["parks"]
    park_grid = PointGrid(0.01)
    for k, p in enumerate(parks):
        for ring in p["rings"]:
            lats, lons = [q[0] for q in ring], [q[1] for q in ring]
            p.setdefault("bbox", []).append((min(lats), min(lons), max(lats), max(lons)))
        la = sum(b[0] + b[2] for b in p["bbox"]) / (2 * len(p["bbox"]))
        lo = sum(b[1] + b[3] for b in p["bbox"]) / (2 * len(p["bbox"]))
        park_grid.add(la, lo, k)

    def park_of(pt):
        for _, k in park_grid.near(pt[0], pt[1], 5000):
            p = parks[k]
            for ring, (s, w, n, e) in zip(p["rings"], p["bbox"]):
                if s <= pt[0] <= n and w <= pt[1] <= e and inside(pt, [tuple(q) for q in ring]):
                    return p
        return None

    def detect(edges, kind):
        """Best public lots along `edges`, one per trail stretch (see module docstring)."""
        named_len = {}
        for e in edges:
            if e["tags"].get("name"):
                named_len[e["tags"]["name"]] = named_len.get(e["tags"]["name"], 0) + e["len_m"]
        keyed = []
        park_len = {}
        for e in edges:
            name = e["tags"].get("name")
            if name and named_len[name] >= MIN_TRAIL_M:
                keyed.append((name, e))
            else:
                p = park_of(tuple(e["geom"][len(e["geom"]) // 2]))
                if p:
                    keyed.append((f"park:{p['osm']}", e))
                    park_len[p["osm"]] = park_len.get(p["osm"], 0) + e["len_m"]
        trail_grid = PointGrid()
        for key, e in keyed:
            if key.startswith("park:") and park_len[key[5:]] < MIN_PARK_PATHS_M:
                continue
            for pt in densify(e["geom"])[::2]:
                trail_grid.add(pt[0], pt[1], (key, e["a"], e["b"]))

        cands = []
        for lot in areas["parking"]:
            t = lot["tags"]
            if t.get("access") in EXCLUDED_ACCESS or t.get("parking") in ("street_side", "lane", "on_kerb"):
                continue
            ring = [tuple(q) for q in lot["ring"]]
            hits = {}
            for q in ring[:: max(1, len(ring) // 24)] + [(lot["lat"], lot["lon"])]:
                for d, (key, a, b) in trail_grid.near(q[0], q[1], NEAR_M):
                    if key not in hits or d < hits[key][0]:
                        hits[key] = (d, a, b)
            if not hits:
                continue
            park = park_of((lot["lat"], lot["lon"])) or next((park_of(q) for q in ring[::max(1, len(ring) // 8)] if park_of(q)), None)
            name = t.get("name") or ""
            score = 0.0
            if park:
                score += 3
            if KEYWORDS.search(name) or (park and park.get("name")):
                score += 2
            if t.get("fee") not in (None, "no"):
                score += 0.5  # agency-run lots are often fee or pass lots
            if t.get("parking") in ("multi-storey", "underground"):
                score -= 2
            if t.get("park_ride") not in (None, "no"):
                score -= 1
            for key, (d, a, b) in hits.items():
                if score >= 2:
                    tier = "likely"
                elif not key.startswith("park:") and d <= ADJACENT_M and t.get("parking") in (None, "surface"):
                    tier = "possible"
                else:
                    continue
                cands.append({"osm": lot["osm"], "lat": lot["lat"], "lon": lot["lon"], "trail": key, "tier": tier,
                              "nodes": [a, b],
                              "score": round(score - d / 150, 2), "dist_m": round(d), "lot_name": name or None,
                              "park": park.get("name") if park else None, "capacity": t.get("capacity"),
                              "fee": t.get("fee"), "access": t.get("access"),
                              "park_ride": t.get("park_ride") not in (None, "no")})

        # best lot per trail stretch; one lot can serve several trails but is emitted once
        kept, emitted = [], {}
        for c in sorted(cands, key=lambda c: (c["tier"] != "likely", -c["score"])):
            same = [k for k in kept if k["trail"] == c["trail"]]
            if c["trail"].startswith("park:"):
                if len(same) >= PARK_MAX or any(geo.dist((k["lat"], k["lon"]), (c["lat"], c["lon"])) < PARK_SPACING_M for k in same):
                    continue
            elif any(geo.dist((k["lat"], k["lon"]), (c["lat"], c["lon"])) < SPACING_M for k in same):
                continue
            kept.append(c)
            emitted.setdefault(c["osm"], c)
        for c in emitted.values():
            c["kind"] = kind
        return list(emitted.values())

    # easy-bike edges that belong to a real trail or a park path network
    easy = [e for e in pruned["edges"] if e["cls"] == "path" and classify.bike(e["tags"])[0] != "no"
            and classify.surface(e["tags"]) in classify.EASY_SURFACES and not classify.flags(e["tags"]) & classify.CLOSED]
    # any trail (MTB and hiking modes): parking at singletrack and hiking trailheads
    trails = [e for e in pruned["edges"] if e["cls"] == "path" and not classify.flags(e["tags"]) & classify.CLOSED
              and (classify.bike(e["tags"])[0] != "no" or classify.foot(e["tags"])[0] != "no")]
    out = detect(easy, "easy")
    near_easy = PointGrid()
    for c in out:
        near_easy.add(c["lat"], c["lon"], c["osm"])
    out += [c for c in detect(trails, "trail")
            if not any(True for _ in near_easy.near(c["lat"], c["lon"], 300))]
    path = ROOT / "cache" / f"autoparking-{region}.json"
    path.write_text(json.dumps(out))
    print(f"{sum(1 for c in out if c['kind'] == 'easy')} easy-trail + {sum(1 for c in out if c['kind'] == 'trail')} "
          f"other-trail parking points -> {path}")


if __name__ == "__main__":
    main(*sys.argv[1:])
