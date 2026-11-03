"""Sample elevation along every pruned edge, in resumable per-area batches.

Edges in the precise set (classify.precise_elevation) and road connectors use 1 m lidar,
falling back to 10 m where no 1 m tile exists; everything else uses 10 m. Bridges and
tunnels are interpolated between the elevations of the ground segments they connect, since
DEMs show the ground under a bridge.

  python elevate.py split [region]   pruned network -> cache/batches/<region>/<tile>.json
  python elevate.py run [region]     sample each batch not yet done -> cache/elev/<region>/<tile>.json
  python elevate.py merge [region]   combine batches, fix bridges -> cache/elev-<region>.json
                                     {edge_id: {"src": 1 | 10, "step": m, "ele": [dm, ...]}}
"""
import json
import math
import pathlib
import sys
import time

import classify
import dem
import geo

ROOT = pathlib.Path(__file__).resolve().parent.parent
STEP = 10.0
APPROACH = 20.0  # metres of bridge approach levelled to the ground beyond it
MAX_BRIDGE_GAP = 30.0  # untagged pieces shorter than this between bridges count as bridge


def densify(geom, length):
    """Points at even spacing (<= STEP) along geom, endpoints included."""
    n = max(1, math.ceil(length / STEP))
    step = length / n if length else 0
    cum = [0.0]
    for a, b in zip(geom, geom[1:]):
        cum.append(cum[-1] + geo.dist(a, b))
    out, k = [], 0
    for i in range(n + 1):
        t = min(i * step, cum[-1])
        while k < len(cum) - 2 and cum[k + 1] < t:
            k += 1
        seg = cum[k + 1] - cum[k] or 1
        f = (t - cum[k]) / seg
        a, b = geom[k], geom[k + 1]
        out.append((a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f))
    return out, step


def dirs(region):
    return ROOT / "cache" / "batches" / region, ROOT / "cache" / "elev" / region


