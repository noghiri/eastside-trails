"use strict";

const NEWCASTLE = [47.5301, -122.1557];
const MI = 1609.34, FT = 3.28084;
const TIERS = [2, 4, 6, Infinity];
const TIER_LABELS = ["≤2%", "2–4%", "4–6%", ">6%"];
const MAP_TIERS = ["#86b6ef", "#3987e5", "#1c5cab", "#0d366b"]; // map tiles are light in both themes

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const tierOf = (g) => TIERS.findIndex((t) => Math.abs(g) <= t);
const tierColor = (k) => css(`--g${k + 1}`);

let map, baseLayer, rideLayer, worker;
let ACCESS = [], INFO = null, rides = [], gen = 0, selectedCode = null;
const PAGE = 100;
let shown = PAGE;
let center = NEWCASTLE, centerName = "Newcastle";

// ---------- setup ----------

function init() {
  map = L.map("map", { preferCanvas: true }).setView(center, 10);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
  }).addTo(map);
  baseLayer = L.layerGroup().addTo(map);
  rideLayer = L.layerGroup().addTo(map);
  loadFilters();
  const link = parseHash();
  if (link?.o) applyFilters(link.o);
  if (link?.center) { center = link.center; centerName = link.centerName || "map point"; }
  document.querySelectorAll(".filters input, .filters select").forEach((el) =>
    el.addEventListener("change", () => (el.id === "radius" ? load() : generate())));
  $("#pickCenter").addEventListener("click", () => {
    document.body.classList.add("picking");
    $("#count").textContent = "Click the map to set the search center.";
  });
  map.on("click", (ev) => {
    if (!document.body.classList.contains("picking")) return;
    document.body.classList.remove("picking");
    center = [ev.latlng.lat, ev.latlng.lng];
    centerName = "map point";
    load();
  });
  load();
}

function load() {
  if (worker) worker.terminate();
  worker = new Worker("router.js");
  worker.onmessage = onWorker;
  worker.onerror = (e) => { $("#count").textContent = `Something went wrong: ${e.message}`; };
  rides = [];
  $("#rides").innerHTML = "";
  $("#ride").hidden = true;
  rideLayer.clearLayers();
  $("#centerName").textContent = centerName;
  $("#count").textContent = "Loading map data…";
  worker.postMessage({ type: "load", center, radius: +$("#radius").value || 30 });
}

function onWorker(ev) {
  const m = ev.data;
  if (m.type === "progress") $("#count").textContent = m.text;
  else if (m.type === "loaded") {
    ACCESS = m.access;
    INFO = m.info;
    drawBase(m.closures);
    generate();
    const want = parseHash();
    if (want?.short || want?.c) requestDetail(want);
  } else if (m.type === "rides") {
    if (m.gen !== gen) return;
    rides.push(...m.rides);
    renderList(m.done < m.total ? `${m.done}/${m.total} parking spots checked…` : null);
  } else if (m.type === "detail") {
    if (m.error) { $("#count").textContent = m.error; return; }
    showDetail(m.ride);
  }
}

// ---------- filters ----------

function opts() {
  const o = {
    grade: +document.querySelector('input[name="grade"]:checked').value,
    min: Math.max(0, +$("#minLen").value || 0),
    max: Math.max(0.5, +$("#maxLen").value || 10),
    surface: $("#surface").value,
    avoidDismount: $("#avoidDismount").checked,
    avoidRoad: $("#avoidRoad").checked,
    walk: $("#walk").checked,
    walkMax: Math.max(10, +$("#walkMax").value || 200),
    shapes: { outback: $("#shapeOutback").checked, loop: $("#shapeLoop").checked, oneway: $("#shapeOneway").checked },
    radius: +$("#radius").value || 30,
    sort: $("#sort").value,
  };
  try { localStorage.setItem("filters-next", JSON.stringify(o)); } catch (e) { /* storage unavailable */ }
  return o;
}

function loadFilters() {
  let o;
  try { o = JSON.parse(localStorage.getItem("filters-next")); } catch (e) { return; }
  if (o) applyFilters(o);
}

