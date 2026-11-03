"""Public land ownership for e-bike rules: which agency manages the land under each trail.

Sources (public; provided as-is with no warranty):
  - King County GIS: Parks in King County (owner/manager per park, current)
  - DNR Managed Land Parcels (ownership parcels, PARCEL_TYPE_CD = 1)
  - Non-DNR Major Public Lands (federal, state, county, city; marked deprecated, last content
    update 2021, but the only statewide layer for non-DNR owners)

Output cache/land-<region>.json: [{agency, owner, manager, name, rings}]
"""
import json
import pathlib
import sys
import urllib.parse

import net
import network
import parking

ROOT = pathlib.Path(__file__).resolve().parent.parent
DNR = "https://gis.dnr.wa.gov/site3/rest/services/Public_Boundaries/WADNR_PUBLIC_Cadastre_OpenData/FeatureServer/6/query"
NDMPL = "https://gis.dnr.wa.gov/site3/rest/services/Public_Boundaries/WADNR_PUBLIC_Major_Public_Lands_NonDNR/MapServer/1/query"
COUNTIES = "https://gis.dnr.wa.gov/site3/rest/services/Public_Boundaries/WADNR_PUBLIC_Cadastre_OpenData/FeatureServer/11/query"
# King County GIS "Parks in King County" (park_area); free to use, not to sell
KC_PARKS = "https://services.arcgis.com/Ej0PsM5Aw677QF1W/arcgis/rest/services/PARK_AREA_228/FeatureServer/0/query"
PAGE = 1000


def agency(owner, manager):
    """Map NDMPL owner/manager text to the agency keys the e-bike rules use."""
    text = f"{owner or ''} | {manager or ''}".lower()
    if "natural resources" in text and ("washington" in text or "wa " in text or "state" in text):
        return "dnr"
    if "us fish and wildlife" in text:
        return "other-public"
    if "parks and recreation commission" in text or "state parks" in text:
        return "wa-parks"
    if "fish and wildlife" in text and ("washington" in text or "wa " in text or "state" in text):
        return "wdfw"
    if "forest service" in text:
        return "usfs"
    if "national park" in text:
        return "nps"
    if "king county" in text:
        return "king-county"
    if "defense" in text or "army" in text or "navy" in text or "air force" in text:
        return "military"
    if "tribe" in text or "tribal" in text or "indian" in text:
        return "tribal"
    if "city" in text or "town" in text or "municipal" in text:
        return "city"
    if "county" in text:
        return "county"
    return "other-public"


def fetch_all(url, where, fields, bbox):
    s, w, n, e = bbox
    feats, offset = [], 0
    while True:
        q = urllib.parse.urlencode({
            "where": where, "outFields": fields, "returnGeometry": "true", "f": "geojson",
            "geometry": f"{w},{s},{e},{n}", "geometryType": "esriGeometryEnvelope", "inSR": 4326,
            "spatialRel": "esriSpatialRelIntersects", "outSR": 4326,
            "resultOffset": offset, "resultRecordCount": PAGE})
        res = json.loads(net.fetch(f"{url}?{q}"))
        batch = res.get("features", [])
        feats += batch
        print(f"  {len(feats)} features", flush=True)
        if len(batch) < PAGE and not res.get("exceededTransferLimit") and not res.get("properties", {}).get("exceededTransferLimit"):
            return feats
        offset += len(batch)


def rings(geom):
    if not geom:
        return []
    polys = [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]
    # outer rings only, as (lat, lon)
    return [[[round(p[1], 6), round(p[0], 6)] for p in poly[0]] for poly in polys]


