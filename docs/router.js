"use strict";
// Ride-generation worker: loads network tiles, builds a directed graph, generates and
// evaluates rides (out-and-back, loop, lollipop, one-way) from parking points.

const CLOSED = 1, ROAD = 2, DISMOUNT = 4, BRIDGE = 8;
const ACC = { no: 0, yes: 1, dismount: 2, unknown: 3 };
const ROAD_WEIGHT = { living_street: 1.3, service: 1.5, residential: 1.5, unclassified: 1.8, tertiary: 2.5,
  tertiary_link: 2.5, secondary: 4, secondary_link: 4, primary: 6, primary_link: 6, trunk: 10, trunk_link: 10 };
const UNKNOWN_SURFACE_OK = new Set(["cycleway", "footway", "pedestrian"]); // usually paved when untagged
const RES = 10, WIN = 10, APPROACH_M = 250, MIN_RIDE_M = 300, SHORT_LINK_M = 30, MAX_FAR_REPEAT_M = 60; // resample spacing (m), grade window in samples (100 m)

let E = [];          // edges
let nodeIdx = new Map(), NX = [], ADJ = []; // node id -> index, coords, adjacency [{k, dir}]
let ACCESS = [], POIS = [], INFO = null;
const NODE_ID = [];
const poiByNode = new Map();

// ---------- loading ----------

