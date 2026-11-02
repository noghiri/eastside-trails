"use strict";

const NEWCASTLE = [47.5301, -122.1557];
const MI = 1609.34, FT = 3.28084;
const WIN = 10;                    // samples per grade window (10 m spacing -> 100 m)
const TIERS = [2, 4, 6, Infinity]; // tier upper bounds, % grade
const TIER_LABELS = ["≤2%", "2–4%", "4–6%", ">6%"];
const F = { closed: 1, road: 2, dismount: 4, bridge: 8 };
const SURF = ["paved", "groomed gravel", "rough/unpaved", "untagged"];

let DATA, map, rideLayer;
let current = [];

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const tierOf = (g) => TIERS.findIndex((t) => Math.abs(g) <= t);
const tierColor = (k) => css(`--g${k + 1}`);
// map tiles are always light, so map lines keep the light-mode ramp in both themes
const MAP_TIERS = ["#86b6ef", "#3987e5", "#1c5cab", "#0d366b"];

function haversine(a, b) {
  const r = Math.PI / 180, dLat = (b[0] - a[0]) * r, dLon = (b[1] - a[1]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

fetch("data/trails.json").then((r) => r.json()).then((d) => {
  DATA = d;
  for (const t of d.trails) t.pieces.forEach((p, k) => prep(p, t, k));
  setupMap();
  loadFilters();
  const link = parseHash();
  if (link) applyFilters(link.o);
  document.querySelectorAll(".filters input, .filters select").forEach((el) => el.addEventListener("change", render));
  render();
});

function prep(p, t, k) {
  p.n = p.d.length;
  p.trail = t;
  p.k = k;
  // g[i]: grade of the 100 m window starting at sample i (forward direction)
  p.g = new Float32Array(p.n).fill(NaN);
  for (let i = 0; i + WIN < p.n; i++) p.g[i] = ((p.ele[i + WIN] - p.ele[i]) / (p.d[i + WIN] - p.d[i])) * 100;
}

// ---------- filters ----------

function opts() {
  const o = {
    mode: document.querySelector('input[name="mode"]:checked').value,
    grade: +document.querySelector('input[name="grade"]:checked').value,
    min: Math.max(0, +$("#minLen").value || 0),
    max: Math.max(0.5, +$("#maxLen").value || 10),
    surface: $("#surface").value,
    avoidDismount: $("#avoidDismount").checked,
    avoidRoad: $("#avoidRoad").checked,
    sort: $("#sort").value,
  };
  try { localStorage.setItem("filters", JSON.stringify(o)); } catch (e) { /* storage unavailable */ }
  return o;
}

function parseHash() {
  try { return JSON.parse(decodeURIComponent(location.hash.slice(1))); } catch (e) { return null; }
}

function loadFilters() {
  let o;
  try { o = JSON.parse(localStorage.getItem("filters")); } catch (e) { return; }
  if (o) applyFilters(o);
}

function applyFilters(o) {
  const radio = (name, v) => { const el = document.querySelector(`input[name="${name}"][value="${v}"]`); if (el) el.checked = true; };
  radio("mode", o.mode);
  radio("grade", o.grade);
  $("#minLen").value = o.min;
  $("#maxLen").value = o.max;
  $("#surface").value = o.surface;
  $("#avoidDismount").checked = o.avoidDismount;
  $("#avoidRoad").checked = o.avoidRoad;
  $("#sort").value = o.sort;
}

// ---------- ride generation ----------

function blockReason(p, i, o) {
  const f = p.f[i], s = p.s[i];
  if (f & F.closed) return "closure";
  if (o.avoidDismount && f & F.dismount) return "dismount section";
  if (o.avoidRoad && f & F.road) return "on-street section";
  if (o.surface === "groomed" && s === 2) return "rough surface";
  if (o.surface === "paved" && (s === 1 || s === 2)) return "unpaved surface";
  return null;
}

/** Walk from s in direction dir until something stops us. Returns {e, why}. */
function reach(p, s, dir, o, maxDist) {
  let e = s;
  for (;;) {
    const nx = e + dir;
    if (nx < 0 || nx >= p.n) return { e, why: "trail end" };
    if (Math.abs(p.d[nx] - p.d[s]) > maxDist) return { e, why: "length limit" };
    const b = blockReason(p, nx, o);
    if (b) return { e, why: b };
    const w0 = dir > 0 ? nx - WIN : nx; // window just completed, in forward indexing
    const inside = dir > 0 ? w0 >= s : nx + WIN <= s;
    if (inside && Math.abs(p.g[w0]) > o.grade) return { e, why: "grade limit" };
    e = nx;
  }
}

function generate(o) {
  const out = [];
  for (const t of DATA.trails) {
    for (const p of t.pieces) {
      for (const a of p.access) {
        if (blockReason(p, a.i, o)) continue;
        for (const dir of [1, -1]) {
          if (o.mode === "rt") {
            const r = reach(p, a.i, dir, o, (o.max * MI) / 2);
            const len = 2 * Math.abs(p.d[r.e] - p.d[a.i]);
            if (len >= Math.max(o.min * MI, 300)) out.push(makeRide(p, a, r.e, "rt", null, r.why));
          } else {
            const r = reach(p, a.i, dir, o, o.max * MI);
            for (const b of p.access) {
              if (b === a) continue;
              const ok = dir > 0 ? b.i > a.i && b.i <= r.e : b.i < a.i && b.i >= r.e;
              const len = Math.abs(p.d[b.i] - p.d[a.i]);
              if (ok && len >= Math.max(o.min * MI, 300)) out.push(makeRide(p, a, b.i, "ow", b));
            }
          }
        }
      }
    }
  }
  return out;
}

function makeRide(p, a, e, mode, b, why) {
  const s = a.i, dir = e > s ? 1 : -1;
  const idx = [];
  for (let i = s; i !== e + dir; i += dir) idx.push(i);
  if (mode === "rt") for (let k = idx.length - 2; k >= 0; k--) idx.push(idx[k]);
  const lo = Math.min(s, e), hi = Math.max(s, e);

  const dist = [0];
  for (let k = 1; k < idx.length; k++) dist.push(dist[k - 1] + Math.abs(p.d[idx[k]] - p.d[idx[k - 1]]));
  const climbOf = (from, to) => {
    let up = 0;
    for (let k = from + 1; k <= to; k++) up += Math.max(0, p.ele[idx[k]] - p.ele[idx[k - 1]]);
    return up;
  };
  const half = mode === "rt" ? (idx.length - 1) / 2 : idx.length - 1;
  const climbOut = climbOf(0, half);
  const climbBack = mode === "rt" ? climbOf(half, idx.length - 1) : 0;

  let maxG = 0;
  for (let i = lo; i + WIN <= hi; i++) maxG = Math.max(maxG, Math.abs(p.g[i]));

  const surf = [0, 0, 0, 0];
  let road = 0, dismount = 0;
  for (let i = lo; i < hi; i++) {
    const step = p.d[i + 1] - p.d[i];
    surf[p.s[i]] += step;
    if (p.f[i] & F.road) road += step;
    if (p.f[i] & F.dismount) dismount += step;
  }
  const span = Math.max(p.d[hi] - p.d[lo], 1);
  const pois = p.pois.filter((x) => x.i >= lo - 15 && x.i <= hi + 15);
  const crossings = p.crossings.filter((x) => x.i > lo && x.i < hi);

  return {
    p, a, b, mode, why, idx, dist, lo, hi, maxG, climbOut, climbBack,
    length: dist[dist.length - 1],
    surf: surf.map((m) => m / span), road, dismount, pois, crossings,
    near: haversine(NEWCASTLE, [a.lat, a.lon]),
    key: `${p.trail.id}|${p.k}|${a.i}|${e}|${mode}`,
  };
}

// ---------- list ----------

function render() {
  const o = opts();
  current = generate(o);
  const sorters = {
    grade: (x, y) => x.maxG - y.maxG || y.length - x.length,
    near: (x, y) => x.near - y.near || x.maxG - y.maxG,
    long: (x, y) => y.length - x.length,
  };
  current.sort(sorters[o.sort]);
  $("#count").textContent = current.length
    ? `${current.length} ride${current.length === 1 ? "" : "s"} match. Distances to Newcastle are straight-line.`
    : "No rides match. Try a higher grade limit or a shorter minimum length.";
  const ol = $("#rides");
  ol.innerHTML = current.map((r, k) => `<li tabindex="0" data-k="${k}" aria-selected="false">${rideSummary(r)}</li>`).join("");
  ol.querySelectorAll("li").forEach((li) => {
    const pick = () => select(current[+li.dataset.k], li);
    li.addEventListener("click", pick);
    li.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); pick(); } });
  });
  rideLayer.clearLayers();
  $("#ride").hidden = true;
  const want = parseHash()?.k;
  const k = current.findIndex((r) => r.key === want);
  if (k >= 0) select(current[k], ol.children[k]);
}

