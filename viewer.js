/* RCL farm map viewer.
 * RCLViewer.mount(element, {
 *   manifest, url: relPath => absoluteUrl, onBack?, actions?: [{ label, onClick }],
 *   suggest?: { list: async () => [suggestion], submit: async (draft) => void,      // portal only
 *              focus?: suggestionId, manage?: (suggestion) => void }                // staff: open in the inbox
 * })
 * Works for the local preview (url = identity) and the customer portal (url = signed link).
 */
(function () {
  "use strict";
  const BASEMAPS = {
    aerial: {
      label: "Aerial",
      tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
      attribution: "Imagery © Esri", maxzoom: 19,
    },
    map: {
      label: "Map",
      tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}"],
      attribution: "Map © Esri", maxzoom: 19,
    },
    none: { label: "None" },
  };
  const STATUS = {
    new: { label: "Received", color: "#e8590c" },
    in_progress: { label: "Being looked at", color: "#1c7ed6" },
    done: { label: "Done", color: "#2f9e44" },
    not_changed: { label: "Not changed", color: "#868e96" },
  };
  let protocolAdded = false;

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const el = (tag, attrs = {}, html = "") => { const e = document.createElement(tag); Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v)); if (html) e.innerHTML = html; return e; };
  const fmtDate = (d) => { if (!d) return ""; const t = new Date(d); return isNaN(t) ? d : t.toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" }); };
  const narrow = () => window.matchMedia("(max-width: 720px)").matches;

  function storeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function storeSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }

  function classLabel(layer, props) {
    if (!layer.classes || props._cls == null) return null;
    const c = layer.classes;
    if (c.kind === "categories") return c.values[props._cls] ? c.values[props._cls][1] : null;
    return c.ranges[props._cls] ? c.ranges[props._cls][2] : null;
  }

  // ---- drawn symbols for photo-style point layers: a dot plus a cone showing which way the camera faced
  function rgba(hex, a) {
    const h = (hex || "#e8590c").replace("#", "");
    const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h.slice(0, 6), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  function coneCanvas(color, px) {
    const s = px, c = document.createElement("canvas"); c.width = c.height = s;
    const g = c.getContext("2d"), cx = s / 2, cy = s / 2, r = s * 0.47, half = (26 * Math.PI) / 180;
    g.beginPath(); g.moveTo(cx, cy); g.arc(cx, cy, r, -Math.PI / 2 - half, -Math.PI / 2 + half); g.closePath();
    const grad = g.createRadialGradient(cx, cy, 2, cx, cy, r);
    grad.addColorStop(0, rgba(color, 0.85)); grad.addColorStop(1, rgba(color, 0.2));
    g.fillStyle = grad; g.fill();
    g.lineWidth = s / 48; g.strokeStyle = "rgba(255,255,255,0.95)"; g.stroke();
    return c;
  }
  function legendIcon(color, withCone) {
    const c = document.createElement("canvas"); c.width = c.height = 40;
    const g = c.getContext("2d");
    if (withCone) { g.save(); g.translate(20, 26); g.drawImage(coneCanvas(color, 52), -26, -26); g.restore(); }
    g.beginPath(); g.arc(20, 26, 6, 0, Math.PI * 2); g.fillStyle = color; g.fill();
    g.lineWidth = 2.5; g.strokeStyle = "#fff"; g.stroke();
    return c.toDataURL("image/png");
  }
  function colorExpr(colors) {
    if (!colors || !colors.length) return "#e8590c";
    if (colors.length === 1) return colors[0];
    const e = ["match", ["coalesce", ["get", "_cls"], -1]];
    colors.forEach((c, i) => e.push(i, c));
    e.push(colors[0]);
    return e;
  }

  // ---- labels written by the web map: crisp text, placed in the visible part of each area ------------------------
  // pole of inaccessibility (the point inside a polygon furthest from its edges), after Mapbox's polylabel (ISC)
  function polylabel(poly, precision, maxSteps) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    poly[0].forEach(([x, y]) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); });
    const w = maxX - minX, h = maxY - minY, size = Math.min(w, h);
    if (!(size > precision)) return null;
    const segD = (px, py, a, b) => {
      let x = a[0], y = a[1], dx = b[0] - x, dy = b[1] - y;
      if (dx || dy) { const t = ((px - x) * dx + (py - y) * dy) / (dx * dx + dy * dy); if (t > 1) { x = b[0]; y = b[1]; } else if (t > 0) { x += dx * t; y += dy * t; } }
      dx = px - x; dy = py - y; return dx * dx + dy * dy;
    };
    const dist = (x, y) => {
      let inside = false, m = Infinity;
      poly.forEach((ring) => {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const a = ring[i], b = ring[j];
          if ((a[1] > y) !== (b[1] > y) && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
          m = Math.min(m, segD(x, y, a, b));
        }
      });
      return (inside ? 1 : -1) * Math.sqrt(m);
    };
    const cell = (x, y, hh) => { const d = dist(x, y); return { x, y, h: hh, d, max: d + hh * Math.SQRT2 }; };
    let best = cell(minX + w / 2, minY + h / 2, 0);
    const queue = [];
    for (let x = minX; x < maxX; x += size) for (let y = minY; y < maxY; y += size) queue.push(cell(x + size / 2, y + size / 2, size / 2));
    for (let n = 0; queue.length && n < (maxSteps || 400); n++) {
      queue.sort((a, b) => a.max - b.max);
      const c = queue.pop();
      if (c.d > best.d) best = c;
      if (c.max - best.d <= precision) continue;
      const hh = c.h / 2;
      queue.push(cell(c.x - hh, c.y - hh, hh), cell(c.x + hh, c.y - hh, hh), cell(c.x - hh, c.y + hh, hh), cell(c.x + hh, c.y + hh, hh));
    }
    return best;
  }
  // clip a ring to a rectangle (Sutherland-Hodgman)
  function clipRing(ring, x0, y0, x1, y1) {
    const edges = [[(p) => p[0] >= x0, (a, b) => [x0, a[1] + ((b[1] - a[1]) * (x0 - a[0])) / (b[0] - a[0])]],
                   [(p) => p[0] <= x1, (a, b) => [x1, a[1] + ((b[1] - a[1]) * (x1 - a[0])) / (b[0] - a[0])]],
                   [(p) => p[1] >= y0, (a, b) => [a[0] + ((b[0] - a[0]) * (y0 - a[1])) / (b[1] - a[1]), y0]],
                   [(p) => p[1] <= y1, (a, b) => [a[0] + ((b[0] - a[0]) * (y1 - a[1])) / (b[1] - a[1]), y1]]];
    let out = ring;
    for (const [ins, cut] of edges) {
      const inp = out; out = [];
      if (!inp.length) break;
      for (let i = 0; i < inp.length; i++) {
        const cur = inp[i], prev = inp[(i + inp.length - 1) % inp.length];
        if (ins(cur)) { if (!ins(prev)) out.push(cut(prev, cur)); out.push(cur); } else if (ins(prev)) out.push(cut(prev, cur));
      }
    }
    return out;
  }
  const ringArea = (r) => Math.abs(r.reduce((s, p, i) => { const q = r[(i + 1) % r.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0) / 2);

  // a polygon covering the world with holes where the property is (and the property's own holes shaded too)
  function maskOf(fc) {
    const area = (r) => r.reduce((s, p, i) => { const q = r[(i + 1) % r.length]; return s + (p[0] * q[1] - q[0] * p[1]); }, 0) / 2;
    const ccw = (r) => (area(r) > 0 ? r : r.slice().reverse());
    const cw = (r) => (area(r) < 0 ? r : r.slice().reverse());
    const polys = [];
    (fc.features || []).forEach((f) => {
      const g = f.geometry || {};
      if (g.type === "Polygon") polys.push(g.coordinates);
      if (g.type === "MultiPolygon") g.coordinates.forEach((p) => polys.push(p));
    });
    const world = ccw([[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]]);
    const feats = [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [world, ...polys.map((p) => cw(p[0]))] } }];
    polys.forEach((p) => p.slice(1).forEach((hole) => feats.push({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ccw(hole)] } })));
    return { type: "FeatureCollection", features: feats };
  }

  function mount(root, opts) {
    const m = opts.manifest;
    const url = opts.url || ((p) => p);
    const suggest = opts.suggest || null;
    root.classList.add("rv-root");
    root.innerHTML = "";
    const mapEl = el("div", { class: "rv-map" });
    root.appendChild(mapEl);

    if (!protocolAdded) {
      // CSP-safe build: the map worker is a normal file next to the page, not a blob
      if (maplibregl.setWorkerUrl) maplibregl.setWorkerUrl(new URL("lib/maplibre-gl-csp-worker.js", document.baseURI).href);
      const protocol = new pmtiles.Protocol();
      maplibregl.addProtocol("pmtiles", protocol.tile);
      protocolAdded = true;
    }

    const bm = storeGet("rv-basemap") || "aerial";
    const style = { version: 8, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": "#dfe5e1" } }] };
    ["aerial", "map"].forEach((k) => {
      style.sources["bm-" + k] = { type: "raster", tiles: BASEMAPS[k].tiles, tileSize: 256, maxzoom: BASEMAPS[k].maxzoom, attribution: BASEMAPS[k].attribution };
      style.layers.push({ id: "bm-" + k, type: "raster", source: "bm-" + k, layout: { visibility: k === bm ? "visible" : "none" } });
    });

    const pad = () => (narrow() ? { top: 60, bottom: 130, left: 30, right: 30 } : { top: 50, bottom: 50, left: 380, right: 60 });
    const map = new maplibregl.Map({
      container: mapEl, style, bounds: m.bounds, fitBoundsOptions: { padding: pad() }, maxZoom: 22, maxPitch: 75,
      attributionControl: { compact: true, customAttribution: "Rural Consulting Limited" },
    });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
    map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");
    map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: false }), "top-right");

    // ---------------------------------------------------------------- 3D: hills in relief, off until asked for
    // Elevation is only downloaded while 3D is on. Default: free terrain tiles (in NZ made from the LINZ 8 m DEM);
    // the portal passes LINZ Basemaps elevation (LiDAR where flown) when it has a LINZ key.
    let threeD = false;
    const fillOpacity = {};
    const terrainSrc = () => Object.assign({ type: "raster-dem", tileSize: 256, maxzoom: 15 },
      opts.terrain || RCLViewer.terrain || {
        tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"], encoding: "terrarium",
        attribution: "Elevation: Mapzen terrain tiles (LINZ 8 m DEM)" });
    function setThreeD(on) {
      threeD = on;
      btn3d.setAttribute("aria-pressed", String(on));
      if (on) {
        if (!map.getSource("dem")) {
          map.addSource("dem", terrainSrc());
          map.addSource("dem-shade", terrainSrc());          // a separate copy for shading, as MapLibre recommends
          // relief shading ON TOP of the property's layers (under the boundary), so coloured maps like LUC show
          // the shape of the land instead of looking like flat paint
          map.addLayer({ id: "hillshade", type: "hillshade", source: "dem-shade",
            paint: { "hillshade-exaggeration": 0.6, "hillshade-shadow-color": "rgba(0,0,0,0.55)",
                     "hillshade-highlight-color": "rgba(255,255,255,0.22)", "hillshade-accent-color": "rgba(0,0,0,0.25)" } },
            map.getLayer("boundary-halo") ? "boundary-halo" : undefined);
        }
        map.setLayoutProperty("hillshade", "visibility", "visible");
        // let the aerial show a little through solid fills while in 3D (put back when 3D goes off)
        map.getStyle().layers.filter((l) => l.type === "fill" && l.id.startsWith("v-")).forEach((l) => {
          if (!(l.id in fillOpacity)) fillOpacity[l.id] = map.getPaintProperty(l.id, "fill-opacity") ?? 1;
          map.setPaintProperty(l.id, "fill-opacity", ["*", 0.82, fillOpacity[l.id]]);
        });
        map.setTerrain({ source: "dem", exaggeration: 1.4 });
        map.once("idle", () => typeof placeLabels === "function" && placeLabels());
        map.easeTo({ pitch: 62, bearing: map.getBearing() || -20, duration: 900 });
      } else {
        map.setTerrain(null);
        if (map.getLayer("hillshade")) map.setLayoutProperty("hillshade", "visibility", "none");
        Object.entries(fillOpacity).forEach(([id, v]) => map.getLayer(id) && map.setPaintProperty(id, "fill-opacity", v));
        map.easeTo({ pitch: 0, bearing: 0, duration: 600 });
      }
      storeSet("rv-3d", on ? "1" : "");
    }
    const ctl3d = el("div", { class: "maplibregl-ctrl maplibregl-ctrl-group rv-3d" });
    const btn3d = el("button", { type: "button", "aria-pressed": "false", title: "Show the hills in 3D (drag with the right mouse button, or two fingers, to tilt and turn)" }, "3D");
    ctl3d.appendChild(btn3d);
    map.addControl({ onAdd: () => ctl3d, onRemove: () => ctl3d.remove() }, "top-right");
    btn3d.addEventListener("click", () => setThreeD(!threeD));

    const layers = m.layers.map((L) => Object.assign({}, L));   // top first, as in QGIS
    // "one at a time" groups (mutually exclusive in QGIS): only the top one that starts on stays on
    const exOn = {};
    layers.forEach((L) => { if (L.exclusive && L.visible) { if (exOn[L.group]) L.visible = false; else exOn[L.group] = true; } });
    const hitIds = [];
    const coneIds = [];                            // photo cones are clickable too: a cone picks the photo facing that way
    const mapIds = {};                             // web layer id -> map layer ids (for the on/off switch)
    const own = (L, id) => { (mapIds[L.id] = mapIds[L.id] || []).push(id); return id; };
    let suggestions = [];
    let maskOn = true;

    // add the property's layers as soon as the map's style is ready, without waiting for the background imagery
    let started = false;
    const setup = () => {
      if (started) return;
      started = true;
      // bottom to top
      layers.slice().reverse().forEach((L) => {
        if (L.vector && L.features) return addVector(L);
        if (!L.tiles) return;
        const from = L.visible_from || L.minzoom || 0;
        map.addSource("t-" + L.id, { type: "raster", url: "pmtiles://" + url(L.tiles), tileSize: 256, minzoom: from });
        map.addLayer({ id: own(L, "t-" + L.id), type: "raster", source: "t-" + L.id, minzoom: Math.max(0, from - 0.5),
          paint: { "raster-opacity": L.opacity ?? 1, "raster-fade-duration": 0, "raster-resampling": "linear" },
          layout: { visibility: L.visible ? "visible" : "none" } });
      });
      map.addSource("boundary", { type: "geojson", data: url(m.boundary) });
      map.addLayer({ id: "boundary-halo", type: "line", source: "boundary", paint: { "line-color": "#0b1612", "line-width": 5, "line-opacity": 0.45 } });
      map.addLayer({ id: "boundary", type: "line", source: "boundary", paint: { "line-color": "#ffffff", "line-width": 2, "line-dasharray": [3, 2] } });
      if (m.mask) {
        // shade the land outside the property: the whole world with the property cut out of it
        fetch(url(m.boundary)).then((r) => r.json()).then((fc) => {
          map.addSource("mask", { type: "geojson", data: maskOf(fc) });
          map.addLayer({ id: "mask", type: "fill", source: "mask", layout: { visibility: maskOn ? "visible" : "none" },
            paint: { "fill-color": m.mask.color || "#000000", "fill-opacity": Number(m.mask.opacity) || 0.5, "fill-antialias": false } },
          "boundary-halo");
        }).catch(() => {});
      }

      // the selected feature
      map.addSource("sel", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({ id: "sel-fill", type: "fill", source: "sel", filter: ["==", ["geometry-type"], "Polygon"], paint: { "fill-color": "#ffd43b", "fill-opacity": 0.18 } });
      map.addLayer({ id: "sel-line", type: "line", source: "sel", filter: ["!=", ["geometry-type"], "Point"], paint: { "line-color": "#ffd43b", "line-width": 4 } });

      // layers the web map draws itself (photo dots with direction cones), then click targets
      layers.slice().reverse().forEach((L) => {
        if (!L.features) return;
        if (!map.getSource("f-" + L.id)) map.addSource("f-" + L.id, { type: "geojson", data: url(L.features) });
        const vis = L.visible ? "visible" : "none";
        if (L.draw) {
          const k = (L.draw.size || 1.5) / 1.5;
          const colors = L.draw.colors && L.draw.colors.length ? L.draw.colors : ["#e8590c"];
          if (L.draw.type === "direction") {
            colors.forEach((c, i) => map.addImage(`cone-${L.id}-${i}`, coneCanvas(c, 128).getContext("2d").getImageData(0, 0, 128, 128), { pixelRatio: 2 }));
            coneIds.push("d-" + L.id + "-cone");
            map.addLayer({ id: own(L, "d-" + L.id + "-cone"), type: "symbol", source: "f-" + L.id, filter: ["has", "_dir"],
              layout: { visibility: vis, "icon-image": colors.length > 1 ? ["concat", `cone-${L.id}-`, ["to-string", ["coalesce", ["get", "_cls"], 0]]] : `cone-${L.id}-0`,
                "icon-rotate": ["get", "_dir"], "icon-rotation-alignment": "map", "icon-allow-overlap": true, "icon-ignore-placement": true,
                "icon-size": ["interpolate", ["linear"], ["zoom"], 13, 0.45 * k, 17, 0.8 * k, 20, 1.15 * k] } });
          }
          map.addLayer({ id: own(L, "d-" + L.id + "-dot"), type: "circle", source: "f-" + L.id,
            layout: { visibility: vis },
            paint: { "circle-color": colorExpr(colors), "circle-stroke-color": "#fff", "circle-stroke-width": 2,
              "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, 3 * k, 17, 5.5 * k, 20, 7.5 * k] } });
        }
        if (L.clickable === false) return;                 // features only there for the labels
        const id = own(L, "hit-" + L.id);
        const minzoom = Math.max(0, (L.visible_from || 0) - 0.5);
        if (L.geometry === "point") map.addLayer({ id, minzoom, type: "circle", source: "f-" + L.id, paint: { "circle-radius": 14, "circle-opacity": 0 }, layout: { visibility: vis } });
        else if (L.geometry === "line") map.addLayer({ id, minzoom, type: "line", source: "f-" + L.id, paint: { "line-width": 16, "line-opacity": 0 }, layout: { visibility: vis } });
        else map.addLayer({ id, minzoom, type: "fill", source: "f-" + L.id, paint: { "fill-opacity": 0 }, layout: { visibility: vis } });
        hitIds.push(id);
      });
      map.addLayer({ id: "sel-point", type: "circle", source: "sel", filter: ["==", ["geometry-type"], "Point"],
        paint: { "circle-radius": 13, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": "#ffd43b", "circle-stroke-width": 3 } });
      // points on top of lines on top of areas for picking
      hitIds.sort((a, b) => rank(a) - rank(b)).forEach((id) => map.moveLayer(id));

      if (suggest) {
        map.addSource("sugg", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        map.addLayer({ id: "sugg-halo", type: "circle", source: "sugg", paint: { "circle-radius": 13, "circle-color": "#fff", "circle-opacity": 0.85 } });
        map.addLayer({ id: "sugg", type: "circle", source: "sugg",
          paint: { "circle-radius": 9, "circle-color": ["match", ["get", "status"], "in_progress", STATUS.in_progress.color, "done", STATUS.done.color, "not_changed", STATUS.not_changed.color, STATUS.new.color],
            "circle-stroke-color": "#fff", "circle-stroke-width": 2 } });
        map.addLayer({ id: "sugg-core", type: "circle", source: "sugg", paint: { "circle-radius": 3, "circle-color": "#fff" } });
        loadSuggestions();
      }

      map.on("mousemove", (e) => {
        if (picking) { map.getCanvas().style.cursor = "crosshair"; return; }
        const f = map.queryRenderedFeatures(box(e.point, 6), { layers: targetIds() });
        map.getCanvas().style.cursor = f.length ? "pointer" : "";
      });
      map.on("click", (e) => {
        if (picking) return pickAt(e);
        const f = map.queryRenderedFeatures(box(e.point, 8), { layers: targetIds() });
        if (!f.length) { clearSelection(); closeSheet(); return; }
        const s = f.find((x) => x.layer.id === "sugg");
        if (s) return showSuggestion(s);
        const list = stack(f, e.point);
        if (list.length) showFeature(list, 0, e.lngLat);
      });
    };
    if (map.isStyleLoaded()) setup(); else { map.once("style.load", setup); map.once("load", setup); }
    map.once("load", () => { if (storeGet("rv-3d") === "1") setThreeD(true); });   // remembered on this device

    // layers the web map draws itself from their QGIS style (see vectorstyle.py): fills, outlines, lines, circles
    function addVector(L) {
      map.addSource("f-" + L.id, { type: "geojson", data: url(L.features), tolerance: 0.25 });
      const lat = (m.bounds[1] + m.bounds[3]) / 2, mpp0 = 156543.03392 * Math.cos((lat * Math.PI) / 180);
      const vis = L.visible ? "visible" : "none";
      const cls = ["to-string", ["coalesce", ["get", "_cls"], -1]];
      const pick = (by, keys, prop, fallback, scale) => {
        const val = (k) => { const v = by[k][prop]; if (v == null) return fallback; return typeof v === "object" ? (v.m / mpp0) * scale : v; };
        if (keys.length === 1 && keys[0] === "*") return val("*");
        const e = ["match", cls]; keys.forEach((k) => e.push(k, val(k))); e.push(fallback); return e;
      };
      // sizes: plain pixels, or metres (map units) that grow with the zoom
      const size = (by, keys, prop) => {
        const metres = keys.some((k) => by[k][prop] && typeof by[k][prop] === "object");
        if (!metres) return pick(by, keys, prop, 0, 1);
        return ["interpolate", ["exponential", 2], ["zoom"], 0, pick(by, keys, prop, 0, 1), 24, pick(by, keys, prop, 0, 2 ** 24)];
      };
      L.vector.layers.forEach((v, j) => {
        // dashes can't vary by class in one map layer, so one layer per dash pattern
        const groups = {};
        Object.keys(v.by).forEach((k) => { const d = JSON.stringify(v.type === "line" ? v.by[k].dash || null : null); (groups[d] = groups[d] || []).push(k); });
        Object.entries(groups).forEach(([dash, keys], g) => {
          const id = own(L, `v-${L.id}-${j}-${g}`);
          const def = { id, source: "f-" + L.id, layout: { visibility: vis }, minzoom: Math.max(0, (L.visible_from || 0) - 0.5) };
          if (L.visible_to) def.maxzoom = L.visible_to;
          if (!(keys.length === 1 && keys[0] === "*")) def.filter = ["in", cls, ["literal", keys]];
          if (v.type === "fill") {
            Object.assign(def, { type: "fill", paint: { "fill-color": pick(v.by, keys, "color", "#000"), "fill-opacity": pick(v.by, keys, "opacity", 1, 1) } });
          } else if (v.type === "line") {
            Object.assign(def, { type: "line", layout: { ...def.layout, "line-join": "round", "line-cap": "round" },
              paint: { "line-color": pick(v.by, keys, "color", "#000"), "line-opacity": pick(v.by, keys, "opacity", 1, 1), "line-width": size(v.by, keys, "width") } });
            const d = JSON.parse(dash);
            if (d) { def.paint["line-dasharray"] = d; def.layout["line-cap"] = "butt"; }
          } else {
            Object.assign(def, { type: "circle", paint: { "circle-color": pick(v.by, keys, "color", "#000"), "circle-opacity": pick(v.by, keys, "opacity", 1, 1),
              "circle-radius": size(v.by, keys, "radius"), "circle-stroke-color": pick(v.by, keys, "stroke", "#000"),
              "circle-stroke-width": pick(v.by, keys, "stroke_width", 0, 1), "circle-stroke-opacity": pick(v.by, keys, "stroke_opacity", 1, 1) } });
          }
          map.addLayer(def);
        });
      });
    }

    const targetIds = () => (map.getLayer("sugg") && suggOn ? ["sugg"] : []).concat(coneIds, hitIds);
    function rank(id) { const L = layers.find((l) => "hit-" + l.id === id); return L ? ({ point: 3, line: 2, polygon: 1 }[L.geometry] || 0) : 0; }
    function box(p, r) { return [[p.x - r, p.y - r], [p.x + r, p.y + r]]; }
    const layerOf = (feat) => layers.find((l) => "hit-" + l.id === feat.layer.id || "d-" + l.id + "-cone" === feat.layer.id);
    const rankOf = (feat) => { const L = layerOf(feat); return L ? ({ point: 3, line: 2, polygon: 1 }[L.geometry] || 0) : 0; };

    // Everything under a click, one entry per feature: points before lines before areas. Where photos sit on top of
    // each other, a click on one of their cones puts the photo facing that way first.
    function stack(hits, pt) {
      const seen = new Set(), list = [];
      hits.forEach((h) => {
        const L = layerOf(h);
        if (!L) return;
        const k = L.id + ":" + (h.id ?? JSON.stringify(h.properties));
        if (!seen.has(k)) { seen.add(k); list.push(h); }
      });
      const coneScore = (h) => {
        const d = h.properties._dir;
        if (d == null || h.geometry.type !== "Point") return 90;
        const p = map.project(h.geometry.coordinates), dx = pt.x - p.x, dy = pt.y - p.y;
        if (Math.hypot(dx, dy) < 7) return 90;                       // on the dot itself: no direction to go by
        const bearing = (Math.atan2(dx, -dy) * 180 / Math.PI + map.getBearing() + 360) % 360;
        const diff = Math.abs(((Number(d) - bearing) % 360 + 540) % 360 - 180);
        return Math.min(diff, 90);
      };
      const order = list.map((h, i) => ({ h, i, r: rankOf(h), c: coneScore(h) }));
      order.sort((a, b) => b.r - a.r || a.c - b.c || a.i - b.i);
      return order.map((o) => o.h);
    }

    // ---------------------------------------------------------------- details (popup on desktop, sheet on phones)
    let popup = null;
    function select(feat) {
      map.getSource("sel") && map.getSource("sel").setData({ type: "FeatureCollection", features: feat ? [{ type: "Feature", properties: {}, geometry: feat.geometry }] : [] });
    }
    function clearSelection() { select(null); if (popup) { popup.remove(); popup = null; } }

    function featureHtml(L, p, pager) {
      const cls = classLabel(L, p);
      const icon = L.draw ? `<img alt="" src="${legendIcon((L.draw.colors || [])[p._cls || 0] || "#e8590c", L.draw.type === "direction")}">`
        : p._cls != null && L.legend[p._cls] ? `<img alt="" src="${esc(url(L.legend[p._cls].icon))}">` : "";
      const title = p._label || cls || L.title;
      const rows = (L.fields || []).filter((f) => p[f.name] !== undefined && p[f.name] !== null && p[f.name] !== "");
      let html = `<div class="rv-pop">${pager || ""}<div class="rv-pop-kicker">${icon}<span>${esc(L.title)}${cls && cls !== title ? " · " + esc(cls) : ""}</span></div>`;
      html += `<div class="rv-pop-title">${esc(title)}</div>`;
      if (p._thumb) html += `<img class="rv-pop-photo" alt="Photo, tap to enlarge" src="${esc(url(p._thumb))}" data-full="${esc(url(p._photo))}">`;
      if (p._dir != null) html += `<div class="rv-pop-dir"><span class="rv-arrow" style="transform:rotate(${Number(p._dir)}deg)">↑</span>Looking ${compass(p._dir)} (${Math.round(p._dir)}°)</div>`;
      if (rows.length) {
        html += "<dl>" + rows.map((f) => {
          let v = p[f.name];
          if (L.classes && L.classes.field === f.name && cls) v = cls;
          return `<dt>${esc(f.alias || f.name)}</dt><dd>${esc(v)}</dd>`;
        }).join("") + "</dl>";
      }
      if (suggest) html += `<button type="button" class="rv-link rv-suggest-this">Suggest a change to this</button>`;
      return html + "</div>";
    }
    function compass(d) { return ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"][Math.round(((Number(d) % 360) + 360) % 360 / 45) % 8]; }

    function wire(container, ctx) {
      container.querySelectorAll(".rv-pop-photo, .rv-thumb").forEach((img) => img.addEventListener("click", () => lightbox(img.dataset.full)));
      const s = container.querySelector(".rv-suggest-this");
      if (s && ctx) s.addEventListener("click", () => { clearSelection(); closeSheet(); openForm(ctx); });
      if (ctx && ctx.page) {
        const prev = container.querySelector(".rv-prev"), next = container.querySelector(".rv-next");
        if (prev) prev.addEventListener("click", () => ctx.page(-1));
        if (next) next.addEventListener("click", () => ctx.page(1));
      }
    }

    // list: the features under the click (see stack); i: which one to show. Several: "1 of 3 here" with ‹ ›.
    function showFeature(list, i, lngLat) {
      const n = list.length, feat = list[i];
      const L = layerOf(feat);
      const pager = n > 1 ? `<div class="rv-pager"><button type="button" class="rv-prev" aria-label="Previous">‹</button>`
        + `<span>${i + 1} of ${n} here</span><button type="button" class="rv-next" aria-label="Next">›</button></div>` : "";
      const html = featureHtml(L, feat.properties, pager);
      const ctx = { lngLat: feat.geometry.type === "Point" ? { lng: feat.geometry.coordinates[0], lat: feat.geometry.coordinates[1] } : lngLat,
        layer_id: L.id, layer_title: L.title, feature_id: String(feat.id ?? ""), feature_label: feat.properties._label || classLabel(L, feat.properties) || "" };
      if (n > 1) ctx.page = (step) => showFeature(list, (i + step + n) % n, lngLat);
      select(feat);
      showDetails(html, lngLat, ctx);
    }
    function showDetails(html, lngLat, ctx) {
      if (popup) { popup.remove(); popup = null; }
      if (narrow()) {
        const body = openSheet(html);
        wire(body, ctx);
      } else {
        closeSheet();
        popup = new maplibregl.Popup({ maxWidth: "340px", offset: 12 }).setLngLat(lngLat).setHTML(html).addTo(map);
        popup.on("close", () => { select(null); popup = null; });
        wire(popup.getElement(), ctx);
        // keep the whole popup on screen (photos make it tall)
        const fitPopup = () => {
          if (!popup) return;
          const r = popup.getElement().getBoundingClientRect(), c = map.getContainer().getBoundingClientRect();
          const dy = r.top < c.top + 10 ? r.top - c.top - 10 : r.bottom > c.bottom - 10 ? r.bottom - c.bottom + 10 : 0;
          const dx = r.left < c.left + 370 ? r.left - c.left - 370 : r.right > c.right - 60 ? r.right - c.right + 60 : 0;
          if (dx || dy) map.panBy([dx, dy], { duration: 250 });
        };
        const img = popup.getElement().querySelector("img.rv-pop-photo");
        if (img && !img.complete) img.addEventListener("load", fitPopup, { once: true });
        requestAnimationFrame(fitPopup);
      }
    }

    const sheet = el("section", { class: "rv-sheet", role: "dialog", "aria-label": "Details", hidden: "" });
    sheet.innerHTML = `<button type="button" class="rv-sheet-close" aria-label="Close">×</button><div class="rv-sheet-body"></div>`;
    root.appendChild(sheet);
    sheet.querySelector(".rv-sheet-close").addEventListener("click", () => { closeSheet(); clearSelection(); cancelPick(); });
    function openSheet(html) {
      const body = sheet.querySelector(".rv-sheet-body");
      body.innerHTML = html;
      sheet.hidden = false;
      sheet.scrollTop = 0;
      panel.classList.add("collapsed");
      root.classList.remove("rv-panel-open");
      root.classList.add("rv-sheet-open");
      return body;
    }
    function closeSheet() { sheet.hidden = true; sheet.querySelector(".rv-sheet-body").innerHTML = ""; root.classList.remove("rv-sheet-open"); }

    function lightbox(src) {
      const lb = el("div", { class: "rv-lightbox", role: "dialog", "aria-label": "Photo" });
      lb.innerHTML = `<img alt="Photo" src="${esc(src)}"><button class="rv-btn" type="button">Close</button>`;
      const close = () => { lb.remove(); document.removeEventListener("keydown", onKey); };
      const onKey = (e) => { if (e.key === "Escape") close(); };
      lb.addEventListener("click", (e) => { if (e.target === lb || e.target.tagName === "BUTTON") close(); });
      document.addEventListener("keydown", onKey);
      root.appendChild(lb);
    }

    // ---------------------------------------------------------------- suggestions
    let picking = false, marker = null, suggOn = true;
    const banner = el("div", { class: "rv-banner", hidden: "" });
    banner.innerHTML = `<span>Tap the spot, or the thing on the map, your suggestion is about</span><button type="button" class="rv-btn">Cancel</button>`;
    root.appendChild(banner);
    banner.querySelector("button").addEventListener("click", cancelPick);

    function startPick() {
      clearSelection(); closeSheet();
      picking = true; banner.hidden = false; root.classList.add("rv-picking");
      if (narrow()) panel.classList.add("collapsed");
    }
    function cancelPick() {
      picking = false; banner.hidden = true; root.classList.remove("rv-picking");
      if (marker) { marker.remove(); marker = null; }
    }
    function pickAt(e) {
      picking = false; banner.hidden = true; root.classList.remove("rv-picking");
      const f = map.queryRenderedFeatures(box(e.point, 8), { layers: hitIds }).sort((a, b) => rank(b.layer.id) - rank(a.layer.id))[0];
      const L = f && layerOf(f);
      openForm({ lngLat: e.lngLat, layer_id: L ? L.id : null, layer_title: L ? L.title : null,
        feature_id: f ? String(f.id ?? "") : null, feature_label: f ? (f.properties._label || classLabel(L, f.properties) || "") : null });
    }
    function openForm(ctx) {
      if (marker) marker.remove();
      marker = new maplibregl.Marker({ color: STATUS.new.color }).setLngLat(ctx.lngLat).addTo(map);
      const about = [ctx.layer_title, ctx.feature_label].filter(Boolean).join(" · ") || "This spot on the map";
      const body = openSheet(`
        <form class="rv-form" novalidate>
          <div class="rv-pop-kicker"><span>Suggest a change</span></div>
          <div class="rv-pop-title">${esc(about)}</div>
          <label for="rv-s-text">What should change?</label>
          <textarea id="rv-s-text" rows="4" maxlength="4000" placeholder="e.g. This fence was moved back 5 m in August"></textarea>
          <div class="rv-form-row">
            <label class="rv-btn rv-photo-btn">Add photos<input type="file" accept="image/*" multiple hidden></label>
            <span class="rv-hint">Up to 6</span>
          </div>
          <div class="rv-thumbs"></div>
          <p class="rv-form-msg" role="alert"></p>
          <div class="rv-form-row">
            <button type="submit" class="rv-primary">Send to Rural Consulting</button>
            <button type="button" class="rv-link rv-cancel">Cancel</button>
          </div>
        </form>`);
      const form = body.querySelector("form"), input = body.querySelector("input[type=file]");
      const thumbs = body.querySelector(".rv-thumbs"), msg = body.querySelector(".rv-form-msg");
      let files = [];
      const drawThumbs = () => {
        thumbs.innerHTML = "";
        files.forEach((f, i) => {
          const t = el("div", { class: "rv-thumbwrap" });
          const img = el("img", { alt: "", src: URL.createObjectURL(f) });
          const x = el("button", { type: "button", "aria-label": "Remove photo" }, "×");
          x.addEventListener("click", () => { files.splice(i, 1); drawThumbs(); });
          t.append(img, x); thumbs.appendChild(t);
        });
      };
      input.addEventListener("change", () => { files = files.concat([...input.files]).slice(0, 6); input.value = ""; drawThumbs(); });
      body.querySelector(".rv-cancel").addEventListener("click", () => { closeSheet(); cancelPick(); });
      form.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const text = body.querySelector("textarea").value.trim();
        if (!text) { msg.textContent = "Write a few words about what should change."; return; }
        const btn = form.querySelector("button[type=submit]");
        btn.disabled = true; msg.textContent = files.length ? "Sending photos…" : "Sending…";
        try {
          await suggest.submit({ lng: ctx.lngLat.lng, lat: ctx.lngLat.lat, layer_id: ctx.layer_id, layer_title: ctx.layer_title,
            feature_id: ctx.feature_id, feature_label: ctx.feature_label, text, files });
        } catch (err) {
          btn.disabled = false; msg.textContent = "That didn't send: " + (err && err.message ? err.message : "please try again.");
          return;
        }
        if (marker) { marker.remove(); marker = null; }
        openSheet(`<div class="rv-pop"><div class="rv-pop-title">Thanks, that's been sent</div>
          <p class="rv-hint">Rural Consulting will look at it and update the map if needed. You'll see its status on the map (orange pin).</p>
          <button type="button" class="rv-primary rv-done">Close</button></div>`).querySelector(".rv-done").addEventListener("click", closeSheet);
        loadSuggestions();
      });
      setTimeout(() => body.querySelector("textarea").focus(), 50);
    }

    async function loadSuggestions() {
      try { suggestions = await suggest.list(); } catch (e) { suggestions = []; }
      if (!map.getSource("sugg")) return;
      map.getSource("sugg").setData({ type: "FeatureCollection", features: suggestions.map((s, i) => ({
        type: "Feature", id: i, properties: { i, status: s.status }, geometry: { type: "Point", coordinates: [s.lng, s.lat] } })) });
      const row = panel.querySelector(".rv-sugg-row");
      if (row) {
        row.hidden = !suggestions.length;
        row.querySelector(".rv-count").textContent = suggestions.length || "";
      }
      if (suggest.focus) {                       // opened from the inbox: go to that suggestion
        const i = suggestions.findIndex((s) => s.id === suggest.focus);
        suggest.focus = null;
        if (i >= 0) {
          const s = suggestions[i];
          map.jumpTo({ center: [s.lng, s.lat], zoom: Math.max(map.getZoom(), 17) });
          showSuggestion({ properties: { i } });
        }
      }
    }
    function showSuggestion(f) {
      const s = suggestions[f.properties.i];
      if (!s) return;
      const st = STATUS[s.status] || STATUS.new;
      const about = [s.layer_title, s.feature_label].filter(Boolean).join(" · ");
      let html = `<div class="rv-pop"><div class="rv-pop-kicker"><span class="rv-chip" style="background:${st.color}">${st.label}</span><span>Suggestion${about ? " · " + esc(about) : ""}</span></div>`;
      html += `<p class="rv-sugg-body">${esc(s.body).replace(/\n/g, "<br>")}</p>`;
      if ((s.photo_urls || []).length) html += `<div class="rv-thumbs">${s.photo_urls.map((u) => `<img class="rv-thumb" alt="Photo" src="${esc(u)}" data-full="${esc(u)}">`).join("")}</div>`;
      html += `<div class="rv-hint">${esc(s.author_email || "")}${s.author_email ? ", " : ""}${fmtDate(s.created_at)}</div>`;
      if (s.reply) html += `<div class="rv-reply"><b>Rural Consulting:</b> ${esc(s.reply).replace(/\n/g, "<br>")}</div>`;
      if (suggest.manage) html += `<button type="button" class="rv-link rv-manage">Status, reply and notes in the inbox</button>`;
      html += "</div>";
      select(null);
      showDetails(html, { lng: s.lng, lat: s.lat }, null);
      root.querySelectorAll(".rv-manage").forEach((b) => b.addEventListener("click", () => suggest.manage(s)));
    }

    // ---------------------------------------------------------------- labels
    const labelLayers = layers.filter((L) => L.labels && L.features);
    let labelsOn = true;
    const labelBox = el("div", { class: "rv-labels", "aria-hidden": "true" });
    mapEl.insertBefore(labelBox, mapEl.querySelector(".maplibregl-control-container"));   // under controls and popups
    const labelData = {};                                   // layer id -> [{text, type, coords, bbox}]
    const layerOn = (L) => { const c = root.querySelector("#rv-l-" + L.id); return c ? c.checked : L.visible; };
    let placed = [];
    function bboxOf(coords) {
      let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
      const walk = (x) => { if (typeof x[0] === "number") { a = Math.min(a, x[0]); b = Math.min(b, x[1]); c = Math.max(c, x[0]); d = Math.max(d, x[1]); } else x.forEach(walk); };
      walk(coords); return [a, b, c, d];
    }
    labelLayers.forEach((L) => {
      fetch(url(L.features)).then((r) => r.json()).then((fc) => {
        labelData[L.id] = [];
        // every piece of a feature's shape, including shapes mixed with stray edge lines where an area was cut to the
        // boundary along its own edge (older builds wrote these): the area pieces carry its label, not the lines
        const flat = (g, out) => {
          if (!g) return out;
          if (g.type === "GeometryCollection") (g.geometries || []).forEach((x) => flat(x, out));
          else if (/^Multi/.test(g.type)) (g.coordinates || []).forEach((c) => flat({ type: g.type.slice(5), coordinates: c }, out));
          else if (g.coordinates) out.push({ type: g.type === "LineString" ? "Line" : g.type, c: g.coordinates });
          return out;
        };
        const areaLayer = L.geometry ? /poly/i.test(L.geometry) : null;
        (fc.features || []).forEach((f) => { try {
          const t = f.properties && f.properties._lbl;
          if (!t || !f.geometry) return;
          let parts = flat(f.geometry, []).filter((pt) => ["Polygon", "Line", "Point"].includes(pt.type));
          if (areaLayer || parts.some((pt) => pt.type === "Polygon")) parts = parts.filter((pt) => pt.type === "Polygon");
          const thin = (r) => { if (r.length <= 160) return r; const k = Math.ceil(r.length / 150); return r.filter((_, i) => i % k === 0 || i === r.length - 1); };
          parts.forEach((pt) => {
            const it = { text: t, type: pt.type, bbox: bboxOf(pt.c), coords: pt.type === "Line" ? thin(pt.c) : pt.c };
            if (pt.type === "Polygon") { it.raw = pt.c; it.coords = outlineAt(it, 15); }   // 3D uses a ~3 m outline
            labelData[L.id].push(it);
          });
        } catch (e) { /* one odd shape never stops the rest being labelled */ } });
        placeLabels();
      }).catch(() => {});
    });
    // an area's outline for placing labels at zoom z: points less than ~1.5 screen pixels from the last one kept add
    // nothing, so a detailed 9,000-point gully outline stays exact close up and quick when zoomed out
    function outlineAt(f, z) {
      const key = Math.round(z * 2) / 2;
      if (f.oz === key) return f.oc;
      const deg = 360 / (512 * Math.pow(2, key)), kx = 1 / deg, ky = 1 / (deg * Math.cos((f.bbox[1] * Math.PI) / 180));
      f.oc = f.raw.map((r) => {
        const out = [r[0]]; let l = r[0];
        for (let i = 1; i < r.length - 1; i++) {
          const p = r[i], dx = (p[0] - l[0]) * kx, dy = (p[1] - l[1]) * ky;
          if (dx * dx + dy * dy > 2.25) { out.push(p); l = p; }
        }
        out.push(r[r.length - 1]); return out;
      });
      f.oz = key; return f.oc;
    }
    const REPEAT = 340;                                     // big areas show their label again about every 340 px
    function placeLabels() {
      const t0 = performance.now();
      try { placeLabelsNow(); } finally { RCLViewer.stats.labelsMs = Math.round(performance.now() - t0); }
    }
    function placeLabelsNow() {
      labelBox.innerHTML = ""; placed = [];
      if (!labelsOn || !labelLayers.length) return;
      const z = map.getZoom(), b = map.getBounds(), W = mapEl.clientWidth, H = mapEl.clientHeight;
      const pr = panel.getBoundingClientRect(), mr = mapEl.getBoundingClientRect();
      const left = !narrow() && !panel.classList.contains("collapsed") ? Math.max(0, pr.right - mr.left) : 0;
      const peek = narrow() ? parseFloat(getComputedStyle(root).getPropertyValue("--peek")) || 0 : 0;   // phone: under the sheet
      const x0 = left + 4, y0 = 4, x1 = W - 4, y1 = H - peek - 4;
      const cands = [], terrain3d = !!map.getTerrain();
      labelLayers.forEach((L, order) => {
        const st = L.labels || {};
        if (!layerOn(L) || !labelData[L.id] || z < (st.minzoom ?? L.visible_from ?? 0) - 0.25 || (st.maxzoom && z > st.maxzoom)) return;
        const size = st.size || 12;
        labelData[L.id].forEach((f) => {
          if (f.bbox[2] < b.getWest() || f.bbox[0] > b.getEast() || f.bbox[3] < b.getSouth() || f.bbox[1] > b.getNorth()) return;
          const tw = f.text.length * size * 0.58 + 6, th = size * 1.3;
          let at = null, weight = 0, alts = null;
          if (f.type === "Polygon" && terrain3d) {
            // 3D: each area's own best spot (worked out once), so moving the view stays quick
            if (!f.pole) {
              const k = Math.cos((f.bbox[1] * Math.PI) / 180) * 111320, ky = 110540;
              const p0 = polylabel(f.coords.map((r) => r.map((q) => [q[0] * k, q[1] * ky])), 2);
              f.pole = p0 ? [p0.x / k, p0.y / ky, p0.d] : [-999, -999, 0];
              f.area = ringArea(f.coords[0].map((q) => [q[0] * k, q[1] * ky]));
            }
            if (f.pole[2] <= 0) return;
            const q = map.project([f.pole[0], f.pole[1]]);
            if (q.x < x0 || q.x > x1 || q.y < y0 || q.y > y1) return;
            at = [q.x, q.y]; weight = f.area;
          } else if (f.type === "Polygon") {
            const scr = outlineAt(f, z).map((r) => r.map((p) => { const q = map.project(p); return [q.x, q.y]; }));
            const outer = clipRing(scr[0], x0, y0, x1, y1);
            if (outer.length < 3) return;                             // only a hole's worth is on screen
            const rings = [outer, ...scr.slice(1).map((r) => clipRing(r, x0, y0, x1, y1)).filter((r) => r.length > 2)];
            const pole = polylabel(rings, 2);
            if (!pole || pole.d < th * 0.6) return;                  // too small on screen for its label
            at = [pole.x, pole.y]; weight = ringArea(outer);
            // if something else is already there, a little above or below still sits well inside a roomy area
            if (pole.d > th * 1.8) alts = [at, [pole.x, pole.y + th * 1.15], [pole.x, pole.y - th * 1.15]];
            // a big or winding area is named again across the screen (as QGIS repeats labels), each copy at the
            // roomiest spot of its own patch, so no stretch of it is left without a name
            let mx = Infinity, my = Infinity, Mx = -Infinity, My = -Infinity;
            outer.forEach(([x, y]) => { mx = Math.min(mx, x); my = Math.min(my, y); Mx = Math.max(Mx, x); My = Math.max(My, y); });
            if (Math.max(Mx - mx, My - my) > REPEAT * 0.9) {                // long or big on screen
              const a0 = map.project([f.bbox[0], f.bbox[3]]);           // grid fixed to the area, steady as you pan
              const got = [[pole.x, pole.y]], need = Math.max(th * 0.8, tw * 0.35), spots = [];
              for (let gx = Math.floor((mx - a0.x) / REPEAT) * REPEAT + a0.x; gx < Mx; gx += REPEAT) {
                for (let gy = Math.floor((my - a0.y) / REPEAT) * REPEAT + a0.y; gy < My; gy += REPEAT) {
                  const cx0 = Math.max(gx, x0), cy0 = Math.max(gy, y0), cx1 = Math.min(gx + REPEAT, x1), cy1 = Math.min(gy + REPEAT, y1);
                  if (cx1 - cx0 < tw || cy1 - cy0 < th * 2) continue;
                  const o2 = clipRing(outer, cx0, cy0, cx1, cy1);
                  if (o2.length < 3) continue;
                  const p2 = polylabel([o2, ...rings.slice(1).map((r) => clipRing(r, cx0, cy0, cx1, cy1)).filter((r) => r.length > 2)], 3, 150);
                  if (p2 && p2.d >= need) spots.push(p2);
                }
              }
              // the roomiest spots first, well apart, and at most four more copies so close-ups don't fill with one name
              spots.sort((u, v) => v.d - u.d).forEach((p2) => {
                if (got.length > 4 || got.some((g) => Math.hypot(g[0] - p2.x, g[1] - p2.y) < REPEAT * 0.7)) return;
                got.push([p2.x, p2.y]);
                cands.push({ L, f, at: [p2.x, p2.y], alts: null, tw, th, weight: p2.d, st, order, again: true });
              });
            }
          } else if (f.type === "Line") {
            const pts = f.coords.map((p) => { const q = map.project(p); return [q.x, q.y]; }).filter((p) => p[0] > x0 && p[0] < x1 && p[1] > y0 && p[1] < y1);
            if (!pts.length) return;
            at = pts[Math.floor(pts.length / 2)]; weight = pts.length;
          } else {
            const q = map.project(f.coords);
            if (q.x < x0 || q.x > x1 || q.y < y0 || q.y > y1) return;
            // beside the point: right, left, above, below, whichever is free first
            alts = [[q.x + tw / 2 + 10, q.y], [q.x - tw / 2 - 10, q.y], [q.x, q.y - th / 2 - 9], [q.x, q.y + th / 2 + 9]];
            at = alts[0]; weight = 0;
          }
          cands.push({ L, f, at, alts, tw, th, weight, st, order });
        });
      });
      // every area's own label before any repeats; layers higher in the list win; then bigger areas (longer lines) first
      cands.sort((a, b) => (a.again ? 1 : 0) - (b.again ? 1 : 0) || a.order - b.order || b.weight - a.weight);
      const free = (box) => !(box[0] < x0 || box[2] > x1 || box[1] < y0 || box[3] > y1)
        && !placed.some((p) => !(box[2] < p.box[0] || box[0] > p.box[2] || box[3] < p.box[1] || box[1] > p.box[3]));
      // in 3D a hill can hide part of the map: only label what can actually be seen at that spot
      const terrain = !!map.getTerrain();
      const inRing = (pt, ring) => { let inside = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const a = ring[i], b = ring[j];
        if ((a[1] > pt[1]) !== (b[1] > pt[1]) && pt[0] < ((b[0] - a[0]) * (pt[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside; } return inside; };
      const seen = (c, at) => {
        if (!terrain) return true;
        const ll = map.unproject(c.f.type === "Point" ? [at[0] - (at[0] - map.project(c.f.coords).x), map.project(c.f.coords).y] : at);
        if (c.f.type === "Polygon") return inRing([ll.lng, ll.lat], c.f.coords[0]) && !c.f.coords.slice(1).some((h) => inRing([ll.lng, ll.lat], h));
        const target = c.f.type === "Point" ? c.f.coords : map.unproject(c.at).toArray();
        return Math.hypot((ll.lng - target[0]) * Math.cos((ll.lat * Math.PI) / 180), ll.lat - target[1]) * 111320 < 30;
      };
      cands.forEach((c) => {
        let box = null;
        for (const at of c.alts || [c.at]) {
          const b2 = [at[0] - c.tw / 2, at[1] - c.th / 2, at[0] + c.tw / 2, at[1] + c.th / 2];
          if (free(b2) && seen(c, at)) { box = b2; c.at = at; break; }
        }
        if (!box) return;
        const e = document.createElement("span");
        e.className = "rv-label";
        e.textContent = c.f.text;
        const halo = c.st.halo || (c.st.color && parseInt(c.st.color.slice(1, 3), 16) > 160 ? "#000000" : "#ffffff");
        e.style.cssText = `font-size:${c.st.size || 12}px;color:${c.st.color || "#1b1b1b"};font-weight:${c.st.bold ? 700 : 600};`
          + `text-shadow:0 0 2px ${halo},0 0 2px ${halo},0 0 3px ${halo},0 0 4px ${halo};`;
        e.style.transform = `translate(${c.at[0]}px,${c.at[1]}px) translate(-50%,-50%)`;
        labelBox.appendChild(e);
        placed.push({ box, e, lnglat: map.unproject(c.at) });
      });
    }
    // while the map moves, labels move with it; once it stops they're placed again for what's on screen
    map.on("move", () => placed.forEach((p) => { const q = map.project(p.lnglat); p.e.style.transform = `translate(${q.x}px,${q.y}px) translate(-50%,-50%)`; }));
    map.on("moveend", placeLabels);
    window.addEventListener("resize", () => setTimeout(placeLabels, 50));

    // ---------------------------------------------------------------- panel
    const panel = el("aside", { class: "rv-panel", "aria-label": "Map layers" });
    const meta = [m.survey_date ? "Surveyed " + fmtDate(m.survey_date) : "", m.area_ha ? m.area_ha.toLocaleString("en-NZ", { maximumFractionDigits: 1 }) + " ha" : ""].filter(Boolean).join(", ");
    const property = m.property && m.property !== (m.map_title || m.title) ? m.property : "";
    const kicker = [property, m.kind].filter(Boolean).join(" · ");
    const desc = (m.description || m.notes || "").trim();
    panel.innerHTML = `
      <button class="rv-toggle-panel" type="button" aria-label="Show or hide layers"></button>
      <div class="rv-head">
        <div class="rv-org"><span class="rv-brand"><img class="rv-logo rv-logo-light" src="brand/logo.png" alt="Rural Consulting"><img class="rv-logo rv-logo-dark" src="brand/logo-dark.png" alt="Rural Consulting"></span>${opts.onBack ? `<button type="button" class="rv-back">${esc(opts.backLabel || "All properties")}</button>` : ""}</div>
        <div class="rv-titlebar"><div>
            ${kicker ? `<div class="rv-kicker">${esc(kicker)}</div>` : ""}
            <div class="rv-title">${esc(m.map_title || m.title)}</div><div class="rv-meta">${esc(meta)}</div></div>
          <button type="button" class="rv-layers-btn" aria-expanded="false"><span class="rv-layers-ico" aria-hidden="true"></span>Layers</button></div>
      </div>
      <div class="rv-body">
        ${opts.maps && opts.maps.length > 1 ? `<div class="rv-mapsel"><label for="rv-mapsel">Other maps of this property</label>
          <select id="rv-mapsel">${opts.maps.map((x) => `<option value="${esc(x.id)}" ${x.id === opts.currentMap ? "selected" : ""}>${esc(x.title)}${x.kind ? " (" + esc(x.kind) + ")" : ""}</option>`).join("")}</select></div>` : ""}
        ${desc ? `<div class="rv-desc${desc.length > 180 ? " clamp" : ""}"><p>${esc(desc).replace(/\n/g, "<br>")}</p>${desc.length > 180 ? '<button type="button" class="rv-link rv-more">More</button>' : ""}</div>` : ""}
      </div>
      <div class="rv-foot">
        <div class="rv-seg" role="group" aria-label="Background map">
          ${Object.entries(BASEMAPS).map(([k, b]) => `<button type="button" data-bm="${k}" aria-pressed="${k === bm}">${b.label}</button>`).join("")}
        </div>
        ${(opts.actions || []).length ? `<div class="rv-actions">${opts.actions.map((a, i) => `<button type="button" data-act="${i}">${esc(a.label)}</button>`).join("")}</div>` : ""}
      </div>`;
    root.appendChild(panel);
    if (opts.onBack) panel.querySelector(".rv-back").addEventListener("click", opts.onBack);
    const sel = panel.querySelector("#rv-mapsel");
    if (sel) sel.addEventListener("change", () => opts.onSwitchMap && opts.onSwitchMap(sel.value));
    const more = panel.querySelector(".rv-more");
    if (more) more.addEventListener("click", () => {
      const box = more.parentElement; box.classList.toggle("clamp"); more.textContent = box.classList.contains("clamp") ? "More" : "Less";
    });
    // phones: the collapsed sheet shows the whole header (logo, property, title), however tall it is
    const setPeek = () => root.style.setProperty("--peek", (panel.querySelector(".rv-head").offsetHeight + 14) + "px");
    requestAnimationFrame(setPeek);
    window.addEventListener("resize", setPeek);
    panel.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () => opts.actions[+b.dataset.act].onClick()));
    const layersBtn = panel.querySelector(".rv-layers-btn");
    const togglePanel = (open) => {
      const isOpen = open ?? panel.classList.contains("collapsed");
      panel.classList.toggle("collapsed", !isOpen);
      root.classList.toggle("rv-panel-open", isOpen);
      layersBtn.setAttribute("aria-expanded", String(isOpen));
      if (isOpen) closeSheet();
    };
    panel.querySelector(".rv-toggle-panel").addEventListener("click", () => togglePanel());
    layersBtn.addEventListener("click", () => togglePanel());
    panel.querySelector(".rv-titlebar").addEventListener("click", (e) => { if (narrow() && e.target === e.currentTarget.firstElementChild) togglePanel(); });
    if (narrow()) panel.classList.add("collapsed");

    const body = panel.querySelector(".rv-body");
    if (suggest) {
      const row = el("div", { class: "rv-layer rv-sugg-row", hidden: "" });
      row.innerHTML = `<div class="rv-layer-row"><label for="rv-l-sugg"><input id="rv-l-sugg" class="rv-switch" type="checkbox" checked><span>Suggestions</span></label><span class="rv-count"></span></div>
        <ul class="rv-legend">${Object.values(STATUS).map((s) => `<li><span class="rv-dot" style="background:${s.color}"></span><span>${s.label}</span></li>`).join("")}</ul>`;
      body.appendChild(row);
      row.querySelector("input").addEventListener("change", (e) => {
        suggOn = e.target.checked;
        row.classList.toggle("off", !suggOn);
        ["sugg-halo", "sugg", "sugg-core"].forEach((id) => map.getLayer(id) && map.setLayoutProperty(id, "visibility", suggOn ? "visible" : "none"));
      });
    }
    let maskRow = null;
    if (m.mask) {
      const row = el("div", { class: "rv-layer rv-mask-row" });
      row.innerHTML = `<div class="rv-layer-row"><label for="rv-l-mask"><input id="rv-l-mask" class="rv-switch" type="checkbox" checked><span>Shade outside the property</span></label></div>`;
      maskRow = row;
      row.querySelector("input").addEventListener("change", (e) => {
        maskOn = e.target.checked;
        row.classList.toggle("off", !maskOn);
        if (map.getLayer("mask")) map.setLayoutProperty("mask", "visibility", maskOn ? "visible" : "none");
      });
    }
    let lastGroup = null;
    const switches = {};
    layers.forEach((L) => {
      if (L.group && L.group !== lastGroup) {
        const inGroup = layers.filter((x) => x.group === L.group);
        const one = inGroup.length > 1 && inGroup.every((x) => x.exclusive);
        body.appendChild(el("div", { class: "rv-group" }, esc(L.group) + (one ? ' <span class="rv-group-note">· one at a time</span>' : "")));
        lastGroup = L.group;
      }
      const row = el("div", { class: "rv-layer" + (L.visible ? "" : " off") });
      const cid = "rv-l-" + L.id;
      const count = `<span class="rv-count">${L.feature_count || ""}</span>`;
      const rivals = L.exclusive ? layers.filter((o) => o !== L && o.exclusive && o.group === L.group).map((o) => o.title) : [];
      if (rivals.length) row.title = "Switching this on switches off " + rivals.join(", ");
      row.innerHTML = `<div class="rv-layer-row"><label for="${cid}"><input id="${cid}" class="rv-switch" type="checkbox" ${L.visible ? "checked" : ""}><span>${esc(L.title)}</span></label>${count}</div>`;
      let legend = L.legend || [];
      if (L.draw) {
        const colors = L.draw.colors && L.draw.colors.length ? L.draw.colors : ["#e8590c"];
        legend = legend.length > 1 ? legend.map((g, i) => ({ label: g.label, src: legendIcon(colors[i] || colors[0], L.draw.type === "direction") }))
          : [{ label: L.draw.type === "direction" ? "Photo, cone shows the view" : "", src: legendIcon(colors[0], L.draw.type === "direction") }];
      } else legend = legend.map((g) => ({ label: g.label, src: url(g.icon) }));
      if (legend.length > 1 || (legend.length === 1 && legend[0].label && L.draw)) {
        row.innerHTML += `<ul class="rv-legend">${legend.map((g) => `<li><img alt="" src="${esc(g.src)}"><span>${esc(g.label)}</span></li>`).join("")}</ul>`;
      } else if (legend.length === 1) {
        row.querySelector("label span").insertAdjacentHTML("beforebegin", `<img alt="" src="${esc(legend[0].src)}" style="width:20px;height:20px">`);
      }
      if (L.kind === "imagery") {
        row.innerHTML += `<div class="rv-opacity"><span>Opacity</span><input type="range" min="0" max="100" value="${Math.round((L.opacity ?? 1) * 100)}" aria-label="${esc(L.title)} opacity"></div>`;
      }
      row.dataset.from = L.visible_from || 0;
      row.dataset.count = L.feature_count || "";
      body.appendChild(row);
      const setOn = (on) => {
        row.querySelector(".rv-switch").checked = on;
        row.classList.toggle("off", !on);
        (mapIds[L.id] || []).forEach((id) => map.getLayer(id) && map.setLayoutProperty(id, "visibility", on ? "visible" : "none"));
        if (L.labels) setTimeout(placeLabels, 0);
      };
      switches[L.id] = setOn;
      row.querySelector(".rv-switch").addEventListener("change", (e) => {
        const on = e.target.checked;
        setOn(on);
        if (on && L.exclusive) {                                 // one at a time: switch the others in its group off
          layers.forEach((o) => { if (o !== L && o.exclusive && o.group === L.group && switches[o.id]) switches[o.id](false); });
        }
        clearSelection();
      });
      const op = row.querySelector(".rv-opacity input");
      if (op) op.addEventListener("input", (e) => map.setPaintProperty("t-" + L.id, "raster-opacity", e.target.value / 100));
    });

    if (maskRow) body.appendChild(maskRow);                // after the layers
    if (labelLayers.length) {
      const row = el("div", { class: "rv-layer rv-mask-row" });
      row.innerHTML = `<div class="rv-layer-row"><label for="rv-l-labels"><input id="rv-l-labels" class="rv-switch" type="checkbox" checked><span>Labels</span></label></div>`;
      body.appendChild(row);
      row.querySelector("input").addEventListener("change", (e) => { labelsOn = e.target.checked; row.classList.toggle("off", !labelsOn); placeLabels(); });
    }

    panel.querySelectorAll("[data-bm]").forEach((b) => b.addEventListener("click", () => {
      const k = b.dataset.bm;
      panel.querySelectorAll("[data-bm]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      ["aerial", "map"].forEach((n) => map.setLayoutProperty("bm-" + n, "visibility", n === k ? "visible" : "none"));
      storeSet("rv-basemap", k);
    }));

    const fit = el("button", { class: "rv-btn rv-fit", type: "button" }, "Whole property");
    fit.addEventListener("click", () => map.fitBounds(m.bounds, { padding: pad() }));
    root.appendChild(fit);
    if (suggest) {
      const sb = el("button", { class: "rv-btn rv-suggest-btn", type: "button" }, '<span aria-hidden="true">＋</span> Suggest a change');
      sb.addEventListener("click", startPick);
      root.appendChild(sb);
    }
    // tell people when a layer only shows closer in (QGIS scale limits are kept)
    const zoomNotes = () => {
      const z = map.getZoom();
      body.querySelectorAll(".rv-layer:not(.rv-sugg-row):not(.rv-mask-row)").forEach((row) => {
        const hidden = z < Number(row.dataset.from) - 0.5;
        row.classList.toggle("far", hidden);
        row.querySelector(".rv-count").textContent = hidden ? "Zoom in to see" : row.dataset.count;
      });
    };
    map.on("zoomend", zoomNotes);
    map.once("load", zoomNotes);
    return map;
  }

  const RCLViewer = { mount, terrain: null, stats: {} };
  window.RCLViewer = RCLViewer;
})();