def split(region):
    pruned = json.loads((ROOT / "cache" / f"pruned-{region}.json").read_text())
    src, _ = dirs(region)
    src.mkdir(parents=True, exist_ok=True)
    batches = {}
    for e in pruned["edges"]:
        lat, lon = e["geom"][len(e["geom"]) // 2]
        batches.setdefault(f"{math.floor(lat * 10)}_{math.floor(lon * 10)}", []).append(e)
    for key, edges in batches.items():
        (src / f"{key}.json").write_text(json.dumps(edges))
    (src / "_bbox.json").write_text(json.dumps(pruned["bbox"]))
    print(f"{len(batches)} batches, {len(pruned['edges'])} edges -> {src}")


def run(region):
    src, dst = dirs(region)
    dst.mkdir(parents=True, exist_ok=True)
    curated = set(json.loads((ROOT / "data" / "curated.json").read_text(encoding="utf-8"))["trails"])
    precise = lambda e: e["cls"] in ("road", "join") or classify.precise_elevation(e["tags"], curated)

    def stale(path):
        """Redo a batch when its edges or their 1 m eligibility changed since it was sampled."""
        out = dst / path.name
        if not out.exists():
            return True
        done = json.loads(out.read_text())
        edges = json.loads(path.read_text())
        return ({str(e["id"]) for e in edges} != set(done)
                or any(done[str(e["id"])].get("precise") != precise(e) for e in edges))

    todo = sorted(p for p in src.glob("*.json") if not p.name.startswith("_") and stale(p))
    d10, d1 = dem.DEM(), dem.DEM1m(json.loads((src / "_bbox.json").read_text()))
    t0 = time.time()
    for k, path in enumerate(todo):
        res = {}
        for e in json.loads(path.read_text()):
            pts, step = densify(e["geom"], e["len_m"])
            p1 = precise(e)
            vals = d1.sample_many(pts) if p1 else [math.nan] * len(pts)
            r = 1 if p1 and not any(math.isnan(v) for v in vals) else 10
            if r == 10:
                vals = [d10.sample(*p) for p in pts]
            res[e["id"]] = {"src": r, "step": round(step, 2), "ele": [round(v * 10) for v in vals],
                            "a": e["a"], "b": e["b"], "precise": p1,
                            "bridge": bool(classify.flags(e["tags"]) & classify.BRIDGE)}
        # written last, so an interrupted batch is simply redone
        (dst / path.name).write_text(json.dumps(res, separators=(",", ":")))
        print(f"batch {k + 1}/{len(todo)} {path.stem}: {len(res)} edges, {time.time() - t0:.0f}s", flush=True)
    d1.close()
    d10.close()


def merge(region):
    _, dst = dirs(region)
    res = {}
    for path in dst.glob("*.json"):
        res.update(json.loads(path.read_text()))
    # DEMs show the ground under a bridge, and the last metres before an abutment often already
    # dip toward the gap. Take each bridge end's elevation from the ground ~APPROACH m back,
    # level the approach to it, and span the bridge linearly between its two ends.
    bridge_nodes = {n for r in res.values() if r["bridge"] for n in (r["a"], r["b"])}
    # a short untagged piece between two bridge spans is a tagging gap or a pier, not ground
    for r in res.values():
        if not r["bridge"] and r["step"] * (len(r["ele"]) - 1) < MAX_BRIDGE_GAP                 and r["a"] in bridge_nodes and r["b"] in bridge_nodes:
            r["bridge"] = True
    back = {}
    for r in res.values():
        if r["bridge"]:
            continue
        k = min(len(r["ele"]) - 1, max(1, round(APPROACH / r["step"]))) if r["step"] else 0
        if r["a"] in bridge_nodes:
            back.setdefault(r["a"], []).append(r["ele"][k])
        if r["b"] in bridge_nodes:
            back.setdefault(r["b"], []).append(r["ele"][-1 - k])
    level = {n: sum(v) / len(v) for n, v in back.items()}
    # chained bridge edges (e.g. a span split by a node mid-bridge): interior nodes get no ground
    # reading, so interpolate them by distance between the chain's grounded ends
    badj = {}
    for r in res.values():
        if r["bridge"]:
            length = r["step"] * (len(r["ele"]) - 1)
            badj.setdefault(r["a"], []).append((r["b"], length))
            badj.setdefault(r["b"], []).append((r["a"], length))
    for start in [n for n in badj if n in level]:
        stack = [(start, 0.0, [])]
        while stack:
            n, d, trail = stack.pop()
            for m, length in badj[n]:
                if any(m == t for t, _ in trail) or m == start:
                    continue
                if m in level:
                    total = d + length
                    for node, dist in trail:
                        if node not in level:
                            level[node] = level[start] + (level[m] - level[start]) * dist / max(total, 1)
                elif len(trail) < 20:
                    stack.append((m, d + length, trail + [(m, d + length)]))
    for r in res.values():
        if r["bridge"]:
            v = r["ele"]
            a, b = level.get(r["a"], v[0]), level.get(r["b"], v[-1])
            n = len(v) - 1
            r["ele"] = [round(a + (b - a) * i / max(n, 1)) for i in range(n + 1)]
            continue
        k = min(len(r["ele"]) - 1, max(1, round(APPROACH / r["step"]))) if r["step"] else 0
        if r["a"] in level:
            for i in range(k):
                r["ele"][i] = round(level[r["a"]])
        if r["b"] in level:
            for i in range(k):
                r["ele"][-1 - i] = round(level[r["b"]])
    out = ROOT / "cache" / f"elev-{region}.json"
    out.write_text(json.dumps({k: {"src": r["src"], "step": r["step"], "ele": r["ele"]} for k, r in res.items()},
                              separators=(",", ":")))
    n1 = sum(1 for r in res.values() if r["src"] == 1)
    print(f"{len(res)} edges ({n1} at 1 m) -> {out}")


if __name__ == "__main__":
    {"split": split, "run": run, "merge": merge}[sys.argv[1]](*(sys.argv[2:] or ["newcastle"]))