function applyFilters(o) {
  const el = document.querySelector(`input[name="grade"][value="${o.grade}"]`);
  if (el) el.checked = true;
  $("#minLen").value = o.min; $("#maxLen").value = o.max; $("#surface").value = o.surface;
  $("#avoidDismount").checked = o.avoidDismount; $("#avoidRoad").checked = o.avoidRoad;
  $("#walk").checked = !!o.walk; $("#walkMax").value = o.walkMax || 200;
  if (o.shapes) {
    $("#shapeOutback").checked = o.shapes.outback; $("#shapeLoop").checked = o.shapes.loop; $("#shapeOneway").checked = o.shapes.oneway;
  }
  if (o.radius) $("#radius").value = o.radius;
  if (o.sort) $("#sort").value = o.sort;
}

/** Short form: #r=<ride>&g=<grade>[&w=<walk m>]; older links carry a JSON object. */
function parseHash() {
  const h = location.hash.slice(1);
  if (h.startsWith("r=")) {
    const q = new URLSearchParams(h);
    const o = { ...opts(), grade: +q.get("g") || 4, walk: q.has("w"), walkMax: +q.get("w") || 200 };
    return { short: q.get("r"), o };
  }
  try { return JSON.parse(decodeURIComponent(h)); } catch (e) { return null; }
}

function generate() {
  gen++;
  shown = PAGE;
  rides = [];
  $("#rides").innerHTML = "";
  $("#ride").hidden = true;
  rideLayer.clearLayers();
  const o = opts();
  if (!o.shapes.outback && !o.shapes.loop && !o.shapes.oneway) {
    $("#count").textContent = "Pick at least one ride shape.";
    return;
  }
  worker.postMessage({ type: "generate", gen, opts: o });
}

// ---------- list ----------

function renderList(progress) {
  const sort = $("#sort").value;
  const sorters = {
    grade: (x, y) => x.maxG - y.maxG || x.steep.length - y.steep.length || y.length - x.length,
    near: (x, y) => ACCESS[x.start].near - ACCESS[y.start].near || x.maxG - y.maxG,
    long: (x, y) => y.length - x.length,
  };
  rides.sort(sorters[sort]);
  $("#count").textContent = (rides.length
    ? `${rides.length} ride${rides.length === 1 ? "" : "s"}. Distances are straight-line from ${centerName}.`
    : progress ? "" : "No rides match. Try a higher grade limit, a shorter minimum, or allowing walk-ups.") + (progress ? ` ${progress}` : "") +
    ($("#surface").value === "dirt" ? " Dirt rides don't check e-bike rules yet: most King County backcountry and DNR singletrack (e.g. Tiger Mountain, Raging River) is closed to e-bikes of every class." : "");
  const ol = $("#rides");
  ol.innerHTML = rides.slice(0, shown).map((r, k) =>
    `<li tabindex="0" data-k="${k}" aria-selected="${r.code === selectedCode}">${rideSummary(r)}</li>`).join("") +
    (rides.length > shown ? `<li class="more"><button type="button" class="btn ghost" id="moreBtn">Show more rides (${rides.length - shown} more)</button></li>` : "");
  $("#moreBtn")?.addEventListener("click", () => { shown += PAGE; renderList(); });
  ol.querySelectorAll("li[data-k]").forEach((li) => {
    const pick = () => select(rides[+li.dataset.k]);
    li.addEventListener("click", pick);
    li.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); pick(); } });
  });
}

function tierBadge(g, label = "max") {
  return `<span class="tier"><span class="sw" style="background:${tierColor(tierOf(g))}"></span>${label} ${g.toFixed(1)}%</span>`;
}

const SHAPE_TEXT = { "out-and-back": "Out-and-back", loop: "Loop", lollipop: "Lollipop", "one-way": "One-way" };

function rideTitle(r) {
  const named = r.names.slice(0, 2).join(" + ");
  if (named) return named;
  const trail = ACCESS[r.start]?.trail;
  return trail ? `${trail} paths` : "Unnamed paths";
}

function rideSub(r) {
  const a = ACCESS[r.start];
  if (r.shape === "out-and-back") return `From ${esc(a.name)}: out ${(r.length / 2 / MI).toFixed(1)} mi and back (turns at ${esc(r.why)})`;
  if (r.shape === "one-way") return `From ${esc(a.name)} to ${esc(ACCESS[r.end]?.name)}`;
  if (r.shape === "lollipop") return `From ${esc(a.name)}: loop, plus a ${(r.retraced / MI).toFixed(2)} mi stem from the parking ridden both ways`;
  return `From ${esc(a.name)}: loop, no repeated sections`;
}

