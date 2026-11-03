"""Reduce the raw regional network to what the site routes on.

Keeps path-type edges (minus sidewalk-crossing stubs and tiny fragments) and only those road
edges that form a short (<= MAX_CONNECTOR m) link between two separate parts of the path
network, e.g. a trail that briefly uses a road bridge.

Input: cache/network-<region>.json   Output: cache/pruned-<region>.json
"""
import heapq
import json
import pathlib
import sys

import classify
import geo

ROOT = pathlib.Path(__file__).resolve().parent.parent
MAX_CONNECTOR = 300.0
MIN_COMPONENT = 100.0
MAX_JOIN = 25.0


def is_stub(t):
    return t["highway"] == "footway" and t.get("footway") in ("crossing", "access_aisle", "traffic_island")


def components(edges):
    adj = {}
    for e in edges:
        adj.setdefault(e["a"], []).append(e)
        adj.setdefault(e["b"], []).append(e)
    comp, cid = {}, 0
    for start in adj:
        if start in comp:
            continue
        stack = [start]
        while stack:
            n = stack.pop()
            if n in comp:
                continue
            comp[n] = cid
            for e in adj[n]:
                for m in (e["a"], e["b"]):
                    if m not in comp:
                        stack.append(m)
        cid += 1
    return comp


def join_gaps(paths, comp, max_gap=MAX_JOIN):
    """Unmapped links: two dead ends this close, in separate parts of the network, are almost
    always one trail interrupted by an unmapped crossing or a node that wasn't merged."""
    deg, xy = {}, {}
    for e in paths:
        for n, p in ((e["a"], e["geom"][0]), (e["b"], e["geom"][-1])):
            deg[n] = deg.get(n, 0) + 1
            xy[n] = p
    ends = [n for n, d in deg.items() if d == 1]
    cell = 0.0005
    grid = {}
    for n in ends:
        grid.setdefault((int(xy[n][0] / cell), int(xy[n][1] / cell)), []).append(n)
    joins, used = [], set()
    for n in ends:
        if n in used:
            continue
        ci, cj = int(xy[n][0] / cell), int(xy[n][1] / cell)
        cands = [(geo.dist(xy[n], xy[m]), m) for i in (ci - 1, ci, ci + 1) for j in (cj - 1, cj, cj + 1)
                 for m in grid.get((i, j), ()) if m != n and m not in used and comp[m] != comp[n]]
        cands = [c for c in cands if c[0] <= max_gap]
        if cands:
            d, m = min(cands)
            used |= {n, m}
            joins.append({"id": -(len(joins) + 1), "way": None, "a": n, "b": m, "geom": [xy[n], xy[m]],
                          "len_m": round(d, 1), "cls": "join", "tags": {"highway": "path", "note": "unmapped join"}})
    print(f"{len(joins)} unmapped joins added")
    return joins


def main(region="newcastle"):
    raw = json.loads((ROOT / "cache" / f"network-{region}.json").read_text())
    paths = [e for e in raw["edges"] if e["cls"] == "path" and not is_stub(e["tags"])]
    roads = [e for e in raw["edges"] if e["cls"] == "road" and classify.bike(e["tags"])[0] != "no"]

    comp = components(paths)
    size = {}
    for e in paths:
        size[comp[e["a"]]] = size.get(comp[e["a"]], 0) + e["len_m"]
    paths = [e for e in paths if size[comp[e["a"]]] >= MIN_COMPONENT]
    paths += join_gaps(paths, comp)
    path_nodes = {n for e in paths for n in (e["a"], e["b"])}

    radj = {}
    for e in roads:
        radj.setdefault(e["a"], []).append((e["b"], e))
        radj.setdefault(e["b"], []).append((e["a"], e))
    seeds = [n for n in path_nodes if n in radj]
    keep = {}
    for s in seeds:
        best, prev, heap = {s: 0.0}, {}, [(0.0, s)]
        while heap:
            d, n = heapq.heappop(heap)
            if d > best[n]:
                continue
            if n != s and n in path_nodes and comp[n] != comp[s]:
                while n != s:  # record the road edges of this connector
                    p, e = prev[n]
                    keep[e["id"]] = e
                    n = p
                continue
            for m, e in radj[n]:
                nd = d + e["len_m"]
                if nd <= MAX_CONNECTOR and nd < best.get(m, float("inf")):
                    best[m], prev[m] = nd, (n, e)
                    heapq.heappush(heap, (nd, m))

    edges = paths + list(keep.values())
    used = {n for e in edges for n in (e["a"], e["b"])}
    out = ROOT / "cache" / f"pruned-{region}.json"
    out.write_text(json.dumps({"region": region, "bbox": raw["bbox"],
                               "nodes": {k: v for k, v in raw["nodes"].items() if int(k) in used},
                               "edges": edges}))
    km = lambda es: sum(e["len_m"] for e in es) / 1000
    print(f"paths {len(paths)} edges / {km(paths):.0f} km; connectors {len(keep)} edges / "
          f"{km(keep.values()):.0f} km; 1 m set {km([e for e in edges if classify.precise_elevation(e['tags'])]):.0f} km -> {out}")


if __name__ == "__main__":
    main(*sys.argv[1:])
