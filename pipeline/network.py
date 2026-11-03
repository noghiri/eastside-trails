"""Extract the path network for a region from the Geofabrik extract.

Output: cache/network-<region>.json with
  nodes: {id: [lat, lon]}
  edges: [{id, way, a, b, geom: [[lat, lon], ...], len_m, cls, tags}]
Edges are split at junctions so routing works on a proper graph. Direction rules are kept
as tags; directed edges are derived at routing time.
"""
import json
import math
import pathlib
import sys

import osmium

import geo

ROOT = pathlib.Path(__file__).resolve().parent.parent
PBF = ROOT / "cache" / "geofabrik" / "washington-latest.osm.pbf"

REGIONS = {"newcastle": {"center": (47.5301, -122.1557), "radius_mi": 35}}

PATHS = {"cycleway", "path", "footway", "track", "bridleway", "pedestrian", "steps", "construction"}
ROADS = {"primary", "secondary", "tertiary", "unclassified", "residential", "service", "living_street",
         "primary_link", "secondary_link", "tertiary_link", "trunk", "trunk_link"}
KEEP_TAGS = {"highway", "name", "surface", "tracktype", "smoothness", "access", "bicycle", "foot", "horse",
             "motor_vehicle", "motorcycle", "motorcar", "vehicle", "oneway", "oneway:bicycle", "oneway:foot",
             "bridge", "tunnel", "layer", "footway", "service", "construction", "mtb:scale",
             "mtb:scale:uphill", "sac_scale", "trail_visibility", "width", "incline", "seasonal",
             "conditional", "bicycle:conditional", "access:conditional", "dog", "crossing", "lit"}


def bbox(center, radius_mi):
    dlat = radius_mi * 1609.34 / 111320
    dlon = dlat / math.cos(math.radians(center[0]))
    return center[0] - dlat, center[1] - dlon, center[0] + dlat, center[1] + dlon


def wanted(tags):
    h = tags.get("highway")
    if h in PATHS:
        # sidewalks are mapped as footways but aren't trails; crossings are kept as connectors
        return tags.get("footway") != "sidewalk"
    return h in ROADS


def main(region="newcastle"):
    s, w, n, e = bbox(**REGIONS[region])
    ways = []
    fp = (osmium.FileProcessor(str(PBF), osmium.osm.NODE | osmium.osm.WAY)
          .with_locations()
          .with_filter(osmium.filter.KeyFilter("highway")))
    for way in fp:
        if not way.is_way():
            continue
        tags = dict(way.tags)
        if not wanted(tags):
            continue
        pts = [(nd.ref, nd.location.lat, nd.location.lon) for nd in way.nodes if nd.location.valid()]
        if len(pts) < 2 or not any(s <= la <= n and w <= lo <= e for _, la, lo in pts):
            continue
        ways.append({"id": way.id, "pts": pts, "tags": {k: v for k, v in tags.items() if k in KEEP_TAGS}})

    # junctions: nodes shared by ways, plus way endpoints
    use = {}
    for wy in ways:
        for ref, _, _ in wy["pts"]:
            use[ref] = use.get(ref, 0) + 1
    nodes, edges = {}, []
    for wy in ways:
        pts = wy["pts"]
        start = 0
        for k in range(1, len(pts)):
            if k == len(pts) - 1 or use[pts[k][0]] > 1:
                seg = pts[start:k + 1]
                geom = [[round(la, 7), round(lo, 7)] for _, la, lo in seg]
                length = sum(geo.dist(a, b) for a, b in zip(geom, geom[1:]))
                for ref, la, lo in (seg[0], seg[-1]):
                    nodes[ref] = [round(la, 7), round(lo, 7)]
                edges.append({"id": len(edges), "way": wy["id"], "a": seg[0][0], "b": seg[-1][0],
                              "geom": geom, "len_m": round(length, 1),
                              "cls": "road" if wy["tags"]["highway"] in ROADS else "path",
                              "tags": wy["tags"]})
                start = k
    out = ROOT / "cache" / f"network-{region}.json"
    out.write_text(json.dumps({"region": region, "bbox": [s, w, n, e], "nodes": nodes, "edges": edges}))

    km = {}
    for ed in edges:
        km[ed["tags"]["highway"]] = km.get(ed["tags"]["highway"], 0) + ed["len_m"] / 1000
    print(f"{len(ways)} ways, {len(edges)} edges, {len(nodes)} nodes -> {out}")
    for h, v in sorted(km.items(), key=lambda x: -x[1]):
        print(f"  {h:15s} {v:9.0f} km")


POI_KINDS = {("amenity", "toilets"): "toilets", ("amenity", "drinking_water"): "water",
             ("tourism", "viewpoint"): "viewpoint", ("highway", "trailhead"): "trailhead",
             ("amenity", "parking"): "parking"}