function badges(r) {
  const b = [];
  if (r.steep.length) {
    const g = Math.max(...r.steep.map((x) => x.g));
    const word = $("#walk").checked && r.maxRide <= (+document.querySelector('input[name="grade"]:checked').value) ? "walk-up" : "steep spot";
    b.push(`<span class="badge warn">⚠ ${r.steep.length} ${word}${r.steep.length > 1 ? "s" : ""}, up to ${g.toFixed(1)}%</span>`);
  }
  const pct = (x) => Math.round(x * 100);
  if (r.surf[1] > 0.05) b.push(`<span class="badge">${pct(r.surf[1])}% groomed gravel</span>`);
  if (r.surf[2] > 0.05) b.push(`<span class="badge">${pct(r.surf[2])}% loose gravel</span>`);
  if (r.surf[4] > 0.05) b.push(`<span class="badge">${pct(r.surf[4])}% dirt</span>`);
  if (r.surf[3] > 0.05) b.push(`<span class="badge warn">surface not mapped ${pct(r.surf[3])}%</span>`);
  if (r.road > 20) b.push(`<span class="badge warn">on-street ${Math.round(r.road * FT)} ft</span>`);
  if (r.dismount > 0) b.push(`<span class="badge warn">dismount section</span>`);
  if (r.unconfirmed > 20) b.push(`<span class="badge warn">bike access not confirmed ${Math.round(r.unconfirmed * FT)} ft</span>`);
  if (r.joins) b.push(`<span class="badge">${r.joins} unmapped link${r.joins > 1 ? "s" : ""}</span>`);
  if (r.coarseElev > 100) b.push(`<span class="badge">10 m elevation on ${Math.round(r.coarseElev / r.length * 100)}%</span>`);
  const kinds = new Set(r.pois);
  if (kinds.has("toilets")) b.push(`<span class="badge">restroom</span>`);
  if (kinds.has("water")) b.push(`<span class="badge">water</span>`);
  if (kinds.has("viewpoint")) b.push(`<span class="badge">viewpoint</span>`);
  const a = ACCESS[r.start];
  if (a.pass === "discover" || ACCESS[r.end]?.pass === "discover") b.push(`<span class="badge warn">Discover Pass</span>`);
  if (!a.verified) b.push(`<span class="badge warn">${a.tier === "possible" ? "parking possible, unverified" : "parking unverified"}</span>`);
  return b.join("");
}

function rideSummary(r) {
  const climb = r.shape === "out-and-back"
    ? `climb ${Math.round(r.climbOut * FT)} ft out, ${Math.round(r.climbBack * FT)} back` : `climb ${Math.round(r.climb * FT)} ft`;
  return `<div class="shape">${SHAPE_TEXT[r.shape]}</div>
    <div class="ride-title">${esc(rideTitle(r))}</div>
    <div class="ride-sub">${rideSub(r)}</div>
    <div class="stats"><span>${(r.length / MI).toFixed(1)} mi</span><span>${climb}</span>${tierBadge(r.maxRide)}
      <span class="muted">${(ACCESS[r.start].near / MI).toFixed(0)} mi away</span></div>
    <div class="badges">${badges(r)}</div>`;
}

// ---------- map ----------

function drawBase(closures) {
  baseLayer.clearLayers();
  L.circle(center, { radius: (+$("#radius").value || 30) * MI, color: "#6b6a65", weight: 1, fill: false, dashArray: "4 6", interactive: false }).addTo(baseLayer);
  for (const c of closures)
    L.polyline(c.g, { color: css("--critical"), weight: 5, dashArray: "6 6" }).bindTooltip(`Closed${c.n ? ": " + esc(c.n) : ""}`).addTo(baseLayer);
  for (const a of ACCESS) {
    const icon = L.divIcon({ className: `p-icon${a.verified ? "" : " unverified"}`, html: "P", iconSize: [18, 18] });
    L.marker([a.lat, a.lon], { icon, title: a.name }).bindPopup(parkingHtml(a)).addTo(baseLayer);
  }
}

function select(r) {
  selectedCode = r.code;
  document.querySelectorAll("#rides li").forEach((li) => li.setAttribute("aria-selected", rides[+li.dataset.k]?.code === r.code));
  requestDetail({ c: r.code, shape: r.shape, why: r.why, end: r.end });
}

function requestDetail(w) {
  selectedCode = w.c || null;
  worker.postMessage({ type: "detail", code: w.c, short: w.short, shape: w.shape, why: w.why, end: w.end, opts: opts() });
}

