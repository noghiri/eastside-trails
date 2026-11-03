"""Write the routable network as 0.1-degree tiles for the site.

Inputs: cache/pruned-, elev-, pois-, network-<region>.json, data/curated.json
Outputs: docs/net/index.json (tile list, sources, trail info) and docs/net/t/<row>_<col>.json

Edge record (compact keys):
  i id, c class (path, road, join), a/b node ids, n name, h highway, s surface code, bk/ft bike/foot access code,
  ba 1 if bike access is a default rather than a tag, ow bike oneway (1, -1, 0), f flags,
  m mtb:scale, sc sac_scale, r elevation resolution (1 or 10 m), L length m,
  g polyline-encoded geometry (1e-6), st elevation step m, e elevation deltas in dm.
"""
import json
import math
import pathlib
import sys

import classify
import geo
import net

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "net"
ACCESS = {"yes": 1, "no": 0, "dismount": 2, "unknown": 3}
SURF = {k: i for i, k in enumerate(classify.SURFACES)}
POI_RADIUS = 100.0
ACCESS_RADIUS = 400.0


def encode(coords, factor=1e6):
    """Google polyline encoding."""
    out, plat, plon = [], 0, 0
    for lat, lon in coords:
        ilat, ilon = round(lat * factor), round(lon * factor)
        for v in (ilat - plat, ilon - plon):
            v = ~(v << 1) if v < 0 else v << 1
            while v >= 0x20:
                out.append(chr((0x20 | (v & 0x1F)) + 63))
                v >>= 5
            out.append(chr(v + 63))
        plat, plon = ilat, ilon
    return "".join(out)


def tile_of(lat, lon):
    return f"{math.floor(lat * 10)}_{math.floor(lon * 10)}"


class Grid:
    """Nearest-node lookup on a coarse grid."""

    def __init__(self, nodes, cell=0.005):
        self.cell, self.cells, self.nodes = cell, {}, nodes
        for nid, (lat, lon) in nodes.items():
            self.cells.setdefault((int(lat / cell), int(lon / cell)), []).append(nid)

    def nearest(self, lat, lon, radius):
        r = int(radius / 111320 / self.cell) + 1
        ci, cj = int(lat / self.cell), int(lon / self.cell)
        best = (math.inf, None)
        for i in range(ci - r, ci + r + 1):
            for j in range(cj - r * 2, cj + r * 2 + 1):
                for nid in self.cells.get((i, j), ()):
                    d = geo.dist((lat, lon), self.nodes[nid])
                    if d < best[0]:
                        best = (d, nid)
        return best if best[0] <= radius else (None, None)


