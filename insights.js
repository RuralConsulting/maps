/* RCL portal: staff insights dashboard. How customers are using their maps: visits over time, who's active,
 * when they look, which properties, who hasn't signed in yet. Drawn with plain SVG (no chart library).
 * RCLInsights.render(element, data, { openMap(farm, map), openInbox() })   data = staff_insights() from the database */
(function () {
  "use strict";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const DAY = 864e5;
  const num = (n) => (n >= 10000 ? (n / 1000).toFixed(n >= 1e5 ? 0 : 1) + "K" : n.toLocaleString("en-NZ"));
  const pct = (n) => Math.round(n * 100) + "%";
  const dfmt = (t, o) => new Date(t).toLocaleDateString("en-NZ", o || { day: "numeric", month: "short" });
  const ago = (t, now) => {
    const s = (now - t) / 1000;
    if (s < 90) return "just now";
    if (s < 3600) return Math.round(s / 60) + " min ago";
    if (s < 86400) return Math.round(s / 3600) + " h ago";
    if (s < 86400 * 30) return Math.round(s / 86400) + " d ago";
    return dfmt(t, { day: "numeric", month: "short", year: "numeric" });
  };
  const RANGES = [[30, "30 days"], [90, "90 days"], [365, "12 months"]];
  const state = { days: 30, staff: false, sort: "visits", dir: -1 };
  let tip = null;

  function tooltip(html, x, y) {
    if (!tip) { tip = document.createElement("div"); tip.className = "in-tip"; document.body.appendChild(tip); }
    if (!html) { tip.hidden = true; return; }
    tip.innerHTML = html; tip.hidden = false;
    const r = tip.getBoundingClientRect();
    tip.style.left = Math.max(8, Math.min(window.innerWidth - r.width - 8, x + 14)) + "px";
    tip.style.top = Math.max(8, y - r.height - 12) + "px";
  }

  // ---------------------------------------------------------------- crunch the numbers for the chosen period
  function crunch(d) {
    const now = new Date(d.now).getTime();
    const staffIds = new Set(d.people.filter((p) => p.staff).map((p) => p.id));
    const person = Object.fromEntries(d.people.map((p) => [p.id, p]));
    const farm = Object.fromEntries(d.farms.map((f) => [f.id, f]));
    const map = Object.fromEntries(d.maps.map((m) => [m.id, m]));
    const views = d.views.map(([t, f, m, u, dev]) => ({ t: new Date(t).getTime(), f, m, u, dev: dev || "computer" }))
      .filter((v) => state.staff || !staffIds.has(v.u));
    const start = now - state.days * DAY, prevStart = start - state.days * DAY;
    const cur = views.filter((v) => v.t >= start), prev = views.filter((v) => v.t >= prevStart && v.t < start);
    const customers = [...new Set(d.members.map((m) => m.user))].filter((u) => !staffIds.has(u));
    const active = new Set(cur.map((v) => v.u).filter((u) => customers.includes(u)));
    const liveMaps = d.maps.filter((m) => m.published && !m.archived);
    const liveFarms = new Set(liveMaps.map((m) => m.farm));
    const neverIn = customers.filter((u) => person[u] && !person[u].last_sign_in);
    // columns: days for 30, weeks otherwise
    const step = state.days <= 31 ? DAY : 7 * DAY;
    const n = Math.ceil(state.days * DAY / step);
    const t0 = now - n * step;
    const cols = Array.from({ length: n }, (_, i) => ({ from: t0 + i * step, to: t0 + (i + 1) * step, computer: 0, phone: 0 }));
    cur.forEach((v) => { const i = Math.floor((v.t - t0) / step); if (cols[i]) cols[i][v.dev === "phone" ? "phone" : "computer"]++; });
    // weekday x hour (viewer's local time, i.e. NZ for RCL)
    const heat = Array.from({ length: 7 }, () => new Array(24).fill(0));
    cur.forEach((v) => { const dt = new Date(v.t); heat[(dt.getDay() + 6) % 7][dt.getHours()]++; });
    // per property
    const weeks12 = now - 12 * 7 * DAY;
    const props = d.farms.map((f) => {
      const fv = views.filter((v) => v.f === f.id);
      const fc = cur.filter((v) => v.f === f.id);
      const people = d.members.filter((m) => m.farm === f.id && !staffIds.has(m.user)).map((m) => m.user);
      const spark = new Array(12).fill(0);
      fv.forEach((v) => { if (v.t >= weeks12) spark[Math.min(11, Math.floor((v.t - weeks12) / (7 * DAY)))]++; });
      const maps = d.maps.filter((m) => m.farm === f.id);
      const b = maps.map((m) => m.bounds).find(Boolean);
      return { f, maps, live: maps.filter((m) => m.published && !m.archived).length, people,
        activePeople: new Set(fc.map((v) => v.u).filter((u) => people.includes(u))).size,
        visits: fc.length, last: fv.length ? fv[fv.length - 1].t : null, spark,
        open: d.suggestions.filter((s) => s.farm === f.id && (s.status === "new" || s.status === "in_progress")).length,
        centre: b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : null };
    }).filter((p) => p.maps.length);
    // people to follow up: given access but never signed in, or no visits in 90 days
    const lastVisit = {};
    views.forEach((v) => { if (!lastVisit[v.u] || v.t > lastVisit[v.u]) lastVisit[v.u] = v.t; });
    const follow = [];
    d.members.forEach((m) => {
      const p = person[m.user];
      if (!p || staffIds.has(m.user)) return;
      const lv = lastVisit[m.user];
      if (!p.last_sign_in) follow.push({ p, f: farm[m.farm], why: "Hasn't signed in yet", since: new Date(m.added).getTime(), rank: 0 });
      else if (!lv || lv < now - 90 * DAY) follow.push({ p, f: farm[m.farm], why: lv ? "No visits in 90+ days" : "Signed in, never opened a map", since: lv || new Date(p.last_sign_in).getTime(), rank: 1 });
    });
    follow.sort((a, b) => a.rank - b.rank || a.since - b.since);
    const recent = views.slice(-8).reverse().map((v) => ({ ...v, email: (person[v.u] || {}).email || "someone", farm: farm[v.f], map: map[v.m] }));
    const spark = (arr, from, k) => { const out = new Array(k).fill(0), w = (now - from) / k; arr.forEach((v) => { const i = Math.floor((v.t - from) / w); if (i >= 0 && i < k) out[i]++; }); return out; };
    return { now, cur, prev, customers, active, liveMaps, liveFarms, neverIn, cols, step, heat, props, follow, recent,
      phone: cur.filter((v) => v.dev === "phone").length,
      visitSpark: spark(views, start, 12),
      openSugg: d.suggestions.filter((s) => s.status === "new" || s.status === "in_progress").length,
      newSugg: d.suggestions.filter((s) => s.status === "new").length,
      offline: d.maps.filter((m) => m.archived).length };
  }

  // ---------------------------------------------------------------- small pieces
  function sparkSvg(vals, w = 96, h = 26) {
    const max = Math.max(1, ...vals), dx = w / Math.max(1, vals.length - 1);
    const pts = vals.map((v, i) => [i * dx, h - 3 - (v / max) * (h - 6)]);
    const d = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join("");
    const last = pts[pts.length - 1];
    return `<svg class="in-spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">
      <path d="${d}" class="in-spark-line"/><circle cx="${last[0]}" cy="${last[1]}" r="3" class="in-spark-dot"/></svg>`;
  }
  function tile(label, value, sub, extra, cls) {
    return `<div class="in-tile ${cls || ""}"><div class="in-tile-label">${esc(label)}</div>
      <div class="in-tile-value">${value}</div><div class="in-tile-sub">${sub || ""}</div>${extra || ""}</div>`;
  }
  function delta(curN, prevN) {
    if (!prevN && !curN) return `<span class="in-delta">no visits either period</span>`;
    if (!prevN) return `<span class="in-delta up">new this period</span>`;
    const ch = (curN - prevN) / prevN;
    const cls = ch > 0.02 ? "up" : ch < -0.02 ? "down" : "";
    const range = RANGES.find((r) => r[0] === state.days)[1];
    if (ch >= 2) return `<span class="in-delta up">▲ ${(curN / prevN).toFixed(curN / prevN < 10 ? 1 : 0)}× the previous ${range}</span>`;
    return `<span class="in-delta ${cls}">${ch > 0.02 ? "▲" : ch < -0.02 ? "▼" : "●"} ${pct(Math.abs(ch))} vs previous ${range}</span>`;
  }

  // ---------------------------------------------------------------- visits over time: stacked columns, computer + phone
  function visitsChart(el, c) {
    const W = el.clientWidth || 800, H = 240, L = 34, R = 8, T = 12, B = 26;
    const max = Math.max(1, ...c.cols.map((k) => k.computer + k.phone));
    // whole-number gridlines: 1, 2, 5, 10, 20, 50 ... per step, about four of them
    const stepOf = (m) => { const p = Math.pow(10, Math.floor(Math.log10(m))), f = m / p; return Math.max(1, (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p); };
    const tick = stepOf(max / 4), top = tick * Math.max(1, Math.ceil(max / tick));
    const n = c.cols.length, band = (W - L - R) / n, bw = Math.min(24, Math.max(3, band * 0.66));
    const y = (v) => T + (H - T - B) * (1 - v / top);
    let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Map visits over time">`;
    for (let i = 0; i <= top / tick; i++) {
      const v = tick * i, yy = y(v);
      s += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" class="in-grid"/><text x="${L - 6}" y="${yy + 4}" class="in-axis" text-anchor="end">${num(v)}</text>`;
    }
    const lab = Math.ceil(n / Math.max(2, Math.min(8, Math.floor((W - L - R) / 72))));   // date labels that fit the width
    c.cols.forEach((k, i) => {
      const x = L + i * band + (band - bw) / 2;
      const yc = y(k.computer), yp = y(k.computer + k.phone);
      const r = Math.min(4, bw / 2);
      if (k.computer) s += `<path class="in-bar-c" d="M${x} ${y(0)}V${yc + (k.phone ? 0 : r)}${k.phone ? "" : `Q${x} ${yc} ${x + r} ${yc}H${x + bw - r}Q${x + bw} ${yc} ${x + bw} ${yc + r}`}${k.phone ? `H${x + bw}` : ""}V${y(0)}Z"/>`;
      if (k.phone) { const y0 = k.computer ? yc - 2 : y(0); if (y0 - yp > 0.5) s += `<path class="in-bar-p" d="M${x} ${y0}V${yp + r}Q${x} ${yp} ${x + r} ${yp}H${x + bw - r}Q${x + bw} ${yp} ${x + bw} ${yp + r}V${y0}Z"/>`; }
      s += `<rect x="${L + i * band}" y="${T}" width="${band}" height="${H - T - B}" class="in-hit" data-i="${i}"/>`;
      if (i % lab === 0) s += `<text x="${L + i * band + band / 2}" y="${H - 8}" class="in-axis" text-anchor="middle">${dfmt(k.from)}</text>`;
    });
    s += `<line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" class="in-base"/></svg>`;
    el.innerHTML = s;
    el.querySelectorAll(".in-hit").forEach((h) => {
      h.addEventListener("mousemove", (e) => {
        const k = c.cols[+h.dataset.i];
        const when = c.step === DAY ? dfmt(k.from, { weekday: "short", day: "numeric", month: "short" }) : `Week of ${dfmt(k.from)}`;
        tooltip(`<b>${esc(when)}</b><div><span class="in-key c"></span>Computer <b>${k.computer}</b></div><div><span class="in-key p"></span>Phone <b>${k.phone}</b></div>`, e.clientX, e.clientY);
        h.classList.add("on");
      });
      h.addEventListener("mouseleave", () => { tooltip(null); h.classList.remove("on"); });
    });
  }

  // ---------------------------------------------------------------- when customers look: weekday x hour
  function heatmap(el, c) {
    const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const max = Math.max(1, ...c.heat.flat());
    let s = `<div class="in-heat" role="img" aria-label="Visits by day of week and hour"><div></div>`;
    for (let h = 0; h < 24; h++) s += `<div class="in-heat-h">${h % 6 === 0 ? (h === 0 ? "12am" : h === 12 ? "12pm" : h < 12 ? h + "am" : h - 12 + "pm") : ""}</div>`;
    c.heat.forEach((row, d) => {
      s += `<div class="in-heat-d">${days[d]}</div>`;
      row.forEach((v, h) => { const k = v ? 1 + Math.min(5, Math.floor((v / max) * 5.999)) : 0; s += `<div class="in-cell s${k}" data-d="${d}" data-h="${h}" data-v="${v}"></div>`; });
    });
    s += `</div><div class="in-heat-key"><span>Fewer</span>${[1, 2, 3, 4, 5, 6].map((k) => `<i class="in-cell s${k}"></i>`).join("")}<span>More</span></div>`;
    el.innerHTML = s;
    el.querySelectorAll(".in-cell[data-v]").forEach((cell) => {
      cell.addEventListener("mousemove", (e) => {
        const h = +cell.dataset.h, lab = (x) => (x === 0 ? "12am" : x === 12 ? "12pm" : x < 12 ? x + "am" : x - 12 + "pm");
        tooltip(`<b>${days[+cell.dataset.d]} ${lab(h)}–${lab((h + 1) % 24)}</b><div>${cell.dataset.v} visit${cell.dataset.v === "1" ? "" : "s"}</div>`, e.clientX, e.clientY);
      });
      cell.addEventListener("mouseleave", () => tooltip(null));
    });
  }

  // ---------------------------------------------------------------- where: properties on a map, sized by visits
  let miniMap = null;
  function whereMap(el, c, opts) {
    const pts = c.props.filter((p) => p.centre);
    if (!pts.length || !window.maplibregl) { el.innerHTML = `<p class="in-empty">No published maps yet.</p>`; return; }
    if (miniMap) { miniMap.remove(); miniMap = null; }
    // the map library's helper runs from a file next to the page (the site's security rules allow nothing else)
    if (maplibregl.setWorkerUrl && !whereMap.worker) { maplibregl.setWorkerUrl(new URL("lib/maplibre-gl-csp-worker.js", document.baseURI).href); whereMap.worker = true; }
    el.innerHTML = "";
    const fc = { type: "FeatureCollection", features: pts.map((p) => ({ type: "Feature", properties: { id: p.f.id, name: p.f.name, visits: p.visits },
      geometry: { type: "Point", coordinates: p.centre } })) };
    const xs = pts.map((p) => p.centre[0]), ys = pts.map((p) => p.centre[1]);
    miniMap = new maplibregl.Map({ container: el, attributionControl: { compact: true },
      style: { version: 8, sources: { bm: { type: "raster", tileSize: 256, maxzoom: 18, attribution: "Map © Esri",
        tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}"] } },
        layers: [{ id: "bg", type: "background", paint: { "background-color": "#dfe5e1" } }, { id: "bm", type: "raster", source: "bm", paint: { "raster-saturation": -0.6, "raster-opacity": 0.85 } }] },
      bounds: [[Math.min(...xs) - 0.4, Math.min(...ys) - 0.3], [Math.max(...xs) + 0.4, Math.max(...ys) + 0.3]], fitBoundsOptions: { padding: 30, maxZoom: 9 } });
    miniMap.on("load", () => {
      const maxV = Math.max(1, ...pts.map((p) => p.visits));
      miniMap.addSource("p", { type: "geojson", data: fc });
      miniMap.addLayer({ id: "p", type: "circle", source: "p", paint: {
        "circle-radius": ["+", 6, ["*", 18, ["sqrt", ["/", ["get", "visits"], maxV]]]],
        "circle-color": ["case", [">", ["get", "visits"], 0], "#2a78d6", "#9aa5a0"], "circle-opacity": 0.85,
        "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 } });
      miniMap.on("mousemove", "p", (e) => { miniMap.getCanvas().style.cursor = "pointer"; const p = e.features[0].properties;
        tooltip(`<b>${esc(p.name)}</b><div>${p.visits} visit${p.visits === 1 ? "" : "s"} in ${RANGES.find((r) => r[0] === state.days)[1]}</div>`, e.originalEvent.clientX, e.originalEvent.clientY); });
      miniMap.on("mouseleave", "p", () => { miniMap.getCanvas().style.cursor = ""; tooltip(null); });
      miniMap.on("click", "p", (e) => { const f = c.props.find((p) => p.f.id === e.features[0].properties.id); if (f && opts.openMap) opts.openMap(f.f, null); });
    });
  }

  // ---------------------------------------------------------------- properties table
  function propsTable(el, c, opts) {
    const cols = [["name", "Property"], ["live", "Maps"], ["people", "People active"], ["visits", "Visits"], ["trend", "Last 12 weeks"], ["last", "Last visit"], ["open", "Suggestions"]];
    const key = { name: (p) => p.f.name.toLowerCase(), live: (p) => p.live, people: (p) => p.people.length ? p.activePeople / p.people.length : -1,
      visits: (p) => p.visits, trend: (p) => p.spark.slice(-4).reduce((a, b) => a + b, 0), last: (p) => p.last || 0, open: (p) => p.open };
    const rows = c.props.slice().sort((a, b) => { const ka = key[state.sort](a), kb = key[state.sort](b); return (ka < kb ? -1 : ka > kb ? 1 : 0) * state.dir; });
    let s = `<table class="in-table"><thead><tr>${cols.map(([k, l]) => `<th data-k="${k}" class="${k === state.sort ? "on" : ""}${["live", "visits", "open"].includes(k) ? " r" : ""}" aria-sort="${k === state.sort ? (state.dir > 0 ? "ascending" : "descending") : "none"}">${l}${k === state.sort ? (state.dir > 0 ? " ↑" : " ↓") : ""}</th>`).join("")}</tr></thead><tbody>`;
    rows.forEach((p) => {
      const share = p.people.length ? p.activePeople / p.people.length : 0;
      const quiet = p.live && !p.visits;
      s += `<tr data-f="${esc(p.f.id)}"><td><button type="button" class="in-link">${esc(p.f.name)}</button>${quiet ? ` <span class="in-chip warn">◔ Not opened</span>` : ""}</td>
        <td class="r">${p.live}${p.maps.length > p.live ? `<small> +${p.maps.length - p.live} off</small>` : ""}</td>
        <td><div class="in-meter" title="${p.activePeople} of ${p.people.length}"><i style="width:${(share * 100).toFixed(0)}%"></i></div><small>${p.activePeople} of ${p.people.length}</small></td>
        <td class="r"><b>${p.visits}</b></td><td>${sparkSvg(p.spark, 90, 22)}</td>
        <td>${p.last ? esc(ago(p.last, c.now)) : "<small>never</small>"}</td>
        <td class="r">${p.open ? `<span class="in-chip info">${p.open} open</span>` : ""}</td></tr>`;
    });
    el.innerHTML = s + "</tbody></table>";
    el.querySelectorAll("th").forEach((th) => th.addEventListener("click", () => {
      const k = th.dataset.k; if (state.sort === k) state.dir *= -1; else { state.sort = k; state.dir = k === "name" ? 1 : -1; }
      propsTable(el, c, opts);
    }));
    el.querySelectorAll("tbody .in-link").forEach((b) => b.addEventListener("click", () => {
      const p = c.props.find((x) => x.f.id === b.closest("tr").dataset.f); if (p && opts.openMap) opts.openMap(p.f, null);
    }));
  }

  // ---------------------------------------------------------------- the page
  function render(root, data, opts) {
    opts = opts || {};
    const c = crunch(data);
    const range = RANGES.find((r) => r[0] === state.days)[1];
    const phoneShare = c.cur.length ? c.phone / c.cur.length : 0;
    root.innerHTML = `
      <div class="in-head"><div><h1>Portal insights</h1><p class="in-subtitle">How customers are using their maps</p></div>
        <div class="in-filters"><div class="ib-seg" role="group" aria-label="Period">${RANGES.map(([d, l]) => `<button type="button" data-d="${d}" aria-pressed="${d === state.days}">${l}</button>`).join("")}</div>
          <label class="in-toggle"><input type="checkbox" id="in-staff" ${state.staff ? "checked" : ""}> Include RCL staff</label></div></div>
      <div class="in-tiles">
        ${tile("Map visits", num(c.cur.length), delta(c.cur.length, c.prev.length), sparkSvg(c.visitSpark), "hero")}
        ${tile("Customers active", `${c.active.size}<small> of ${c.customers.length}</small>`, `opened a map in the last ${range}`, `<div class="in-meter big"><i style="width:${c.customers.length ? (c.active.size / c.customers.length * 100).toFixed(0) : 0}%"></i></div>`)}
        ${tile("Properties live", c.liveFarms.size, `${c.liveMaps.length} map${c.liveMaps.length === 1 ? "" : "s"} online${c.offline ? `, ${c.offline} offline` : ""}`)}
        ${tile("On a phone", c.cur.length ? pct(phoneShare) : "–", "of visits", `<div class="in-split"><i class="c" style="width:${(100 - phoneShare * 100).toFixed(0)}%"></i><i class="p" style="width:${(phoneShare * 100).toFixed(0)}%"></i></div>`)}
        ${tile("Not signed in yet", c.neverIn.length, c.neverIn.length ? "people given access" : "everyone has signed in", "", c.neverIn.length ? "warn" : "")}
        ${tile("Open suggestions", c.openSugg, c.newSugg ? `${c.newSugg} new · <button type="button" class="in-link" id="in-inbox">Open the inbox</button>` : "nothing new", "")}
      </div>
      <section class="in-card"><div class="in-card-head"><h2>Map visits</h2><div class="in-legend"><span><i class="in-key c"></i>Computer</span><span><i class="in-key p"></i>Phone</span></div></div>
        <div id="in-visits" class="in-chart"></div>${c.cur.length ? "" : `<p class="in-empty">No visits in the last ${range}.</p>`}</section>
      <div class="in-two">
        <section class="in-card"><div class="in-card-head"><h2>When customers look</h2><small>your local time</small></div><div id="in-heat"></div></section>
        <section class="in-card"><div class="in-card-head"><h2>Where</h2><small>circle size = visits in the last ${range}</small></div><div id="in-where" class="in-where"></div></section>
      </div>
      <section class="in-card"><div class="in-card-head"><h2>Properties</h2><small>click a column to sort, a name to open its maps</small></div><div id="in-props" class="in-scroll"></div></section>
      <div class="in-two">
        <section class="in-card"><div class="in-card-head"><h2>Worth a nudge</h2>${c.follow.length ? `<button type="button" class="in-link" id="in-copy">Copy emails</button>` : ""}</div>
          ${c.follow.length ? `<ul class="in-list">${c.follow.slice(0, 12).map((x) => `<li><span class="in-avatar">${esc((x.p.email || "?")[0].toUpperCase())}</span><div><b>${esc(x.p.email)}</b><small>${esc(x.f ? x.f.name : "")} · ${esc(x.why)} · ${esc(ago(x.since, c.now))}</small></div></li>`).join("")}</ul>${c.follow.length > 12 ? `<p class="in-more">and ${c.follow.length - 12} more</p>` : ""}`
            : `<p class="in-empty">Everyone with access has been using their maps.</p>`}</section>
        <section class="in-card"><div class="in-card-head"><h2>Recent activity</h2></div>
          ${c.recent.length ? `<ul class="in-list">${c.recent.map((v) => `<li><span class="in-avatar">${esc(v.email[0].toUpperCase())}</span><div><b>${esc(v.email)}</b> opened <b>${esc(v.farm ? v.farm.name : "a property")}</b>${v.map ? " · " + esc(v.map.title) : ""}<small>on a ${v.dev === "phone" ? "phone" : "computer"} · ${esc(ago(v.t, c.now))}</small></div></li>`).join("")}</ul>`
            : `<p class="in-empty">No visits yet.</p>`}</section>
      </div>
      <p class="in-foot">Visits count each time a map is opened; reopening within 30 minutes counts once. ${state.staff ? "Including" : "Not including"} RCL staff. Updated ${new Date(c.now).toLocaleString("en-NZ", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}.</p>`;
    visitsChart(root.querySelector("#in-visits"), c);
    heatmap(root.querySelector("#in-heat"), c);
    whereMap(root.querySelector("#in-where"), c, opts);
    propsTable(root.querySelector("#in-props"), c, opts);
    root.querySelectorAll("[data-d]").forEach((b) => b.addEventListener("click", () => { state.days = +b.dataset.d; render(root, data, opts); }));
    root.querySelector("#in-staff").addEventListener("change", (e) => { state.staff = e.target.checked; render(root, data, opts); });
    const ib = root.querySelector("#in-inbox"); if (ib && opts.openInbox) ib.addEventListener("click", opts.openInbox);
    const cp = root.querySelector("#in-copy");
    if (cp) cp.addEventListener("click", () => {
      const emails = [...new Set(c.follow.map((x) => x.p.email))].join("; ");
      (navigator.clipboard ? navigator.clipboard.writeText(emails) : Promise.reject()).then(() => { cp.textContent = "Copied"; }, () => { window.prompt("Emails", emails); });
    });
    // charts follow the page width
    clearTimeout(render.rz);
    window.onresize = () => { clearTimeout(render.rz); render.rz = setTimeout(() => { const el = root.querySelector("#in-visits"); if (el) visitsChart(el, c); }, 150); };
  }

  window.RCLInsights = { render };
})();