function tierBadge(g) {
  const k = tierOf(g);
  return `<span class="tier"><span class="sw" style="background:${tierColor(k)}"></span>max ${g.toFixed(1)}%</span>`;
}

function badges(r) {
  const b = [];
  const unverified = r.surf[2] + r.surf[3];
  if (r.surf[1] > 0.05) b.push(`<span class="badge">${Math.round(r.surf[1] * 100)}% groomed gravel</span>`);
  if (unverified > 0.05) b.push(`<span class="badge warn">surface unverified ${Math.round(unverified * 100)}%</span>`);
  if (r.road > 20) b.push(`<span class="badge warn">on-street ${Math.round(r.road * FT)} ft</span>`);
  if (r.dismount > 0) b.push(`<span class="badge warn">dismount section</span>`);
  if (r.crossings.length) b.push(`<span class="badge">${r.crossings.length} road crossing${r.crossings.length > 1 ? "s" : ""}</span>`);
  const kinds = new Set(r.pois.map((x) => x.kind));
  if (kinds.has("toilets")) b.push(`<span class="badge">restroom</span>`);
  if (kinds.has("water")) b.push(`<span class="badge">water</span>`);
  if (kinds.has("viewpoint")) b.push(`<span class="badge">viewpoint</span>`);
  if (r.a.pass === "discover" || r.b?.pass === "discover") b.push(`<span class="badge warn">Discover Pass</span>`);
  return b.join("");
}