POI_TAGS = {"name", "fee", "access", "capacity", "operator", "opening_hours", "wheelchair", "seasonal",
            "addr:housenumber", "addr:street", "addr:city", "parking", "charge"}


def pois(region="newcastle"):
    """Amenities near trails: nodes, plus centroids of mapped areas (e.g. parking lots)."""
    s, w, n, e = bbox(**REGIONS[region])
    out = []
    fp = (osmium.FileProcessor(str(PBF), osmium.osm.NODE | osmium.osm.WAY)
          .with_locations()
          .with_filter(osmium.filter.KeyFilter("amenity", "tourism", "highway")))
    for obj in fp:
        tags = dict(obj.tags)
        kind = next((v for (k, val), v in POI_KINDS.items() if tags.get(k) == val), None)
        if not kind:
            continue
        if obj.is_node():
            lat, lon = obj.location.lat, obj.location.lon
        else:
            locs = [nd.location for nd in obj.nodes if nd.location.valid()]
            if not locs:
                continue
            lat, lon = sum(l.lat for l in locs) / len(locs), sum(l.lon for l in locs) / len(locs)
        if s <= lat <= n and w <= lon <= e:
            out.append({"osm": f"{'node' if obj.is_node() else 'way'}/{obj.id}", "kind": kind,
                        "lat": round(lat, 6), "lon": round(lon, 6),
                        "tags": {k: v for k, v in tags.items() if k in POI_TAGS}})
    path = ROOT / "cache" / f"pois-{region}.json"
    path.write_text(json.dumps(out))
    print(len(out), "pois ->", path)


PARK_KINDS = {("leisure", "park"), ("leisure", "nature_reserve"), ("boundary", "protected_area"),
              ("leisure", "recreation_ground")}
# grounds whose untagged paths are not open to the public by default
OFF_LIMITS_KINDS = {("leisure", "golf_course"), ("landuse", "cemetery"), ("amenity", "grave_yard"),
                    ("landuse", "military"), ("aeroway", "aerodrome")}


def areas(region="newcastle"):
    """Parking lots and parks as areas, including multipolygon relations (which `pois` misses).

    Output cache/areas-<region>.json: {"parking": [...], "parks": [...], "off_limits": [{osm, kind, name, rings}]}
    """
    s, w, n, e = bbox(**REGIONS[region])
    parking, parks, off_limits = [], [], []
    fp = (osmium.FileProcessor(str(PBF))
          .with_areas(osmium.filter.KeyFilter("amenity", "leisure", "boundary", "landuse", "aeroway"))
          .with_filter(osmium.filter.EntityFilter(osmium.osm.AREA)))
    for a in fp:
        tags = dict(a.tags)
        is_parking = tags.get("amenity") == "parking"
        is_park = any(tags.get(k) == v for k, v in PARK_KINDS)
        off = next((f"{k}={v}" for k, v in OFF_LIMITS_KINDS if tags.get(k) == v), None)
        if not (is_parking or is_park or off):
            continue
        rings = [[(p.lat, p.lon) for p in ring if p.location.valid()] for ring in a.outer_rings()]
        rings = [r for r in rings if len(r) >= 3]
        if not rings:
            continue
        pts = [p for r in rings for p in r]
        lat, lon = sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)
        if not (s <= lat <= n and w <= lon <= e):
            continue
        osm = f"{'way' if a.from_way() else 'relation'}/{a.orig_id()}"
        if is_parking:
            parking.append({"osm": osm, "lat": round(lat, 6), "lon": round(lon, 6),
                            "ring": [[round(p[0], 6), round(p[1], 6)] for p in rings[0]],
                            "tags": {k: v for k, v in tags.items() if k in POI_TAGS | {"park_ride", "operator:type"}}})
        if off:
            off_limits.append({"osm": osm, "kind": off, "name": tags.get("name"),
                               "rings": [[[round(p[0], 6), round(p[1], 6)] for p in r] for r in rings]})
        if is_park:
            parks.append({"osm": osm, "name": tags.get("name"), "operator": tags.get("operator"),
                          "rings": [[[round(p[0], 6), round(p[1], 6)] for p in r] for r in rings]})
    path = ROOT / "cache" / f"areas-{region}.json"
    path.write_text(json.dumps({"parking": parking, "parks": parks, "off_limits": off_limits}))
    print(len(parking), "parking areas,", len(parks), "parks,", len(off_limits), "off-limits grounds ->", path)


if __name__ == "__main__":
    if sys.argv[1:2] == ["areas"]:
        areas(*sys.argv[2:])
    elif sys.argv[1:2] == ["pois"]:
        pois(*sys.argv[2:])
    else:
        main(*sys.argv[1:])