function decodePolyline(s, factor = 1e6) {
  const out = [];
  let i = 0, lat = 0, lon = 0;
  while (i < s.length) {
    for (const which of [0, 1]) {
      let shift = 0, result = 0, b;
      do { b = s.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += d; else lon += d;
    }
    out.push([lat / factor, lon / factor]);
  }
  return out;
}

function node(id, lat, lon) {
  let k = nodeIdx.get(id);
  if (k === undefined) { k = NX.length; nodeIdx.set(id, k); NX.push([lat, lon]); ADJ.push([]); }
  return k;
}

function addTile(t) {
  for (const r of t.edges) {
    const g = decodePolyline(r.g);
    const ele = new Float32Array(r.e.length);
    let acc = 0;
    for (let j = 0; j < r.e.length; j++) { acc += r.e[j]; ele[j] = acc / 10; }
    const a = node(r.a, g[0][0], g[0][1]), b = node(r.b, g[g.length - 1][0], g[g.length - 1][1]);
    const k = E.length;
    E.push({ id: r.i, c: r.c, a, b, n: r.n, h: r.h, s: r.s, bk: r.bk, ba: r.ba, ft: r.ft, ow: r.ow, f: r.f,
      m: r.m, sc: r.sc, res: r.r, L: r.L, g, st: r.st, ele, maxG: edgeMaxGrade(ele, r.st) });
    ADJ[a].push({ k, dir: 1 });
    ADJ[b].push({ k, dir: -1 });
  }
  for (const p of t.pois) POIS.push(p);
  for (const a of t.access) ACCESS.push(a);
}

function edgeMaxGrade(ele, st) {
  // steepest 100 m window within the edge, smoothed over ~50 m like ride evaluation so lidar
  // bumps don't block an edge the full ride check would pass; short edges are judged per ride
  if (!st || (ele.length - 1) * st < 100) return 0;
  const h = Math.max(1, Math.round(25 / st)), sm = new Float32Array(ele.length);
  for (let i = 0; i < ele.length; i++) {
    let s = 0, c = 0;
    for (let q = Math.max(0, i - h); q <= Math.min(ele.length - 1, i + h); q++) { s += ele[q]; c++; }
    sm[i] = s / c;
  }
  const w = Math.round(100 / st);
  let m = 0;
  for (let i = 0; i + w < sm.length; i++) m = Math.max(m, Math.abs(sm[i + w] - sm[i]) / (w * st) * 100);
  return m;
}

async function load(center, radiusMi) {
  INFO = await (await fetch("net/index.json")).json();
  const dLat = radiusMi * 1609.34 / 111320 + 0.05, dLon = dLat / Math.cos(center[0] * Math.PI / 180);
  const want = INFO.tiles.filter((key) => {
    const [r, c] = key.split("_").map(Number);
    const lat0 = r / 10, lon0 = c / 10;
    return lat0 + 0.1 >= center[0] - dLat && lat0 <= center[0] + dLat && lon0 + 0.1 >= center[1] - dLon && lon0 <= center[1] + dLon;
  });
  let done = 0;
  for (let i = 0; i < want.length; i += 8) {
    const batch = await Promise.all(want.slice(i, i + 8).map((k) => fetch(`net/t/${k}.json`).then((r) => r.json())));
    batch.forEach(addTile);
    done += batch.length;
    postMessage({ type: "progress", text: `Loading map data ${done}/${want.length}` });
  }
  // adjacency order must not depend on tile fetch order: short ride links count choices in it
  for (const list of ADJ) list.sort((x, y) => E[x.k].id - E[y.k].id || x.dir - y.dir);
  for (const [id, k] of nodeIdx) NODE_ID[k] = id;
  for (const p of POIS) {
    const k = nodeIdx.get(p.node);
    if (k !== undefined) { if (!poiByNode.has(k)) poiByNode.set(k, []); poiByNode.get(k).push(p); }
  }
  // access points de-duplicated by node (a curated point wins over an OSM trailhead)
  const seen = new Map();
  for (const a of ACCESS) {
    a.k = nodeIdx.get(a.node);
    if (a.k === undefined || haversine(center, [a.lat, a.lon]) > radiusMi * 1609.34) continue;
    const prev = seen.get(a.k);
    if (!prev || (prev.source === "osm" && a.source !== "osm")) seen.set(a.k, a);
  }
  ACCESS = [...seen.values()];
  ACCESS.forEach((a, i) => { a.idx = i; a.near = haversine(center, [a.lat, a.lon]); });
}

function haversine(a, b) {
  const r = Math.PI / 180, dLat = (b[0] - a[0]) * r, dLon = (b[1] - a[1]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

// ---------- rules ----------

function usable(k, dir, o) {
  const e = E[k];
  if (e.f & CLOSED || e.bk === ACC.no) return false;
  if ((e.bk === ACC.dismount || e.f & DISMOUNT || e.h === "steps") && o.avoidDismount) return false;
  if ((e.ow === 1 && dir === -1) || (e.ow === -1 && dir === 1)) return false;
  if (o.avoidRoad && e.f & ROAD) return false;
  if (!surfaceOk(e, o.surface)) return false;
  if (!o.walk && e.L >= 100 && e.maxG > o.grade + 0.5) return false;
  return true;
}

// surface codes: 0 paved, 1 groomed gravel, 2 loose gravel, 3 untagged, 4 dirt
const S_PAVED = 0, S_GROOMED = 1, S_GRAVEL = 2, S_UNKNOWN = 3, S_DIRT = 4;
const TRAILISH = new Set(["path", "track", "bridleway"]);

function surfaceOk(e, mode) {
  if (mode === "any" || mode === "dirt") return true;
  // untagged paths are usually dirt, but very short ones are crossings and links between paths
  const unknownEasy = UNKNOWN_SURFACE_OK.has(e.h) || e.c !== "path" || e.L < SHORT_LINK_M;
  if (e.s === S_UNKNOWN) return unknownEasy || (mode === "gravel" && e.h === "track");
  if (mode === "paved") return e.s === S_PAVED;
  if (mode === "groomed") return e.s === S_PAVED || e.s === S_GROOMED;
  return e.s !== S_DIRT; // gravel
}

/** How much a gravel or dirt ride wants this edge (walks lean toward it). */
function surfaceWant(e, mode) {
  if (mode === "gravel") return e.s === S_GROOMED || e.s === S_GRAVEL ? 3 : 1;
  if (mode === "dirt") return e.s === S_DIRT || (e.s === S_UNKNOWN && TRAILISH.has(e.h)) ? 3 : 1;
  return 1;
}

/** Share of a ride on the surface a gravel or dirt ride is after (1 for other modes). */
function targetShare(r, mode) {
  if (mode === "gravel") return r.surf[S_GROOMED] + r.surf[S_GRAVEL];
  if (mode === "dirt") return r.surf[S_DIRT] + r.trailUnknown / Math.max(r.length, 1);
  return 1;
}

function cost(k) {
  const e = E[k];
  let w = 1;
  if (e.c === "road") w = ROAD_WEIGHT[e.h] || 2;
  else if (e.c === "join") w = 1.2;
  else if (e.bk === ACC.unknown) w = 1.3;
  return e.L * w;
}

// ---------- random walks ----------

function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function heading(k, dir, atEnd) {
  const g = E[k].g, n = g.length;
  const [p, q] = dir === 1 ? (atEnd ? [g[n - 2], g[n - 1]] : [g[0], g[1]]) : (atEnd ? [g[1], g[0]] : [g[n - 1], g[n - 2]]);
  return Math.atan2(q[0] - p[0], (q[1] - p[1]) * Math.cos(p[0] * Math.PI / 180));
}

/** Walk outward from node s; greedy=true follows the same trail name and straightest line. */
function walk(s, first, o, target, rng, greedy, needTwoWay) {
  const route = [first];
  const visited = new Set([s]);
  let len = E[first.k].L, at = first.dir === 1 ? E[first.k].b : E[first.k].a;
  while (len < target && !visited.has(at)) {
    visited.add(at);
    const cur = route[route.length - 1], ce = E[cur.k];
    const h0 = heading(cur.k, cur.dir, true);
    const opts = [];
    for (const nx of ADJ[at]) {
      if (nx.k === cur.k) continue;
      if (!usable(nx.k, nx.dir, o) || (needTwoWay && !usable(nx.k, -nx.dir, o))) continue;
      const turn = Math.abs(((heading(nx.k, nx.dir, false) - h0 + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
      const same = ce.n && E[nx.k].n === ce.n;
      let w = Math.exp(-turn * 1.5) * (same ? 6 : 1) * surfaceWant(E[nx.k], o.surface) / (cost(nx.k) / Math.max(E[nx.k].L, 1));
      opts.push({ nx, w, turn, same });
    }
    if (!opts.length) {
      route.stop = ADJ[at].some((nx) => nx.k !== cur.k && E[nx.k].f & CLOSED) ? "closure" : "trail end";
      if (o.diag) o.diag.push(`walk stops at ${NX[at].map((x) => x.toFixed(5))}: ` + ADJ[at].filter((nx) => nx.k !== cur.k)
        .map((nx) => `${E[nx.k].id} ${E[nx.k].h} "${E[nx.k].n || ""}" s${E[nx.k].s} bk${E[nx.k].bk} f${E[nx.k].f} g${E[nx.k].maxG.toFixed(1)} ${usable(nx.k, nx.dir, o) ? "ok" : "blocked"}`).join("; "));
      break;
    }
    let pick;
    if (greedy) pick = opts.sort((x, y) => (y.same - x.same) || (x.turn - y.turn))[0].nx;
    else {
      let r = rng() * opts.reduce((t, x) => t + x.w, 0);
      pick = opts.find((x) => (r -= x.w) <= 0)?.nx || opts[opts.length - 1].nx;
    }
    route.push(pick);
    len += E[pick.k].L;
    at = pick.dir === 1 ? E[pick.k].b : E[pick.k].a;
  }
  return route;
}

// ---------- shortest path back (A*) ----------

class Heap {
  constructor() { this.a = []; }
  push(x) { const a = this.a; a.push(x); let i = a.length - 1;
    while (i) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
  pop() { const a = this.a, top = a[0], last = a.pop();
    if (a.length) { a[0] = last; let i = 0;
      for (;;) { const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l; if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } }
    return top; }
  get size() { return this.a.length; }
}

function routeBack(from, to, o, penalized, banFirst, limit) {
  const goal = NX[to];
  const best = new Map([[from, 0]]), prev = new Map(), heap = new Heap();
  heap.push([haversine(NX[from], goal), 0, from]);
  while (heap.size) {
    const [, g, n] = heap.pop();
    if (n === to) break;
    if (g > (best.get(n) ?? Infinity) || g > limit) continue;
    for (const nx of ADJ[n]) {
      if (n === from && nx.k === banFirst) continue; // no U-turn at the far point
      if (!usable(nx.k, nx.dir, o)) continue;
      const m = nx.dir === 1 ? E[nx.k].b : E[nx.k].a;
      const ng = g + cost(nx.k) * (penalized.has(nx.k) ? 8 : 1);
      if (ng < (best.get(m) ?? Infinity)) {
        best.set(m, ng); prev.set(m, [n, nx]);
        heap.push([ng + haversine(NX[m], goal), ng, m]);
      }
    }
  }
  if (!prev.has(to)) return null;
  const out = [];
  for (let n = to; n !== from;) { const [p, nx] = prev.get(n); out.push(nx); n = p; }
  return out.reverse();
}

function shortestFrom(from, o, limit) {
  const best = new Map([[from, 0]]), prev = new Map(), heap = new Heap();
  heap.push([0, 0, from]);
  while (heap.size) {
    const [g, , n] = heap.pop();
    if (g > (best.get(n) ?? Infinity) || g > limit) continue;
    for (const nx of ADJ[n]) {
      if (!usable(nx.k, nx.dir, o)) continue;
      const m = nx.dir === 1 ? E[nx.k].b : E[nx.k].a;
      const ng = g + cost(nx.k);
      if (ng < (best.get(m) ?? Infinity)) { best.set(m, ng); prev.set(m, [n, nx]); heap.push([ng, 0, m]); }
    }
  }
  return prev;
}

// ---------- evaluation ----------

function edgeLatLon(e, dist) {
  const g = e.g;
  if (!e.cum) {
    e.cum = [0];
    for (let i = 1; i < g.length; i++) e.cum.push(e.cum[i - 1] + haversine(g[i - 1], g[i]));
  }
  const c = e.cum, d = dist * c[c.length - 1] / Math.max(e.L, 1e-9);
  let i = 1;
  while (i < c.length - 1 && c[i] < d) i++;
  const f = (d - c[i - 1]) / Math.max(c[i] - c[i - 1], 1e-9);
  return [g[i - 1][0] + (g[i][0] - g[i - 1][0]) * f, g[i - 1][1] + (g[i][1] - g[i - 1][1]) * f];
}

/** Raw profile along half-edges: samples at each edge's own step. */
function profile(route) {
  const D = [], EL = [], K = [];
  let d0 = 0;
  route.forEach((h, idx) => {
    const e = E[h.k], n = e.ele.length;
    for (let j = idx ? 1 : 0; j < n; j++) {
      const jj = h.dir === 1 ? j : n - 1 - j;
      D.push(d0 + j * e.st); EL.push(e.ele[jj]); K.push(idx);
    }
    d0 += e.L;
  });
  return { D, EL, K, total: d0 };
}

function resample(p) {
  const n = Math.floor(p.total / RES) + 1, out = new Float32Array(n), kk = new Int32Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const d = i * RES;
    while (j < p.D.length - 2 && p.D[j + 1] < d) j++;
    const d1 = p.D[j], d2 = p.D[Math.min(j + 1, p.D.length - 1)];
    const f = d2 > d1 ? Math.min(1, Math.max(0, (d - d1) / (d2 - d1))) : 0;
    out[i] = p.EL[j] + (p.EL[Math.min(j + 1, p.EL.length - 1)] - p.EL[j]) * f;
    kk[i] = p.K[j];
  }
  const sm = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let q = Math.max(0, i - 2); q <= Math.min(n - 1, i + 2); q++) { s += out[q]; c++; }
    sm[i] = s / c;
  }
  return { ele: sm, k: kk };
}

/** First index where the ride must end going outward: strict grade or an over-long steep stretch. */
function cutPoint(ele, o) {
  let steepFrom = -1;
  for (let i = 0; i + WIN < ele.length; i++) {
    const g = Math.abs(ele[i + WIN] - ele[i]);
    if (g > o.grade) {
      if (!o.walk) return { cut: i + WIN - 1, why: "grade limit" };
      if (steepFrom < 0) steepFrom = i;
      if ((i + WIN - steepFrom) * RES > o.walkMax) return { cut: steepFrom, why: "long steep section" };
    } else steepFrom = -1;
  }
  return null;
}

function steepSpots(ele, o) {
  const T = Math.min(o.grade, 6), out = [];
  for (let i = 0; i + WIN < ele.length; i++) {
    const g = ele[i + WIN] - ele[i];
    if (Math.abs(g) <= T) continue;
    const last = out[out.length - 1];
    if (last && i <= last.to) { last.to = i + WIN; last.g = Math.max(last.g, Math.abs(g)); last.ways.add(Math.sign(g)); }
    else out.push({ from: i, to: i + WIN, g: Math.abs(g), ways: new Set([Math.sign(g)]) });
  }
  const local = (i) => Math.abs(ele[Math.min(i + 1, ele.length - 1)] - ele[Math.max(i - 1, 0)]) / (2 * RES) * 100;
  for (const x of out) {
    while (x.from < x.to && local(x.from) <= T) x.from++;
    while (x.to > x.from && local(x.to) <= T) x.to--;
    x.at = x.from * RES; x.len = (x.to - x.from) * RES;
    x.shape = x.ways.size > 1 ? "dip and climb" : x.ways.has(1) ? "uphill" : "downhill";
    delete x.ways;
  }
  return out;
}

/** Truncate a route (half-edges) to `dist` metres, splitting the last edge virtually. */
function truncate(route, dist) {
  const out = [];
  let d = 0;
  for (const h of route) {
    if (d + E[h.k].L <= dist + 0.5) { out.push(h); d += E[h.k].L; continue; }
    if (dist - d > 1) out.push({ k: h.k, dir: h.dir, part: dist - d });
    break;
  }
  return out;
}

function reverseRoute(route) {
  return route.slice().reverse().map((h) => ({ k: h.k, dir: -h.dir, part: h.part, partFromEnd: !!h.part }));
}

/** Build the full sample list for a route, honouring partial edges. */
function samples(route) {
  const out = { D: [], EL: [], LAT: [], LON: [], F: [], S: [], BK: [], H: [], R: [] };
  let d0 = 0;
  route.forEach((h, idx) => {
    const e = E[h.k], n = e.ele.length, len = h.part ?? e.L;
    // a partial edge covers [0, part] from its entry end; reversed partial edges come back from that point
    const offset = h.partFromEnd ? e.L - len : 0;
    for (let j = 0; ; j++) {
      const local = Math.min(j * e.st, len);
      if (idx && j === 0) { if (local >= len) break; continue; }
      const along = offset + local;              // distance from entry end
      const fwd = h.dir === 1 ? along : e.L - along;
      const fi = fwd / Math.max(e.st, 1e-9);
      const i0 = Math.max(0, Math.min(n - 1, Math.floor(fi))), i1 = Math.min(n - 1, i0 + 1);
      const ele = e.ele[i0] + (e.ele[i1] - e.ele[i0]) * (fi - i0);
      const [la, lo] = edgeLatLon(e, fwd);
      out.D.push(d0 + local); out.EL.push(ele); out.LAT.push(la); out.LON.push(lo);
      out.F.push(e.f); out.S.push(e.s); out.BK.push(e.bk); out.H.push(e.h); out.R.push(e.res);
      if (local >= len) break;
    }
    d0 += len;
  });
  out.total = d0;
  return out;
}

/** Named trails and paths ridden, longest first; streets are left out (they show as on-street). */
function rideNames(names) {
  return [...names.entries()].filter(([, v]) => !v.road).sort((a, b) => b[1].len - a[1].len).map(([n]) => n);
}

function evaluate(route, o, meta) {
  const sm = samples(route);
  const prof = { D: sm.D, EL: sm.EL, K: sm.D.map(() => 0), total: sm.total };
  const { ele } = resample(prof);
  let steep = steepSpots(ele, o);
  if (meta.shape === "out-and-back") steep = steep.filter((x) => x.at < sm.total / 2);
  let maxG = 0, maxRide = 0;
  const T = Math.min(o.grade, 6);
  for (let i = 0; i + WIN < ele.length; i++) {
    const g = Math.abs(ele[i + WIN] - ele[i]);
    maxG = Math.max(maxG, g);
    if (g <= T) maxRide = Math.max(maxRide, g);
  }
  let climb = 0, climbHalf = 0;
  const half = Math.floor(ele.length / 2);
  for (let i = 1; i < ele.length; i++) { const u = Math.max(0, ele[i] - ele[i - 1]); climb += u; if (i <= half) climbHalf += u; }
  const surf = [0, 0, 0, 0, 0];
  let road = 0, dismount = 0, unconfirmed = 0, onetenM = 0, trailUnknown = 0;
  for (let i = 1; i < sm.D.length; i++) {
    const step = sm.D[i] - sm.D[i - 1];
    surf[sm.S[i]] += step;
    if (sm.F[i] & ROAD) road += step;
    if (sm.F[i] & DISMOUNT || sm.H[i] === "steps") dismount += step;
    if (sm.BK[i] === ACC.unknown) unconfirmed += step;
    if (sm.R[i] === 10) onetenM += step;
    if (sm.S[i] === S_UNKNOWN && TRAILISH.has(sm.H[i])) trailUnknown += step;
  }
  const names = new Map();
  const nodes = new Set();
  let joins = 0;
  const used = new Map();
  let retraced = 0, uturns = 0;
  route.forEach((h, i) => {
    const e = E[h.k];
    if (e.n) names.set(e.n, { len: (names.get(e.n)?.len || 0) + (h.part ?? e.L), road: e.c === "road" });
    if (e.c === "join") joins++;
    nodes.add(e.a); nodes.add(e.b);
    if (used.has(h.k) && used.get(h.k) !== h.dir) retraced += h.part ?? e.L;
    used.set(h.k, h.dir);
    if (i && route[i - 1].k === h.k && route[i - 1].dir === -h.dir) uturns++;
  });
  const pois = [];
  for (const n of nodes) for (const p of poiByNode.get(n) || []) pois.push(p);
  const span = Math.max(sm.total, 1);
  return {
    ...meta, length: sm.total, climb, climbOut: meta.shape === "out-and-back" ? climbHalf : climb,
    climbBack: meta.shape === "out-and-back" ? climb - climbHalf : 0,
    maxG, maxRide, steep, surf: surf.map((m) => m / span), road, dismount, unconfirmed, coarseElev: onetenM, trailUnknown,
    joins, retraced, uturns, names: rideNames(names),
    pois: pois.map((p) => p.k), _pois: pois, _sm: sm, _ele: ele,
  };
}

// ---------- generation ----------

/**
 * "loop" if nothing is ridden twice; "lollipop" if the repeat is a stem from the start, ridden
 * out first and back last; null otherwise: an out-and-back (no loop at all), any U-turn, or
 * repeats away from the start beyond MAX_FAR_REPEAT_M (short connectors into a loop are fine).
 */
function loopShape(route) {
  let k = 0;
  const n = route.length;
  while (k < n / 2 && route[k].k === route[n - 1 - k].k && route[k].dir === -route[n - 1 - k].dir) k++;
  const middle = route.slice(k, n - k);
  if (!middle.length) return null;
  const stem = new Set(route.slice(0, k).map((h) => h.k));
  const seen = new Set();
  let farRepeat = 0;
  for (let i = 0; i < middle.length; i++) {
    const h = middle[i];
    if (i && middle[i - 1].k === h.k) return null; // U-turn
    if (stem.has(h.k) || seen.has(h.k)) farRepeat += E[h.k].L;
    seen.add(h.k);
  }
  if (farRepeat > MAX_FAR_REPEAT_M) return null;
  return k ? "lollipop" : "loop";
}

function jaccard(a, b) {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// "r" marks a reversed edge; edge ids themselves can be negative (unmapped joins)
function encode(route) {
  return route.map((h) => `${h.dir === 1 ? "" : "r"}${E[h.k].id}${h.part ? "~" + Math.round(h.part) : ""}`).join(".");
}

/** Nearest node within APPROACH_M of k (over any non-closed, non-private edge) that has a usable edge. */
function startNode(k, o) {
  if (ADJ[k].some((h) => usable(h.k, h.dir, o))) return { node: k, approach: 0 };
  const best = new Map([[k, 0]]), heap = new Heap();
  heap.push([0, 0, k]);
  while (heap.size) {
    const [d, , n] = heap.pop();
    if (d > best.get(n) || d > APPROACH_M) continue;
    if (ADJ[n].some((h) => usable(h.k, h.dir, o))) return { node: n, approach: d };
    for (const h of ADJ[n]) {
      if (E[h.k].f & CLOSED || E[h.k].bk === ACC.no) continue;
      const m = h.dir === 1 ? E[h.k].b : E[h.k].a, nd = d + E[h.k].L;
      if (nd < (best.get(m) ?? Infinity)) { best.set(m, nd); heap.push([nd, 0, m]); }
    }
  }
  return null;
}

function ridesFrom(a, o) {
  const rng = mulberry32(a.k * 2654435761);
  const st = startNode(a.k, o);
  if (!st) return [];
  const s = st.node, cands = [];
  const minM = o.min * 1609.34, maxM = o.max * 1609.34;
  const starts = ADJ[s].filter((h) => usable(h.k, h.dir, o));
  if (o.diag) o.diag.push(`start node ${a.node} (approach ${st.approach.toFixed(0)} m): ` + ADJ[s].map((h) =>
    `${E[h.k].id} ${E[h.k].h} "${E[h.k].n || ""}" s${E[h.k].s} bk${E[h.k].bk} f${E[h.k].f} ow${E[h.k].ow} g${E[h.k].maxG.toFixed(1)} L${E[h.k].L} ${usable(h.k, h.dir, o) ? "ok" : "blocked"}`).join("; "));

  // out-and-back: two-way edges only; greedy trail-following first, then a few random variants
  if (o.shapes.outback) {
    for (const first of starts) {
      if (!usable(first.k, -first.dir, o)) continue;
      for (let t = 0; t < 3; t++) {
        const out = walk(s, first, o, maxM / 2, rng, t === 0, true);
        let outLen = out.reduce((x, h) => x + E[h.k].L, 0);
        let why = outLen >= maxM / 2 - 1 ? "length limit" : out.stop || "trail end";
        let r = truncate(out, Math.min(outLen, maxM / 2));
        const sm = samples(r);
        const { ele } = resample({ D: sm.D, EL: sm.EL, K: sm.D.map(() => 0), total: sm.total });
        const c = cutPoint(ele, o);
        if (c) { r = truncate(r, c.cut * RES); why = c.why; }
        const len = 2 * r.reduce((x, h) => x + (h.part ?? E[h.k].L), 0);
        if (len < Math.max(minM, 300)) continue;
        cands.push({ route: r.concat(reverseRoute(r)), shape: "out-and-back", why });
      }
    }
  }

  // loops and lollipops: walk out, then come back avoiding the outbound edges where possible
  if (o.shapes.loop) {
    for (let t = 0; t < 14; t++) {
      if (!starts.length) break;
      const first = starts[Math.floor(rng() * starts.length)];
      const target = (minM + (maxM - minM) * (0.3 + 0.6 * rng())) * (0.35 + 0.15 * rng());
      const out = walk(s, first, o, target, rng, false, false);
      const far = out[out.length - 1];
      const at = far.dir === 1 ? E[far.k].b : E[far.k].a;
      if (at === s) {
        const len = out.reduce((x, h) => x + E[h.k].L, 0);
        if (len >= minM && len <= maxM && loopShape(out)) cands.push({ route: out, shape: loopShape(out) });
        continue;
      }
      const back = routeBack(at, s, o, new Set(out.map((h) => h.k)), far.k, maxM * 1.5);
      if (!back) continue;
      const route = out.concat(back);
      const len = route.reduce((x, h) => x + E[h.k].L, 0);
      const shape = loopShape(route);
      if (len < minM || len > maxM || !shape) continue;
      cands.push({ route, shape });
    }
  }

  if (o.shapes.loop) {
    const prev = shortestFrom(s, o, maxM * 0.55);
    const dist = new Map([[s, 0]]);
    const distOf = (n) => {
      if (dist.has(n)) return dist.get(n);
      const [p, nx] = prev.get(n);
      const d = distOf(p) + E[nx.k].L;
      dist.set(n, d);
      return d;
    };
    const bins = new Map();
    for (const n of prev.keys()) {
      if (n === s) continue;
      const d = distOf(n);
      if (d < minM * 0.3 || d > maxM * 0.5) continue;
      const brg = Math.atan2(NX[n][0] - NX[s][0], (NX[n][1] - NX[s][1]) * Math.cos(NX[s][0] * Math.PI / 180));
      const key = `${Math.floor((brg + Math.PI) / (Math.PI / 4))}:${d < (minM * 0.3 + maxM * 0.5) / 2 ? 0 : 1}`;
      if (!bins.has(key)) bins.set(key, []);
      bins.get(key).push(n);
    }
    for (const nodes of bins.values()) {
      const t = nodes[Math.floor(rng() * nodes.length)];
      const out = [];
      for (let n = t; n !== s;) { const [p, nx] = prev.get(n); out.push(nx); n = p; }
      out.reverse();
      const far = out[out.length - 1];
      const back = routeBack(t, s, o, new Set(out.map((h) => h.k)), far.k, maxM * 1.5);
      if (!back) continue;
      const route = out.concat(back);
      const len = route.reduce((x, h) => x + E[h.k].L, 0);
      const shape = loopShape(route);
      if (len < minM || len > maxM || !shape) continue;
      cands.push({ route, shape });
    }
  }

  // one-way to another parking point
  if (o.shapes.oneway) {
    const prev = shortestFrom(s, o, maxM * 2);
    for (const b of ACCESS) {
      if (b === a || !prev.has(b.k)) continue;
      const route = [];
      for (let n = b.k; n !== s;) { const [p, nx] = prev.get(n); route.push(nx); n = p; }
      route.reverse();
      const len = route.reduce((x, h) => x + E[h.k].L, 0);
      if (len >= Math.max(minM, 300) && len <= maxM) cands.push({ route, shape: "one-way", end: b });
    }
  }

  const kept = [];
  for (const c of cands) {
    if (!c.route.length) continue;
    const r = evaluate(c.route, o, { shape: c.shape, why: c.why, start: a.idx, end: c.end?.idx, approach: st.approach });
    if (r.length < MIN_RIDE_M) continue;
    if (c.shape !== "out-and-back") {
      if (!o.walk && r.maxG > o.grade) continue;
      if (o.walk && r.steep.some((x) => x.g > o.grade && x.len > o.walkMax)) continue;
    }
    const share = targetShare(r, o.surface);
    if (share < 0.5) continue; // a gravel or dirt ride should be mostly that
    r.edges = new Set(c.route.map((h) => h.k));
    r.score = (share - 0.5) + r.length / maxM - 0.08 * r.maxRide - 0.3 * r.steep.length - (r.road + r.dismount) / 2000
      - r.unconfirmed / 5000 + (c.shape === "loop" ? 0.15 : c.shape === "lollipop" ? 0.08 : 0);
    r.code = `${a.node}:${encode(c.route)}`;
    if (kept.some((k) => jaccard(k.edges, r.edges) > 0.7 && k.score >= r.score)) continue;
    for (let i = kept.length - 1; i >= 0; i--) if (jaccard(kept[i].edges, r.edges) > 0.7) kept.splice(i, 1);
    kept.push(r);
  }
  return kept.sort((x, y) => y.score - x.score).slice(0, 6);
}

function summary(r) {
  const { edges, _sm, _ele, _pois, ...rest } = r;
  return rest;
}

function detail(r) {
  const sm = r._sm;
  return { ...summary(r), lat: sm.LAT, lon: sm.LON, d: sm.D, ele: sm.EL, f: sm.F, s: sm.S, bk: sm.BK,
    poiList: r._pois, grade10: Array.from(r._ele) };
}

// ---------- short ride links ----------
// <access node>[~<start node>].<shape><edge count>.<turns>[.<partial m>], base36 throughout.
// Only junctions with more than one way onward cost a character, so trail rides stay short.
const B36 = (n) => n.toString(36);
const SHAPE_CODE = { "out-and-back": "o", loop: "l", lollipop: "p", "one-way": "w" };
const SHAPE_NAME = Object.fromEntries(Object.entries(SHAPE_CODE).map(([k, v]) => [v, k]));

function onward(n, prev) {
  return ADJ[n].filter((h) => !prev || h.k !== prev.k);
}

function shortCode(route, accessNode, shape) {
  const half = shape === "out-and-back" ? route.slice(0, route.length / 2) : route;
  let at = half[0].dir === 1 ? E[half[0].k].a : E[half[0].k].b;
  const startId = NODE_ID[at];
  let turns = "", prev = null;
  for (const h of half) {
    const opts = onward(at, prev);
    const i = opts.findIndex((x) => x.k === h.k && x.dir === h.dir);
    if (i < 0) return null;
    if (opts.length > 1) turns += i < 35 ? B36(i) : "z" + B36(i).padStart(2, "0");
    prev = h;
    at = h.dir === 1 ? E[h.k].b : E[h.k].a;
  }
  const last = half[half.length - 1];
  return `${B36(accessNode)}${startId !== accessNode ? "~" + B36(startId) : ""}.${SHAPE_CODE[shape]}${B36(half.length)}.${turns}` +
    (last.part ? `.${B36(Math.round(last.part))}` : "");
}

function decodeShort(code) {
  const m = /^([0-9a-z]+)(?:~([0-9a-z]+))?\.([olpw])([0-9a-z]+)\.([0-9a-z]*)(?:\.([0-9a-z]+))?$/.exec(code);
  if (!m) return null;
  let at = nodeIdx.get(parseInt(m[2] || m[1], 36));
  if (at === undefined) return null;
  const shape = SHAPE_NAME[m[3]], count = parseInt(m[4], 36), turns = m[5];
  const route = [];
  let prev = null, t = 0;
  for (let i = 0; i < count; i++) {
    const opts = onward(at, prev);
    let idx = 0;
    if (opts.length > 1) {
      if (t >= turns.length) return null;
      if (turns[t] === "z") { idx = parseInt(turns.slice(t + 1, t + 3), 36); t += 3; } else idx = parseInt(turns[t++], 36);
    }
    const h = opts[idx];
    if (!h) return null;
    route.push({ k: h.k, dir: h.dir });
    prev = h;
    at = h.dir === 1 ? E[h.k].b : E[h.k].a;
  }
  if (t !== turns.length) return null;
  if (m[6]) route[route.length - 1].part = parseInt(m[6], 36);
  const full = shape === "out-and-back" ? route.concat(reverseRoute(route)) : route;
  return { route: full, shape, accessNode: parseInt(m[1], 36) };
}

function decodeRoute(code) {
  const [startNode, path] = code.split(":");
  const byId = new Map(E.map((e, k) => [e.id, k]));
  const end = (h) => (h.dir === 1 ? E[h.k].b : E[h.k].a);
  const begin = (h) => (h.dir === 1 ? E[h.k].a : E[h.k].b);
  const out = [];
  let at = nodeIdx.get(Number(startNode));
  for (const tok of path.split(".")) {
    // current form: [r]id[~part]; older links used a leading "-" for reversed, which is
    // ambiguous for negative ids, so try each reading and keep the one that connects
    const m = /^(r?)(-?-?\d+)(?:~(\d+))?$/.exec(tok);
    if (!m) return null;
    const part = m[3] ? Number(m[3]) : undefined;
    const readings = m[1] ? [[Number(m[2]), -1]]
      : m[2].startsWith("--") ? [[Number(m[2].slice(1)), -1]]
      : m[2].startsWith("-") ? [[Number(m[2]), 1], [Number(m[2].slice(1)), -1]]
      : [[Number(m[2]), 1]];
    const opts = readings.filter(([id]) => byId.has(id)).map(([id, dir]) => ({ k: byId.get(id), dir, part }));
    // a partial edge followed by its reverse is an out-and-back turnaround: it starts mid-edge
    const prev = out[out.length - 1];
    // the first edge may start a short walk from the parking node (see startNode)
    const h = opts.find((x) => (prev?.part && prev.k === x.k) || begin(x) === at) || (out.length ? null : opts[0] || null);
    if (!h) return null;
    if (prev?.part && prev.k === h.k) h.partFromEnd = true;
    out.push(h);
    at = end(h);
  }
  return out;
}

// ---------- messages ----------

let OPTS = null, currentGen = 0;
onmessage = async (ev) => {
  const m = ev.data;
  if (m.type === "load") {
    await load(m.center, m.radius);
    postMessage({ type: "loaded", access: ACCESS, info: INFO, edges: E.length,
      closures: E.filter((e) => e.f & CLOSED).map((e) => ({ g: e.g, n: e.n })) });
  } else if (m.type === "generate") {
    OPTS = m.opts;
    const gen = m.gen;
    currentGen = gen; // a newer "generate" message bumps this and stops the loop below
    const order = ACCESS.slice().sort((x, y) => x.near - y.near);
    for (let i = 0; i < order.length; i++) {
      if (gen !== currentGen) return;
      const rides = ridesFrom(order[i], OPTS).map(summary);
      postMessage({ type: "rides", gen, rides, done: i + 1, total: order.length });
      if (i % 4 === 3) await new Promise((r) => setTimeout(r, 0)); // let newer requests in
    }
  } else if (m.type === "from") {
    if (m.diag) m.opts.diag = [];
    postMessage({ type: "from", access: m.access, rides: ridesFrom(ACCESS[m.access], m.opts).map(summary), diag: m.opts.diag });
  } else if (m.type === "detail") {
    let route, shape = m.shape, accessNode;
    if (m.short) {
      const d = decodeShort(m.short);
      if (d) ({ route, shape, accessNode } = d);
    } else {
      route = decodeRoute(m.code);
      accessNode = Number(m.code.split(":")[0]);
    }
    if (!route) return postMessage({ type: "detail", error: "This ride link doesn't match the current map data (the map may have been updated since it was made)." });
    const a = ACCESS.find((x) => x.node === accessNode);
    const r = evaluate(route, m.opts, { shape, why: m.why, start: a?.idx, end: m.end });
    r.code = `${accessNode}:${encode(route)}`;
    r.short = shortCode(route, accessNode, shape);
    // a shared link replays its route as-is; say so if parts are now known to be off-limits or closed
    r.offLimits = route.reduce((m, h) => m + (E[h.k].bk === ACC.no || E[h.k].f & CLOSED ? h.part ?? E[h.k].L : 0), 0);
    postMessage({ type: "detail", ride: detail(r) });
  }
};