function rideSummary(r) {
  const to = r.mode === "rt"
    ? `out ${(r.length / 2 / MI).toFixed(1)} mi and back (turns at ${r.why})`
    : `one-way to ${esc(r.b.name)}`;
  return `<div class="ride-title">${esc(r.p.trail.name)}</div>
    <div class="ride-sub">From ${esc(r.a.name)}: ${to}</div>
    <div class="stats"><span>${(r.length / MI).toFixed(1)} mi</span>
      <span>climb ${Math.round((r.climbOut + r.climbBack) * FT)} ft</span>${tierBadge(r.maxG)}
      <span class="muted">${(r.near / MI).toFixed(0)} mi from Newcastle</span></div>
    <div class="badges">${badges(r)}</div>`;
}

// ---------- map ----------

function setupMap() {
  map = L.map("map").setView([47.55, -122.0], 10);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
  }).addTo(map);
  const base = L.layerGroup().addTo(map);
  const pIcon = L.divIcon({ className: "p-icon", html: "P", iconSize: [18, 18] });
  const poiIcons = { toilets: "WC", water: "H₂O", viewpoint: "View" };
  for (const t of DATA.trails) {
    for (const p of t.pieces) {
      const ll = p.lat.map((v, i) => [v, p.lon[i]]);
      L.polyline(ll, { color: "#6b6a65", weight: 3, opacity: 0.8 }).bindTooltip(esc(t.name)).addTo(base);
      runs(p, (i) => p.f[i] & F.closed).forEach(([i, j]) =>
        L.polyline(ll.slice(i, j + 1), { color: css("--critical"), weight: 6, dashArray: "6 6" })
          .bindTooltip(`Closed: ${esc(t.name)}`).addTo(base));
      for (const a of p.access) L.marker([a.lat, a.lon], { icon: pIcon, title: a.name }).bindPopup(parkingHtml(a)).addTo(base);
      for (const x of p.pois) {
        if (!poiIcons[x.kind]) continue;
        const label = poiIcons[x.kind];
        L.marker([x.lat, x.lon], { icon: L.divIcon({ className: "poi-icon", html: label, iconSize: [label.length * 7 + 8, 16] }), title: x.kind })
          .bindPopup(`${esc(x.name || x.kind)}<br><a href="https://www.openstreetmap.org/${x.osm}" target="_blank" rel="noopener">OSM ${x.osm}</a>`).addTo(base);
      }
    }
  }
  rideLayer = L.layerGroup().addTo(map);
}