function shareUrl(r) {
  const o = opts();
  const q = `r=${r.short}&g=${o.grade}${o.walk ? `&w=${o.walkMax}` : ""}`;
  return `${location.origin}${location.pathname}#${q}`;
}

function gradeAt(d, ride) {
  const i = Math.min(ride.grade10.length - 11, Math.max(0, Math.round(d / 10) - 5));
  return i >= 0 ? ride.grade10[i + 10] - ride.grade10[i] : 0;
}

function drawRide(ride) {
  rideLayer.clearLayers();
  const ll = ride.lat.map((v, i) => [v, ride.lon[i]]);
  L.polyline(ll, { color: "#fff", weight: 9, opacity: 0.9 }).addTo(rideLayer);
  let k = 0;
  while (k < ll.length - 1) {
    const t = tierOf(gradeAt(ride.d[k], ride));
    let j = k;
    while (j < ll.length - 1 && tierOf(gradeAt(ride.d[j], ride)) === t) j++;
    L.polyline(ll.slice(k, j + 1), { color: MAP_TIERS[t], weight: 5 }).addTo(rideLayer);
    k = j;
  }
  const at = (dist) => {
    let i = 0;
    while (i < ride.d.length - 1 && ride.d[i] < dist) i++;
    return [ride.lat[i], ride.lon[i]];
  };
  for (const x of ride.steep)
    L.marker(at(x.at + x.len / 2), { icon: L.divIcon({ className: "steep-icon", html: `⚠ ${x.g.toFixed(1)}%`, iconSize: [58, 18] }) })
      .bindTooltip(`${x.g.toFixed(1)}% for about ${Math.round((x.len * FT) / 10) * 10} ft (${x.shape})`).addTo(rideLayer);
  const poiLabel = { toilets: "WC", water: "H₂O", viewpoint: "View" };
  for (const p of ride.poiList) {
    if (!poiLabel[p.k]) continue;
    L.marker([p.lat, p.lon], { icon: L.divIcon({ className: "poi-icon", html: poiLabel[p.k], iconSize: [poiLabel[p.k].length * 7 + 8, 16] }) })
      .bindPopup(`${esc(p.name || p.k)}<br><a href="https://www.openstreetmap.org/${p.osm}" target="_blank" rel="noopener">OSM ${p.osm}</a>`).addTo(rideLayer);
  }
  map.fitBounds(L.latLngBounds(ll).pad(0.15));
}

// ---------- detail ----------