def densify(geom, step=10.0):
    out = [geom[0]]
    for a, b in zip(geom, geom[1:]):
        n = max(1, int(geo.dist(a, b) // step))
        out += [(a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n) for k in range(1, n + 1)]
    return out


def locate(spec, pois_by_id, roads, trail_grid):
    """Curated access point -> (lat, lon) of the parking spot.

    Street-defined points are placed where that street meets the access point's own trail,
    since street names like "SE 8th Street" repeat across towns."""
    if "latlon" in spec:  # e.g. a lot mapped as a multipolygon, which the POI extract skips
        return tuple(spec["latlon"])
    if "osm" in spec:
        p = pois_by_id[spec["osm"]]
        return p["lat"], p["lon"]
    if "geocode" in spec:
        return net.geocode(spec["geocode"])
    best = (math.inf, None)
    for w in roads.get(spec["road"], []):
        for p in densify(w):
            d, nid = trail_grid.nearest(p[0], p[1], 60) if trail_grid else (None, None)
            if nid is not None and d < best[0]:
                best = (d, p)
    return best[1]


def main(region="newcastle"):
    pruned = json.loads((ROOT / "cache" / f"pruned-{region}.json").read_text())
    elev = json.loads((ROOT / "cache" / f"elev-{region}.json").read_text())
    pois = json.loads((ROOT / "cache" / f"pois-{region}.json").read_text())
    curated = json.loads((ROOT / "data" / "curated.json").read_text(encoding="utf-8"))
    raw = json.loads((ROOT / "cache" / f"network-{region}.json").read_text())
    roads = {}
    for e in raw["edges"]:
        if e["cls"] == "road" and "name" in e["tags"]:
            roads.setdefault(e["tags"]["name"], []).append(e["geom"])
    del raw
    pois_by_id = {p["osm"]: p for p in pois}
    by_name = {name: info for name, info in curated["trails"].items()}

    tiles = {}
    node_xy, ride_xy, named_xy, trail_nodes = {}, {}, {}, {}
    for e in pruned["edges"]:
        t = e["tags"]
        info = by_name.get(t.get("name"), {})
        surf = classify.surface(t)
        if surf == "unknown" and "untagged_surface" in info:
            surf = info["untagged_surface"]
        # the authority's whole-trail surface beats vague OSM tags on that trail
        if t.get("surface") in info.get("authority_surface_over", ()):
            surf = info["untagged_surface"]
        bk, assumed = classify.bike(t)
        ev = elev[str(e["id"])]
        deltas = [ev["ele"][0]] + [b - a for a, b in zip(ev["ele"], ev["ele"][1:])]
        rec = {"i": e["id"], "c": e["cls"], "a": e["a"], "b": e["b"], "n": t.get("name"), "h": t["highway"],
               "s": SURF[surf], "bk": ACCESS[bk], "ba": int(assumed), "ft": ACCESS[classify.foot(t)[0]],
               "ow": classify.bike_oneway(t), "f": classify.flags(t), "m": t.get("mtb:scale"),
               "sc": t.get("sac_scale"), "r": ev["src"], "L": e["len_m"], "g": encode(e["geom"]),
               "st": ev["step"], "e": deltas}
        mid = e["geom"][len(e["geom"]) // 2]
        tiles.setdefault(tile_of(*mid), {"edges": [], "pois": [], "access": []})["edges"].append(rec)
        node_xy[e["a"]], node_xy[e["b"]] = e["geom"][0], e["geom"][-1]
        if e["cls"] == "path" and not classify.flags(t) & classify.CLOSED and bk != "no":
            ride_xy[e["a"]], ride_xy[e["b"]] = e["geom"][0], e["geom"][-1]
        if t.get("name") in by_name:
            for j, pt in enumerate(e["geom"]):
                named_xy.setdefault(t["name"], {})[(e["id"], j)] = pt
            if not classify.flags(t) & classify.CLOSED and bk != "no":
                trail_nodes.setdefault(t["name"], {}).update({e["a"]: e["geom"][0], e["b"]: e["geom"][-1]})

    grid = Grid(node_xy)
    # parking snaps to a node on a rideable path, not to a lot aisle or road node
    ride_grid = Grid(ride_xy)
    trail_grids = {name: Grid(xy) for name, xy in named_xy.items()}
    # curated parking starts on its own trail: the walk from the car to the trail isn't part of the ride
    trail_node_grids = {name: Grid(xy) for name, xy in trail_nodes.items()}
    for p in pois:
        if p["kind"] in ("toilets", "water", "viewpoint", "trailhead"):
            d, nid = grid.nearest(p["lat"], p["lon"], POI_RADIUS)
            if nid is not None:
                tiles.setdefault(tile_of(p["lat"], p["lon"]), {"edges": [], "pois": [], "access": []})["pois"].append(
                    {"k": p["kind"], "lat": p["lat"], "lon": p["lon"], "node": nid, "name": p["tags"].get("name"),
                     "osm": p["osm"]})

    # OSM trailheads become unverified access points (no curated source yet)
    for p in pois:
        if p["kind"] == "trailhead":
            d, nid = ride_grid.nearest(p["lat"], p["lon"], ACCESS_RADIUS)
            if nid is not None:
                tiles.setdefault(tile_of(p["lat"], p["lon"]), {"edges": [], "pois": [], "access": []})["access"].append({
                    "name": p["tags"].get("name") or "Trailhead (OSM)", "trail": None, "lat": p["lat"], "lon": p["lon"],
                    "node": nid, "address": None, "address_source": None, "source": "osm", "verified": False,
                    "pass": None, "pass_source": None, "lot_osm": p["osm"], "capacity": None,
                    "notes": "Trailhead mapped in OpenStreetMap; parking and rules not checked."})

    for name, info in curated["trails"].items():
        for a in info.get("access", []):
            pt = locate(a["locate"], pois_by_id, roads, trail_grids.get(name))
            if pt is None:
                print("  WARNING: could not locate", a["name"])
                continue
            # prefer the parking lot itself when one is mapped close to the located point
            lot = None
            if "osm" in a["locate"] and a["locate"]["osm"] in pois_by_id:
                lot = pois_by_id[a["locate"]["osm"]]
            elif "latlon" in a["locate"]:
                lot = None
            else:
                near = [p for p in pois if p["kind"] == "parking" and geo.dist(pt, (p["lat"], p["lon"])) <= 150]
                lot = min(near, key=lambda p: geo.dist(pt, (p["lat"], p["lon"])), default=None)
            spot = (lot["lat"], lot["lon"]) if lot else pt
            d, nid = trail_node_grids[name].nearest(*spot, ACCESS_RADIUS) if name in trail_node_grids else (None, None)
            if nid is None:
                d, nid = ride_grid.nearest(*spot, ACCESS_RADIUS)
            if nid is None:
                print("  WARNING: no network node near", a["name"])
                continue
            lt = lot["tags"] if lot else {}
            osm_addr = " ".join(filter(None, [lt.get("addr:housenumber"), lt.get("addr:street"), lt.get("addr:city")]))
            tiles.setdefault(tile_of(*spot), {"edges": [], "pois": [], "access": []})["access"].append({
                "name": a["name"], "trail": name, "lat": round(spot[0], 6), "lon": round(spot[1], 6), "node": nid,
                "address": a.get("address") or osm_addr or None,
                "address_source": a.get("address_source") or ("osm" if osm_addr else None),
                "source": a["source"], "verified": a.get("verified", True),
                "pass": a.get("pass"), "pass_source": a.get("pass_source"),
                "lot_osm": lot["osm"] if lot else a["locate"].get("osm"), "capacity": lt.get("capacity"), "notes": a.get("notes")})

    (OUT / "t").mkdir(parents=True, exist_ok=True)
    for old in (OUT / "t").glob("*.json"):
        old.unlink()
    for key, data in tiles.items():
        (OUT / "t" / f"{key}.json").write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False),
                                               encoding="utf-8")
    trails = {name: {k: v for k, v in info.items() if k not in ("access", "orient_from", "min_piece_m", "authority_surface_over")}
              for name, info in curated["trails"].items()}
    (OUT / "index.json").write_text(json.dumps({
        "region": region, "bbox": pruned["bbox"], "tiles": sorted(tiles), "sources": curated["sources"],
        "trails": trails, "flags": {"closed": classify.CLOSED, "road": classify.ROAD,
                                    "dismount": classify.DISMOUNT, "bridge": classify.BRIDGE},
        "surfaces": classify.SURFACES, "access": ACCESS,
    }, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    size = sum(f.stat().st_size for f in (OUT / "t").glob("*.json"))
    print(f"{len(tiles)} tiles, {size / 1e6:.1f} MB, "
          f"{sum(len(t['access']) for t in tiles.values())} access points -> {OUT}")


if __name__ == "__main__":
    main(*sys.argv[1:])