function runs(p, pred) {
  const out = [];
  for (let i = 0; i < p.n; i++) {
    if (!pred(i)) continue;
    let j = i;
    while (j + 1 < p.n && pred(j + 1)) j++;
    out.push([Math.max(i - 1, 0), Math.min(j + 1, p.n - 1)]);
    i = j;
  }
  return out;
}

/** Grade at ride position k, centred 100 m window, signed in travel direction. */
function gradeAt(r, k) {
  const k0 = Math.max(0, k - WIN / 2), k1 = Math.min(r.idx.length - 1, k + WIN / 2);
  const dd = r.dist[k1] - r.dist[k0];
  return dd > 0 ? ((r.p.ele[r.idx[k1]] - r.p.ele[r.idx[k0]]) / dd) * 100 : 0;
}

function select(r, li) {
  document.querySelectorAll("#rides li").forEach((x) => x.setAttribute("aria-selected", "false"));
  li.setAttribute("aria-selected", "true");
  history.replaceState(null, "", "#" + encodeURIComponent(JSON.stringify({ k: r.key, o: opts() })));
  rideLayer.clearLayers();
  const p = r.p;
  const out = r.mode === "rt" ? r.idx.slice(0, (r.idx.length + 1) / 2) : r.idx;
  const ll = out.map((i) => [p.lat[i], p.lon[i]]);
  L.polyline(ll, { color: "#fff", weight: 9, opacity: 0.9 }).addTo(rideLayer);
  let k = 0;
  while (k < out.length - 1) {
    const t = tierOf(gradeAt(r, k));
    let j = k;
    while (j < out.length - 1 && tierOf(gradeAt(r, j)) === t) j++;
    L.polyline(ll.slice(k, j + 1), { color: MAP_TIERS[t], weight: 5 }).addTo(rideLayer);
    k = j;
  }
  map.fitBounds(L.latLngBounds(ll).pad(0.15));
  showDetail(r);
}

// ---------- detail ----------