def main(region="newcastle"):
    bbox = network.bbox(**network.REGIONS[region])
    out = []
    print("DNR managed parcels")
    for f in fetch_all(DNR, "PARCEL_TYPE_CD = 1", "PARCEL_NM", bbox):
        out.append({"agency": "dnr", "owner": "WA DNR", "manager": "WA DNR",
                    "name": f["properties"].get("PARCEL_NM"), "rings": rings(f["geometry"])})
    print("Non-DNR major public lands")
    for f in fetch_all(NDMPL, "1=1", "NAME,OWNER,MANAGER,MANAGEMENT_TYPE", bbox):
        p = f["properties"]
        out.append({"agency": agency(p.get("OWNER"), p.get("MANAGER")), "owner": p.get("OWNER"),
                    "manager": p.get("MANAGER"), "name": p.get("NAME"), "rings": rings(f["geometry"])})
    print("King County parks")
    for f in fetch_all(KC_PARKS, "1=1", "SITENAME,OWNER,OWNERTYPE,MANAGER,MANAGETYPE", bbox):
        p = f["properties"]
        kind = (p.get("OWNERTYPE") or "").lower()
        a = ("king-county" if "king county parks" in kind or "king county parks" in (p.get("MANAGER") or "").lower()
             else "city" if kind == "city" else agency(p.get("OWNER"), p.get("MANAGER")))
        out.append({"agency": a, "owner": p.get("OWNER"), "manager": p.get("MANAGER"), "name": p.get("SITENAME"),
                    "rings": rings(f["geometry"]), "source": "kc-parks"})
    # OSM park outlines with a named operator fill gaps in the (2021) agency layer
    areas = json.loads((ROOT / "cache" / f"areas-{region}.json").read_text())
    for pk in areas["parks"]:
        op = pk.get("operator")
        if not op:
            continue
        a = agency(op, op)
        if a in ("other-public", "county") and "king county" not in op.lower():
            continue
        out.append({"agency": a, "owner": op, "manager": op, "name": pk.get("name"), "rings": pk["rings"], "source": "osm"})
    # county-owned land only carries "County"; King County's park rules apply inside King County
    print("County boundaries")
    counties = [{"name": f["properties"].get("JURISDICT_NM"), "rings": rings(f["geometry"])}
                for f in fetch_all(COUNTIES, "1=1", "JURISDICT_NM", bbox)]
    king = [c for c in counties if (c["name"] or "").lower().startswith("king")]
    for o in out:
        if o["agency"] == "county" and o["rings"]:
            ring = o["rings"][0]
            pt = (sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring))
            if any(parking.inside(pt, [tuple(q) for q in r]) for c in king for r in c["rings"]):
                o["agency"] = "king-county"
    path = ROOT / "cache" / f"land-{region}.json"
    path.write_text(json.dumps(out))
    by = {}
    for o in out:
        by[o["agency"]] = by.get(o["agency"], 0) + 1
    print(len(out), "parcels ->", path, by)


if __name__ == "__main__":
    main(*sys.argv[1:])


# where parcels overlap, the more specific land manager wins
PRIORITY = ["dnr", "wdfw", "wa-parks", "usfs", "nps", "military", "tribal", "king-county", "city", "county",
            "other-public"]


class LandIndex:
    """Which agency manages the land at a point (grid-bucketed polygon lookup)."""

    def __init__(self, parcels, cell=0.02):
        self.cell, self.grid = cell, {}
        for o in parcels:
            for ring in o["rings"]:
                if len(ring) < 3:
                    continue
                lats, lons = [p[0] for p in ring], [p[1] for p in ring]
                box = (min(lats), min(lons), max(lats), max(lons))
                item = (box, [tuple(p) for p in ring], o)
                for i in range(int(box[0] / cell), int(box[2] / cell) + 1):
                    for j in range(int(box[1] // cell), int(box[3] // cell) + 1):
                        self.grid.setdefault((i, j), []).append(item)

    def at(self, pt):
        best = None
        for (s, w, n, e), ring, o in self.grid.get((int(pt[0] / self.cell), int(pt[1] // self.cell)), ()):
            if s <= pt[0] <= n and w <= pt[1] <= e and parking.inside(tuple(pt), ring):
                if best is None or PRIORITY.index(o["agency"]) < PRIORITY.index(best["agency"]):
                    best = o
        return best