function srcLink(key) {
  const s = INFO.sources[key];
  if (key === "osm" && !s) return `<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>`;
  return s ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>` : esc(key);
}

function withSourceLinks(text) {
  return esc(text).replace(/\(([a-z0-9-]+(?:, [a-z0-9-]+)*)\)/g, (m, keys) =>
    keys.split(", ").every((k) => INFO.sources[k]) ? `(${keys.split(", ").map(srcLink).join(", ")})` : m);
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

function trailInfoHtml(r) {
  const names = new Set(r.names);
  const a = ACCESS[r.start];
  if (a.trail) names.add(a.trail);
  return [...names].filter((n) => INFO.trails[n]).map((n) => {
    const t = INFO.trails[n];
    return `<h3>${esc(n)}</h3>
      <p>${esc(t.surface_summary)} (${(t.surface_sources || []).map(srcLink).join(", ")})</p>
      <p><strong>E-bikes:</strong> ${withSourceLinks(t.ebike)}</p>
      <ul class="notes">${(t.notes || []).map((x) => `<li><span class="kind ${esc(x.kind)}">${esc(x.kind)}</span> ${esc(x.text)} (${srcLink(x.source)})</li>`).join("")}</ul>
      <p><a href="${esc(t.authority_url)}" target="_blank" rel="noopener">${esc(t.authority)} page</a>${t.wta_url ? ` · <a href="${esc(t.wta_url)}" target="_blank" rel="noopener">WTA trail page</a>` : ""}</p>`;
  }).join("");
}

function steepHtml(r) {
  if (!r.steep.length) return "";
  const again = r.shape === "out-and-back" ? " (and again on the way back)" : "";
  return `<h3>⚠ Steep spots</h3><ul class="notes">${r.steep.map((x) =>
    `<li>Mile ${(x.at / MI).toFixed(2)}${again}: ${x.g.toFixed(1)}% for about ${Math.round((x.len * FT) / 10) * 10} ft (${x.shape}). You may need to walk.</li>`).join("")}</ul>`;
}

function showDetail(r) {
  selectedCode = r.code;
  if (r.short) history.replaceState(null, "", shareUrl(r));
  drawRide(r);
  const el = $("#ride");
  const climb = r.shape === "out-and-back"
    ? `<span>climb out ${Math.round(r.climbOut * FT)} ft, back ${Math.round(r.climbBack * FT)} ft</span>`
    : `<span>climb ${Math.round(r.climb * FT)} ft</span>`;
  el.innerHTML = `
    <div class="shape">${SHAPE_TEXT[r.shape] || ""}</div>
    <h2>${esc(rideTitle(r))}</h2>
    <div class="stats"><span>${(r.length / MI).toFixed(2)} mi</span>${climb}${tierBadge(r.maxRide)}</div>
    <div class="badges">${badges(r)}</div>
    ${r.approach > 1 ? `<p class="muted">The ride starts about ${Math.round(r.approach * FT / 10) * 10} ft from the parking spot.</p>` : ""}
    ${steepHtml(r)}
    <h3>Elevation and grade</h3>
    <div class="profile-wrap"><svg class="profile" role="img" aria-label="Elevation profile: ${(r.length / MI).toFixed(1)} miles, max grade ${r.maxG.toFixed(1)} percent"></svg><div class="tip" hidden></div></div>
    <div class="legend">${TIER_LABELS.map((l, k) => `<span class="tier"><span class="sw" style="background:${tierColor(k)}"></span>${l}</span>`).join("")}
      <span>Grade over 100 m, either direction.${r.shape === "out-and-back" ? " The dashed line marks the turnaround." : ""}</span></div>
    ${r.short ? `<button type="button" class="btn" id="shareBtn">Share this ride</button>` : ""}
    <a class="btn ghost" id="gpxBtn" href="#">Download ride GPX</a>
    <p class="muted" id="shareMsg" aria-live="polite"></p>
    <h3>Parking</h3>
    ${parkingHtml(ACCESS[r.start])}${r.end !== undefined && r.end !== null && ACCESS[r.end] ? parkingHtml(ACCESS[r.end]) : ""}
    ${trailInfoHtml(r)}`;
  el.hidden = false;
  drawProfile(r, el.querySelector(".profile"), el.querySelector(".tip"));
  $("#gpxBtn").addEventListener("click", (ev) => { ev.preventDefault(); downloadGpx(r); });
  $("#shareBtn")?.addEventListener("click", () => shareRide(r));
}

async function shareRide(r) {
  const a = ACCESS[r.start];
  const title = `${rideTitle(r)}: ${SHAPE_TEXT[r.shape].toLowerCase()}, ${(r.length / MI).toFixed(1)} mi`;
  const text = `${title}${a ? ` from ${a.name}` : ""}, max grade ${r.maxRide.toFixed(1)}%`;
  const url = shareUrl(r);
  if (navigator.share) {
    try { await navigator.share({ title, text, url }); return; } catch (e) { if (e.name === "AbortError") return; }
  }
  try {
    await navigator.clipboard.writeText(`${text}
${url}`);
    $("#shareMsg").textContent = "Link copied.";
  } catch (e) {
    $("#shareMsg").innerHTML = `Copy this link: <input type="text" readonly value="${esc(url)}" style="width:100%">`;
  }
}

function niceStep(raw) {
  const pow = 10 ** Math.floor(Math.log10(raw || 1));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

function drawProfile(r, svg, tip) {
  const W = svg.clientWidth || 600, H = 190, m = { l: 44, r: 8, t: 8, b: 22 };
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const elev = Array.from(r.grade10, (v) => v * FT);
  const dist = elev.map((_, i) => Math.min(i * 10, r.length));
  let lo = Math.min(...elev), hi = Math.max(...elev);
  const padY = Math.max(20, (hi - lo) * 0.15);
  lo = Math.floor((lo - padY) / 10) * 10;
  hi = Math.ceil((hi + padY) / 10) * 10;
  const X = (d) => m.l + (d / r.length) * (W - m.l - m.r);
  const Y = (e) => m.t + (1 - (e - lo) / (hi - lo)) * (H - m.t - m.b);
  const g = (i) => { const a = Math.max(0, i - 5), b = Math.min(elev.length - 1, i + 5); return b > a ? (r.grade10[b] - r.grade10[a]) / ((b - a) * 10) * 100 : 0; };
  const parts = [];
  const yStep = niceStep((hi - lo) / 4);
  for (let v = Math.ceil(lo / yStep) * yStep; v <= hi; v += yStep)
    parts.push(`<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${m.l - 4}" y="${Y(v) + 4}" text-anchor="end">${v} ft</text>`);
  const lenMi = r.length / MI, xStep = niceStep(lenMi / 5);
  for (let v = 0; v <= lenMi + 1e-9; v += xStep) parts.push(`<text x="${X(v * MI)}" y="${H - 6}" text-anchor="middle">${+v.toFixed(2)} mi</text>`);
  let k = 0;
  while (k < elev.length - 1) {
    const t = tierOf(g(k));
    let j = k;
    while (j < elev.length - 1 && tierOf(g(j)) === t) j++;
    let d = `M${X(dist[k])},${Y(lo)}`;
    for (let q = k; q <= j; q++) d += `L${X(dist[q])},${Y(elev[q])}`;
    parts.push(`<path d="${d}L${X(dist[j])},${Y(lo)}Z" fill="${tierColor(t)}"/>`);
    k = j;
  }
  parts.push(`<path d="${elev.map((e, q) => `${q ? "L" : "M"}${X(dist[q])},${Y(e)}`).join("")}" fill="none" stroke="${css("--ink")}" stroke-width="1.5"/>`);
  const spans = [];
  for (const x of r.steep) {
    spans.push([x.at, x.at + x.len]);
    if (r.shape === "out-and-back") spans.push([r.length - x.at - x.len, r.length - x.at]);
  }
  for (const [a, b] of spans)
    parts.push(`<rect x="${X(a)}" y="${m.t}" width="${Math.max(X(b) - X(a), 2)}" height="${H - m.t - m.b}" fill="${css("--steep")}" opacity="0.35"/>`);
  if (r.shape === "out-and-back") {
    const xm = X(r.length / 2);
    parts.push(`<line x1="${xm}" x2="${xm}" y1="${m.t}" y2="${H - m.b}" stroke="${css("--ink-2")}" stroke-dasharray="4 3"/>`);
  }
  parts.push(`<line class="xh" x1="0" x2="0" y1="${m.t}" y2="${H - m.b}" visibility="hidden"/>`);
  svg.innerHTML = parts.join("");
  const xh = svg.querySelector(".xh");
  const move = (ev) => {
    const box = svg.getBoundingClientRect();
    const x = ((ev.clientX - box.left) / box.width) * W;
    const q = Math.max(0, Math.min(elev.length - 1, Math.round(((x - m.l) / (W - m.l - m.r)) * r.length / 10)));
    const gr = g(q);
    xh.setAttribute("x1", X(dist[q])); xh.setAttribute("x2", X(dist[q])); xh.setAttribute("visibility", "visible");
    tip.hidden = false;
    tip.innerHTML = `${(dist[q] / MI).toFixed(2)} mi · ${Math.round(elev[q])} ft<br>grade ${gr >= 0 ? "+" : ""}${gr.toFixed(1)}% ${gr >= 0 ? "up" : "down"}`;
    tip.style.left = `${Math.min((X(dist[q]) / W) * box.width + 8, box.width - tip.offsetWidth)}px`;
    tip.style.top = "4px";
  };
  svg.addEventListener("pointermove", move);
  svg.addEventListener("pointerdown", move);
  svg.addEventListener("pointerleave", () => { tip.hidden = true; xh.setAttribute("visibility", "hidden"); });
}

function downloadGpx(r) {
  const a = ACCESS[r.start];
  const name = `${rideTitle(r)} from ${a.name} (${SHAPE_TEXT[r.shape]})`;
  const pts = r.lat.map((la, i) => `<trkpt lat="${la.toFixed(6)}" lon="${r.lon[i].toFixed(6)}"><ele>${r.ele[i].toFixed(1)}</ele></trkpt>`).join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="eastside-trails" xmlns="http://www.topografix.com/GPX/1/1">
<metadata><name>${esc(name)}</name><copyright author="OpenStreetMap contributors"><license>https://opendatacommons.org/licenses/odbl/</license></copyright></metadata>
<trk><name>${esc(name)}</name><trkseg>
${pts}
</trkseg></trk></gpx>
`;
  const url = URL.createObjectURL(new Blob([xml], { type: "application/gpx+xml" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.gpx`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

init();