function srcLink(key) {
  const s = DATA.sources[key];
  return s ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>` : esc(key);
}

function withSourceLinks(text) {
  return esc(text).replace(/\(([a-z0-9-]+(?:, [a-z0-9-]+)*)\)/g, (m, keys) =>
    keys.split(", ").every((k) => DATA.sources[k]) ? `(${keys.split(", ").map(srcLink).join(", ")})` : m);
}

function parkingHtml(a) {
  const where = a.address
    ? `${esc(a.address)}${a.address_source ? ` <span class="muted">(address: ${srcLink(a.address_source)})</span>` : ""}`
    : `${a.lat.toFixed(5)}, ${a.lon.toFixed(5)} <span class="muted">(no published address)</span>`;
  const pass = a.pass === "discover" ? `<strong>Discover Pass needed</strong> (${srcLink(a.pass_source)})`
    : a.pass === "free" ? `Free parking (${srcLink(a.pass_source)})` : `Pass: not stated`;
  return `<div class="parking"><strong>${esc(a.name)}</strong>${a.verified ? "" : ' <span class="badge warn">unverified</span>'}<br>
    ${where}<br>${pass}${a.capacity ? ` · ${esc(a.capacity)} spaces (OSM)` : ""}<br>
    ${a.notes ? `<span class="muted">${esc(a.notes)}</span><br>` : ""}
    <a href="https://www.google.com/maps/dir/?api=1&destination=${a.lat},${a.lon}" target="_blank" rel="noopener">Directions</a>
    · Source: ${srcLink(a.source)}</div>`;
}

function showDetail(r) {
  const t = r.p.trail, el = $("#ride");
  const back = r.mode === "rt"
    ? `<span>climb out ${Math.round(r.climbOut * FT)} ft, back ${Math.round(r.climbBack * FT)} ft</span>`
    : `<span>climb ${Math.round(r.climbOut * FT)} ft</span>`;
  el.innerHTML = `
    <h2>${esc(t.name)}</h2>
    <div class="stats"><span>${(r.length / MI).toFixed(2)} mi ${r.mode === "rt" ? "round trip" : "one-way"}</span>${back}${tierBadge(r.maxG)}</div>
    <div class="badges">${badges(r)}</div>
    <h3>Elevation and grade</h3>
    <div class="profile-wrap"><svg class="profile" role="img" aria-label="Elevation profile: ${(r.length / MI).toFixed(1)} miles, max grade ${r.maxG.toFixed(1)} percent"></svg><div class="tip" hidden></div></div>
    <div class="legend">${TIER_LABELS.map((l, k) => `<span class="tier"><span class="sw" style="background:${tierColor(k)}"></span>${l}</span>`).join("")}
      <span>Grade over 100 m, either direction.${r.mode === "rt" ? " The dashed line marks the turnaround." : ""}</span></div>
    <a class="btn" id="gpxBtn" href="#">Download ride GPX</a>
    <a class="btn ghost" href="${esc(r.p.gpx)}" download>Full trail piece GPX</a>
    <h3>Parking</h3>
    ${parkingHtml(r.a)}${r.b ? parkingHtml(r.b) : ""}
    <h3>Trail info</h3>
    <p>${esc(t.surface_summary)} (${(t.surface_sources || []).map(srcLink).join(", ")})</p>
    <p><strong>E-bikes:</strong> ${withSourceLinks(t.ebike)}</p>
    <ul class="notes">${(t.notes || []).map((n) => `<li><span class="kind ${esc(n.kind)}">${esc(n.kind)}</span> ${esc(n.text)} (${srcLink(n.source)})</li>`).join("")}</ul>
    <p><a href="${esc(t.authority_url)}" target="_blank" rel="noopener">${esc(t.authority)} trail page</a>${t.wta_url ? ` · <a href="${esc(t.wta_url)}" target="_blank" rel="noopener">WTA trail page</a>` : ""}</p>`;
  el.hidden = false;
  drawProfile(r, el.querySelector(".profile"), el.querySelector(".tip"));
  $("#gpxBtn").addEventListener("click", (ev) => { ev.preventDefault(); downloadGpx(r); });
}

function drawProfile(r, svg, tip) {
  const W = svg.clientWidth || 600, H = 190, m = { l: 44, r: 8, t: 8, b: 22 };
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const p = r.p, elev = r.idx.map((i) => p.ele[i] * FT);
  let lo = Math.min(...elev), hi = Math.max(...elev);
  const padY = Math.max(20, (hi - lo) * 0.15);
  lo = Math.floor((lo - padY) / 10) * 10;
  hi = Math.ceil((hi + padY) / 10) * 10;
  const X = (d) => m.l + (d / r.length) * (W - m.l - m.r);
  const Y = (e) => m.t + (1 - (e - lo) / (hi - lo)) * (H - m.t - m.b);
  const parts = [];

  const yStep = niceStep((hi - lo) / 4);
  for (let v = Math.ceil(lo / yStep) * yStep; v <= hi; v += yStep)
    parts.push(`<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${m.l - 4}" y="${Y(v) + 4}" text-anchor="end">${v} ft</text>`);
  const lenMi = r.length / MI, xStep = niceStep(lenMi / 5);
  for (let v = 0; v <= lenMi + 1e-9; v += xStep)
    parts.push(`<text x="${X(v * MI)}" y="${H - 6}" text-anchor="middle">${+v.toFixed(2)} mi</text>`);

  // fill under the line, one polygon per run of equal grade tier
  let k = 0;
  while (k < r.idx.length - 1) {
    const t = tierOf(gradeAt(r, k));
    let j = k;
    while (j < r.idx.length - 1 && tierOf(gradeAt(r, j)) === t) j++;
    let d = `M${X(r.dist[k])},${Y(lo)}`;
    for (let q = k; q <= j; q++) d += `L${X(r.dist[q])},${Y(elev[q])}`;
    d += `L${X(r.dist[j])},${Y(lo)}Z`;
    parts.push(`<path d="${d}" fill="${tierColor(t)}"/>`);
    k = j;
  }
  parts.push(`<path d="${elev.map((e, q) => `${q ? "L" : "M"}${X(r.dist[q])},${Y(e)}`).join("")}" fill="none" stroke="${css("--ink")}" stroke-width="1.5"/>`);
  if (r.mode === "rt") {
    const xm = X(r.length / 2);
    parts.push(`<line x1="${xm}" x2="${xm}" y1="${m.t}" y2="${H - m.b}" stroke="${css("--ink-2")}" stroke-dasharray="4 3"/>`);
  }
  parts.push(`<line class="xh" x1="0" x2="0" y1="${m.t}" y2="${H - m.b}" visibility="hidden"/>`);
  svg.innerHTML = parts.join("");

  const xh = svg.querySelector(".xh");
  const move = (ev) => {
    const box = svg.getBoundingClientRect();
    const x = ((ev.clientX - box.left) / box.width) * W;
    const d = Math.min(Math.max((x - m.l) / (W - m.l - m.r), 0), 1) * r.length;
    let q = 0;
    while (q < r.dist.length - 1 && r.dist[q] < d) q++;
    const g = gradeAt(r, q);
    xh.setAttribute("x1", X(r.dist[q]));
    xh.setAttribute("x2", X(r.dist[q]));
    xh.setAttribute("visibility", "visible");
    tip.hidden = false;
    tip.innerHTML = `${(r.dist[q] / MI).toFixed(2)} mi · ${Math.round(elev[q])} ft<br>grade ${g >= 0 ? "+" : ""}${g.toFixed(1)}% ${g >= 0 ? "up" : "down"}`;
    const px = (X(r.dist[q]) / W) * box.width;
    tip.style.left = `${Math.min(px + 8, box.width - tip.offsetWidth)}px`;
    tip.style.top = "4px";
  };
  svg.addEventListener("pointermove", move);
  svg.addEventListener("pointerdown", move);
  svg.addEventListener("pointerleave", () => { tip.hidden = true; xh.setAttribute("visibility", "hidden"); });
}

function niceStep(raw) {
  const pow = 10 ** Math.floor(Math.log10(raw || 1));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

function downloadGpx(r) {
  const p = r.p;
  const name = `${p.trail.name}: ${r.a.name} ${r.mode === "rt" ? "round trip" : "to " + r.b.name}`;
  const pts = r.idx.map((i) => `<trkpt lat="${p.lat[i]}" lon="${p.lon[i]}"><ele>${p.ele[i]}</ele></trkpt>`).join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="eastside-trails" xmlns="http://www.topografix.com/GPX/1/1">
<metadata><name>${esc(name)}</name><copyright author="OpenStreetMap contributors"><license>https://opendatacommons.org/licenses/odbl/</license></copyright></metadata>
<trk><name>${esc(name)}</name><trkseg>
${pts}
</trkseg></trk></gpx>
`;
  const url = URL.createObjectURL(new Blob([xml], { type: "application/gpx+xml" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.gpx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
