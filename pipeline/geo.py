"""Geometry helpers: distances, trail graph assembly, resampling."""
import heapq
import math

R = 6371000.0


def dist(a, b):
    """Equirectangular distance in metres between (lat, lon) pairs; fine at trail scale."""
    x = math.radians(b[1] - a[1]) * math.cos(math.radians((a[0] + b[0]) / 2))
    y = math.radians(b[0] - a[0])
    return R * math.hypot(x, y)


def _key(p):
    return (round(p["lat"], 7), round(p["lon"], 7))


def build_graph(ways):
    """Adjacency {node: [(neighbor, metres, way)]} with nodes keyed by rounded coordinate."""
    adj = {}
    for w in ways:
        pts = [_key(p) for p in w["geometry"]]
        for a, b in zip(pts, pts[1:]):
            d = dist(a, b)
            adj.setdefault(a, []).append((b, d, w))
            adj.setdefault(b, []).append((a, d, w))
    return adj


def components(adj):
    seen, out = set(), []
    for start in adj:
        if start in seen:
            continue
        comp, stack = set(), [start]
        while stack:
            n = stack.pop()
            if n in comp:
                continue
            comp.add(n)
            stack.extend(m for m, _, _ in adj[n] if m not in comp)
        seen |= comp
        out.append(comp)
    return out


def _dijkstra(adj, src):
    best, prev, heap = {src: 0.0}, {}, [(0.0, src)]
    while heap:
        d, n = heapq.heappop(heap)
        if d > best[n]:
            continue
        for m, w, way in adj[n]:
            nd = d + w
            if nd < best.get(m, math.inf):
                best[m], prev[m] = nd, (n, way)
                heapq.heappush(heap, (nd, m))
    return best, prev


def main_line(adj, comp):
    """Longest shortest-path through a component: the trail's spine, ignoring short spurs.

    Returns [(node, way_of_edge_leading_here)], first entry's way is None.
    """
    start = next(iter(comp))
    best, _ = _dijkstra(adj, start)
    a = max(best, key=best.get)
    best, prev = _dijkstra(adj, a)
    b = max(best, key=best.get)
    path, n = [], b
    while n != a:
        p, way = prev[n]
        path.append((n, way))
        n = p
    path.append((a, None))
    return path[::-1]


def resample(line, step=10.0):
    """Points every `step` metres along line: dicts with lat, lon, d (metres), way."""
    out = [{"lat": line[0][0][0], "lon": line[0][0][1], "d": 0.0, "way": line[1][1]}]
    total, carry = 0.0, 0.0
    for (a, _), (b, way) in zip(line, line[1:]):
        seg = dist(a, b)
        t = step - carry
        while t <= seg:
            f = t / seg
            out.append({"lat": a[0] + (b[0] - a[0]) * f, "lon": a[1] + (b[1] - a[1]) * f,
                        "d": total + t, "way": way})
            t += step
        carry = seg - (t - step)
        total += seg
    if carry > 1.0:
        b, way = line[-1]
        out.append({"lat": b[0], "lon": b[1], "d": total, "way": way})
    return out


def nearest(samples, p):
    """(index, metres) of the sample closest to p=(lat, lon)."""
    best = min(range(len(samples)), key=lambda i: dist((samples[i]["lat"], samples[i]["lon"]), p))
    return best, dist((samples[best]["lat"], samples[best]["lon"]), p)
