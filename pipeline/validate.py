"""Check the new network pipeline against the pilot (docs/data/trails.json).

For each pilot trail piece, route between the same endpoints over the new network and compare
length, climb, max 100 m grade and flagged distance. Big differences mean a connectivity,
elevation or bridge-handling problem in the new pipeline.
"""
import heapq
import json
import pathlib
import sys

import classify
import geo

ROOT = pathlib.Path(__file__).resolve().parent.parent


def profile(path, edges, elev):
    """Concatenate per-edge elevation (dm, even step) along a node path -> [(dist m, ele m, flags)]."""
    out, d0 = [], 0.0
    for (n, eid) in path:
        e, ev = edges[eid], elev[str(eid)]
        vals = ev["ele"] if e["a"] == n else ev["ele"][::-1]
        f = classify.flags(e["tags"])
        for k, v in enumerate(vals if not out else vals[1:]):
            out.append((d0 + (k if not out else k + 1) * ev["step"], v / 10, f))
        d0 = out[-1][0]
    return out


def stats(prof):
    # resample to 10 m and smooth like the pilot did
    res, k = [], 0
    end = prof[-1][0]
    d = 0.0
    while d <= end:
        while k < len(prof) - 2 and prof[k + 1][0] < d:
            k += 1
        (d1, e1, _), (d2, e2, _) = prof[k], prof[min(k + 1, len(prof) - 1)]
        res.append(e1 + (e2 - e1) * ((d - d1) / (d2 - d1) if d2 > d1 else 0))
        d += 10
    sm = [sum(res[max(0, i - 2):i + 3]) / len(res[max(0, i - 2):i + 3]) for i in range(len(res))]
    climb = sum(max(0, b - a) for a, b in zip(sm, sm[1:]))
    g = max((abs(sm[i + 10] - sm[i]) / 100 * 100 for i in range(len(sm) - 10)), default=0)
    closed = sum(b[0] - a[0] for a, b in zip(prof, prof[1:]) if b[2] & classify.CLOSED)
    road = sum(b[0] - a[0] for a, b in zip(prof, prof[1:]) if b[2] & classify.ROAD)
    return end, climb, g, closed, road


def main(region="newcastle"):
    pruned = json.loads((ROOT / "cache" / f"pruned-{region}.json").read_text())
    elev = json.loads((ROOT / "cache" / f"elev-{region}.json").read_text())
    edges = {e["id"]: e for e in pruned["edges"]}
    adj, xy = {}, {}
    for e in pruned["edges"]:
        adj.setdefault(e["a"], []).append((e["b"], e))
        adj.setdefault(e["b"], []).append((e["a"], e))
        xy[e["a"]], xy[e["b"]] = e["geom"][0], e["geom"][-1]
    pilot = json.loads((ROOT / "data" / "pilot-reference.json").read_text())
    FT, MI = 3.28084, 1609.34
    for t in pilot["trails"]:
        for k, p in enumerate(t["pieces"]):
            s = min(xy, key=lambda n: geo.dist(xy[n], (p["lat"][0], p["lon"][0])))
            g = min(xy, key=lambda n: geo.dist(xy[n], (p["lat"][-1], p["lon"][-1])))
            best, prev, heap = {s: 0.0}, {}, [(0.0, s)]
            while heap:
                d, n = heapq.heappop(heap)
                if n == g:
                    break
                if d > best[n]:
                    continue
                for m, e in adj[n]:
                    # prefer the named trail: other edges cost 3x so the route doesn't shortcut
                    nd = d + e["len_m"] * (1 if e["tags"].get("name") == t["name"] else 3)
                    if nd < best.get(m, 1e18):
                        best[m], prev[m] = nd, (n, e["id"])
                        heapq.heappush(heap, (nd, m))
            if g not in prev:
                print(f"{t['name']} p{k + 1}: NO ROUTE in new network")
                continue
            path, n = [], g
            while n != s:
                pn, eid = prev[n]
                path.append((pn, eid))
                n = pn
            path.reverse()
            new = stats(profile(path, edges, elev))
            D, E, F = p["d"], p["ele"], p["f"]
            old_g = max(abs(E[i + 10] - E[i]) / (D[i + 10] - D[i]) * 100 for i in range(len(D) - 10))
            old_climb = sum(max(0, b - a) for a, b in zip(E, E[1:]))
            old_closed = sum(D[i + 1] - D[i] for i in range(len(D) - 1) if F[i + 1] & 1)
            old_road = sum(D[i + 1] - D[i] for i in range(len(D) - 1) if F[i + 1] & 2)
            src = sorted({elev[str(eid)]["src"] for _, eid in path})
            print(f"{t['name'][:24]:24s} p{k + 1}  len {D[-1] / MI:5.2f} -> {new[0] / MI:5.2f} mi | "
                  f"climb {old_climb * FT:4.0f} -> {new[1] * FT:4.0f} ft | max {old_g:4.1f} -> {new[2]:4.1f}% | "
                  f"closed {old_closed:4.0f} -> {new[3]:4.0f} m | road {old_road:4.0f} -> {new[4]:4.0f} m | dem {src}")


if __name__ == "__main__":
    main(*sys.argv[1:])
