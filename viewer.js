/* RCL farm map viewer.
 * RCLViewer.mount(element, {
 *   manifest, url: relPath => absoluteUrl, onBack?, actions?: [{ label, onClick }],
 *   suggest?: { list: async () => [suggestion], submit: async (draft) => void,      // portal only
 *              focus?: suggestionId, manage?: (suggestion) => void }                // staff: open in the inbox
 *   shared?: [layer entry or null, one for each of manifest.shared_layers]          // platform: layers published once, see mergeShared
 *   referenceLayers?: [{ key: "roads" | "waterways", url, title?, credit? }]         // platform: where the reference layers are, see referenceDefs
 *                   + [{ key, url, title, credit, style: { source_layer, layers, legend } }] // platform: context layers, see contextDefs
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
  // a title or legend label that says nothing ("default" from a style, the plugin's stand-in "Other" for unnamed symbols)
  const said = (t) => t != null && String(t).trim() !== "" && !/^(default|null|none|untitled)$/i.test(String(t).trim());
  // a feature's title in its details: its own title, else its class, else (a photo) its file name, else the layer's name
  function featureTitle(L, p, cls) {
    if (said(p._label)) return String(p._label);
    if (said(cls)) return String(cls);
    if (p._photo) {
      const file = Object.values(p).find((v) => typeof v === "string" && /^[^\\/]+\.(jpe?g|png|tiff?|heic|webp|dng)$/i.test(v.trim()));
      if (!file) return "Photo";
      if (/\s/.test(file.trim())) return file.trim();
      const n = file.replace(/\.[^.]+$/, "").match(/\d+/g);   // DJI_0043.JPG reads as "Photo 0043", as the plugin's own titles do
      return n ? "Photo " + n[n.length - 1] : file.trim();
    }
    return L.title;
  }
  // the legend of a layer the web map draws itself (photo dots and cones): [{i, label, color}]. When QGIS named none of the
  // symbols (the plugin then writes "Other" for each), the category's own label or value is used, or one plain entry is shown.
  function drawLegend(L) {
    const colors = L.draw.colors && L.draw.colors.length ? L.draw.colors : ["#e8590c"];
    const lg = L.legend || [];
    const plain = [{ i: 0, label: L.draw.type === "direction" ? "Photo, cone shows the view" : "", color: colors[0] }];
    if (lg.length <= 1) return plain;
    const seen = {};
    lg.forEach((g) => { const k = String(g.label || "").trim().toLowerCase(); seen[k] = (seen[k] || 0) + 1; });
    const c = L.classes || {};
    const items = lg.map((g, i) => {
      let label = String(g.label || "").trim();
      if (!said(label) || (label.toLowerCase() === "other" && seen.other > 1)) {
        const v = c.kind === "categories" ? c.values && c.values[i] : c.ranges && c.ranges[i];
        const named = v && (c.kind === "categories" ? v[1] : v[2]);
        const value = v && c.kind === "categories" && !Array.isArray(v[0]) ? v[0] : null;
        label = said(named) ? String(named) : said(value) ? String(value) : "";
      }
      return { i, label, color: colors[i] || colors[0] };
    });
    return items.some((g) => g.label) ? items.map((g) => (g.label ? g : Object.assign(g, { label: "Other" }))) : plain;
  }
  // an enlarged photo closes with its Close button, Esc, or a click beside the photo
  function lightboxWire(lb, doc) {
    const close = () => { lb.remove(); doc.removeEventListener("keydown", onKey); };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    lb.addEventListener("click", (e) => { if (e.target === lb || (e.target.closest && e.target.closest(".rv-lightbox-close"))) close(); });
    doc.addEventListener("keydown", onKey);
    return close;
  }
  // the whole-property view: top down and north up, however the map was turned or tilted (a photo's view, 3D)
  const wholeView = (padding) => ({ padding, bearing: 0, pitch: 0, freezeElevation: true });
  // The photo view: the map looks the way a photo's camera did, with the hills in 3D. Leaving it puts back the view and the
  // 3D (or 2D) the person had before; stepping from photo to photo keeps that first view to go back to.
  // cam: { get() -> camera, threeD() -> bool, setThreeD(on), look(view), move(camera), whole() }
  function photoViewState(cam) {
    let before = null;
    const back3d = (b) => { if (cam.threeD() !== b.threeD) cam.setThreeD(b.threeD); };
    return {
      active: () => !!before,
      enter(view) {
        if (!before) before = { camera: cam.get(), threeD: cam.threeD() };
        if (!cam.threeD()) cam.setThreeD(true);
        cam.look(view);
      },
      leave() {                                    // back to the view from before (or, not known, the whole property)
        if (!before) return false;
        const b = before; before = null;
        back3d(b);
        if (b.camera) cam.move(b.camera); else cam.whole();
        return true;
      },
      end() {                                      // the map is going somewhere else: only the 3D (or 2D) goes back
        if (!before) return false;
        const b = before; before = null;
        back3d(b);
        return true;
      },
    };
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
  function lineIcon(color, w, o = {}) {
    const c = document.createElement("canvas"); c.width = c.height = 40;
    const g = c.getContext("2d");
    const path = () => { g.beginPath(); g.moveTo(4, 26); g.bezierCurveTo(14, 12, 24, 34, 36, 18); };
    g.lineCap = "round";
    if (o.casing) { path(); g.lineWidth = w + 2; g.strokeStyle = o.casing; g.stroke(); }   // pale lines show on white paper
    path(); g.lineWidth = w; g.strokeStyle = color;
    if (o.dash) { g.lineCap = "butt"; g.setLineDash(o.dash); }
    g.stroke();
    return c.toDataURL("image/png");
  }
  // shared reference layers (vector tiles, one public file each for every map, not part of any package), bottom first.
  // classes: [key, legend label, colour, legend width, {dash, casing}]
  const REF_DEFS = [
    { key: "waterways", id: "ref-waterways", src: "ref-ww", title: "Waterways", store: "rv-ref-ww",
      file: "ref/waterways-canterbury.pmtiles", credit: "Waterways: LINZ Topo50 (CC BY 4.0)", prop: "wclass",
      classes: [["River", "River", "#4f9bd9", 5], ["Canal or race", "Canal or race", "#3fb8c9", 4],
        ["Stream or creek", "Stream or creek", "#6aaee6", 3.2], ["Small waterway", "Small waterway", "#8cc3ee", 2.4],
        ["Drain", "Drain", "#9bb7c9", 2]],
      labels: { size: 12, color: "#ffffff", italic: true, minzoom: 11 }, labelFrom: 10.75, labelLayers: ["main"],
      labelText: (p) => p.name || null },
    { key: "roads", id: "ref-roads", src: "ref-rd", title: "Roads", store: "rv-ref-rd",
      file: "ref/roads-nz.pmtiles", credit: "Roads: LINZ Topo50 (CC BY 4.0)", prop: "rclass",
      classes: [["highway", "State highway", "#f5d76e", 5, { casing: "#3a3a3a" }],
        ["sealed", "Sealed road", "#f2f2f2", 3.6, { casing: "#3a3a3a" }],
        ["metalled", "Metalled road", "#e8a35c", 3],
        ["unmetalled", "Unmetalled road", "#e8a35c", 3, { dash: [5, 4] }]],
      labels: { size: 11, color: "#ffffff", minzoom: 9.75 }, labelFrom: 9.75, labelLayers: ["major", "minor"],
      // state highways as "SH 1" from zoom 10; road names from zoom 13
      labelText: (p, z) => (p.ref ? "SH " + p.ref : z >= 12.75 ? roadName(p.name) : null) },
  ];
  // LINZ road names are in capitals: "WAKANUI ROAD" -> "Wakanui Road", "MCLEAN STREET" -> "McLean Street"
  function roadName(t) {
    if (!t) return null;
    if (t !== t.toUpperCase()) return t;
    return t.toLowerCase().replace(/(^|[\s\-/('])([a-zāēīōū])/g, (_, a, b) => a + b.toUpperCase())
      .replace(/\bMc([a-z])/g, (_, b) => "Mc" + b.toUpperCase()).replace(/\b(Sh|Nz)\b/g, (x) => x.toUpperCase());
  }
  const REF_LIVE_BASE = "https://maps.ruralconsulting.co.nz/";
  // The reference layers a map draws, bottom first, each with the places its file may be (tried in order). Without
  // opts.referenceLayers: every one the map does not turn off, from opts.referenceUrls / opts.referenceUrl, then this site's ref/
  // folder, then the live portal. With it (the platform app: its signed links to the files it stores once, [{ key, url, title,
  // credit }]): only those listed with a url, each from that url alone, under its own title and credit; the rest are not drawn.
  // "reference": false on the map, or in opts.reference, still turns them off either way.
  function referenceDefs(m, opts, base) {
    const refOff = (r, key) => r === false || (r && typeof r === "object" && r[key] === false);
    const on = REF_DEFS.filter((d) => !refOff(m.reference, d.key) && !refOff(opts.reference, d.key));
    if (!Array.isArray(opts.referenceLayers)) {
      return on.map((d, ri) => Object.assign({}, d, { urls: [opts.referenceUrls && opts.referenceUrls[d.key], ri === 0 ? opts.referenceUrl : null,
        new URL(d.file, base).href, REF_LIVE_BASE + d.file].filter(Boolean) }));
    }
    const plain = (t) => String(t).replace(/[<>]/g, "");      // the map's attribution line is HTML
    return on.flatMap((d) => {
      const g = opts.referenceLayers.find((r) => r && r.key === d.key && !r.style && typeof r.url === "string" && r.url);
      return g ? [Object.assign({}, d, { title: g.title ? plain(g.title) : d.title, credit: g.credit ? plain(g.credit) : d.credit, urls: [g.url] })] : [];
    });
  }
  // Context layers (catchments, zones, protected land...): referenceLayers entries that carry their own style, drawn from their
  // file unclipped, under the map's own layers, off until switched on. style: { source_layer, layers: [MapLibre fill, line,
  // circle or symbol layer definitions against that source layer], legend: [{ label, fill?, outline?, opacity?, line?, width?,
  // dash?, circle?, stroke? }] }. Only those four types, their paint, layout, filter and zooms are taken; the source is the
  // entry's own. A symbol layer is not drawn by MapLibre (the map has no font server): its text-field (["get", field], or a
  // "concat" of strings and gets) names the features with the viewer's own labels, from its minzoom, in its text colour and
  // halo. Titles, credits and legend labels are plain text and colours hex only. "reference": false turns these off too.
  // A symbol layer may name its own "source-layer" in the same file: the build's one point per area (<key>-labels), so each area
  // is named once, centred, not once per tile piece; a point's "label_r" (metres from its edge) leaves out areas too small on
  // screen for their name. Its text-color may be a "match" on a field (each zone named in its own hue); "text-transform":
  // "uppercase", "text-letter-spacing" (em), "text-padding" (px kept clear around it), "symbol-spacing" (px between a line's
  // names) and a maxzoom are taken too.
  const CTX_TYPES = ["fill", "line", "circle", "symbol"];
  const hexOnly = (v) => (/^#[0-9a-f]{3,8}$/i.test(String(v || "")) ? String(v) : null);
  // a label colour: a hex, or ["match", ["get", field], value, hex, ..., fallback hex] -> {field, map, fallback}
  function colourRule(v) {
    if (hexOnly(v)) return hexOnly(v);
    if (!Array.isArray(v) || v[0] !== "match" || !Array.isArray(v[1]) || v[1][0] !== "get" || typeof v[1][1] !== "string" || v.length < 5) return null;
    const map = {};
    for (let i = 2; i < v.length - 1; i += 2) if (hexOnly(v[i + 1]) && (typeof v[i] === "string" || typeof v[i] === "number")) map[v[i]] = v[i + 1];
    return { field: v[1][1], map, fallback: hexOnly(v[v.length - 1]) || "#1b1b1b" };
  }
  const colourFor = (rule, p) => (!rule ? null : typeof rule === "string" ? rule : rule.map[p[rule.field]] || rule.fallback);
  function contextDefs(m, opts) {
    if (!Array.isArray(opts.referenceLayers)) return [];
    const refOff = (r, key) => r === false || (r && typeof r === "object" && r[key] === false);
    const plain = (t) => String(t).replace(/[<>]/g, "");
    const obj = (o) => (o && typeof o === "object" && !Array.isArray(o) ? Object.assign({}, o) : {});
    const num = (v) => (typeof v === "number" && isFinite(v) ? v : undefined);
    const seen = new Set();
    return opts.referenceLayers.flatMap((r) => {
      const st = r && r.style;
      if (!st || typeof st !== "object" || !Array.isArray(st.layers) || typeof r.url !== "string" || !r.url) return [];
      const key = String(r.key || "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 80);
      if (!key || seen.has(key) || typeof st.source_layer !== "string" || !st.source_layer) return [];
      if (refOff(m.reference, key) || refOff(opts.reference, key)) return [];
      seen.add(key);
      const layers = [];
      let labels = null;
      st.layers.forEach((x) => {
        if (!x || !CTX_TYPES.includes(x.type)) return;
        if (x.type === "symbol") {
          const lay = obj(x.layout), paint = obj(x.paint);
          if (labels || !lay["text-field"]) return;
          const font = Array.isArray(lay["text-font"]) ? lay["text-font"].join(" ") : "";
          const rule = colourRule(paint["text-color"]);
          labels = { text: lay["text-field"], minzoom: num(x.minzoom) ?? 0, size: num(lay["text-size"]) || 12,
            color: typeof rule === "string" ? rule : rule ? rule.fallback : "#1b1b1b", halo: hexOnly(paint["text-halo-color"]) || "#ffffff",
            italic: /italic/i.test(font), bold: /bold/i.test(font) };
          // CL3: only what is given, so a layer without these reads exactly as before
          const sl = x["source-layer"];
          if (typeof sl === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(sl)) labels.sourceLayer = sl;
          if (rule && typeof rule === "object") labels.colorBy = rule;
          if (lay["text-transform"] === "uppercase") labels.upper = true;
          if (num(lay["text-letter-spacing"]) !== undefined) labels.spacing = Math.min(Math.max(lay["text-letter-spacing"], 0), 0.5);
          if (num(lay["text-padding"]) !== undefined) labels.padding = Math.min(Math.max(lay["text-padding"], 0), 40);
          if (num(lay["symbol-spacing"]) !== undefined) labels.repeat = Math.min(Math.max(lay["symbol-spacing"], 150), 2000);
          if (num(x.maxzoom) !== undefined) labels.maxzoom = x.maxzoom;
          return;
        }
        const d = { type: x.type, paint: obj(x.paint), layout: obj(x.layout) };
        if (Array.isArray(x.filter)) d.filter = x.filter;
        if (num(x.minzoom) !== undefined) d.minzoom = x.minzoom;
        if (num(x.maxzoom) !== undefined) d.maxzoom = x.maxzoom;
        layers.push(d);
      });
      const legend = (Array.isArray(st.legend) ? st.legend : []).filter((e) => e && typeof e === "object").slice(0, 40).map((e) => ({
        label: plain(e.label || ""), fill: hexOnly(e.fill), outline: hexOnly(e.outline), line: hexOnly(e.line), circle: hexOnly(e.circle),
        stroke: hexOnly(e.stroke), opacity: num(e.opacity), width: num(e.width), dash: Array.isArray(e.dash) ? e.dash.filter((v) => num(v) !== undefined) : null,
        casing: hexOnly(e.casing) }));
      const def = { key, id: "ctx-" + key, src: "ctx-src-" + key, store: "rv-ctx-" + key, title: plain(r.title || key),
        credit: plain(r.credit || ""), url: r.url, sourceLayer: st.source_layer, layers, labels, legend };
      if (typeof st.note === "string" && st.note.trim()) def.note = plain(st.note).trim().slice(0, 300);   // CL3: one line under the legend
      return [def];
    });
  }
  // a context layer's label text for a feature: ["get", f], ["to-string", e], ["concat", ...] or a plain string; "" when a field is empty
  function contextText(e, p) {
    if (typeof e === "string") return e;
    if (typeof e === "number") return String(e);
    if (!Array.isArray(e)) return "";
    if (e[0] === "get") { const v = p[e[1]]; return v == null ? "" : String(v).trim(); }
    if (e[0] === "to-string") return contextText(e[1], p);
    if (e[0] === "concat") {
      const parts = e.slice(1).map((x) => [x, contextText(x, p)]);
      return parts.some(([x, t]) => Array.isArray(x) && t === "") ? "" : parts.map(([, t]) => t).join("");
    }
    return "";
  }
  // a context layer's legend picture: an area as a solid chip of its colour (not its see-through fill, which turns muddy on the
  // dark panel) with its outline inside a thin light edge and a faint dark one, readable on the dark and the light panel; a
  // line as a short sample on its light casing; a point as a dot with its ring
  function contextIcon(e) {
    const c = document.createElement("canvas"); c.width = 40; c.height = 40;
    const g = c.getContext("2d");
    if (e.line && !e.fill) {
      const w = Math.max(2, (e.width || 1.5) * 2), path = () => { g.beginPath(); g.moveTo(5, 26); g.bezierCurveTo(14, 12, 25, 32, 35, 16); };
      g.lineCap = "round"; g.lineJoin = "round";
      path(); g.lineWidth = w + 5; g.strokeStyle = "rgba(0,0,0,0.25)"; g.stroke();         // a faint dark edge: the casing shows on white
      path(); g.lineWidth = w + 4; g.strokeStyle = e.casing || "#ffffff"; g.globalAlpha = e.casing ? 0.9 : 0.6; g.stroke(); g.globalAlpha = 1;
      path(); g.lineWidth = w; g.strokeStyle = e.line;
      if (e.dash && e.dash.length) { g.lineCap = "butt"; g.setLineDash(e.dash.map((v) => v * 2)); }
      g.stroke();
    } else if (e.circle) {
      g.beginPath(); g.arc(20, 20, 9, 0, 2 * Math.PI); g.fillStyle = e.circle; g.fill();
      g.lineWidth = 3; g.strokeStyle = e.stroke || "#ffffff"; g.stroke();
      g.beginPath(); g.arc(20, 20, 11, 0, 2 * Math.PI); g.lineWidth = 1; g.strokeStyle = "rgba(0,0,0,0.35)"; g.stroke();   // shows a white ring on white
    } else {
      const chip = () => { g.beginPath(); if (g.roundRect) g.roundRect(6, 6, 28, 28, 4); else g.rect(6, 6, 28, 28); };
      chip(); g.lineWidth = 4; g.strokeStyle = "rgba(0,0,0,0.3)"; g.stroke();                // the faint dark edge, outermost
      chip(); g.lineWidth = 2; g.strokeStyle = "rgba(255,255,255,0.9)"; g.stroke();          // the thin light edge
      chip(); g.fillStyle = e.fill || e.outline || "#b0b0b0"; g.fill();                       // the colour itself, solid
      const o = e.outline && e.fill ? e.outline : null;
      if (o) {
        g.beginPath(); g.rect(8.5, 8.5, 23, 23); g.lineWidth = 3; g.strokeStyle = o;
        if (e.dash && e.dash.length) g.setLineDash(e.dash.map((v) => v * 1.5));
        g.stroke();
      }
    }
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

  // Layers published once and shared by many maps (core layers, a group's shared layers). manifest.shared_layers names them, with
  // where each goes in the list; whoever mounts the viewer says where each one is (opts.shared, by its place in that list, each a
  // layer entry like those in manifest.layers, its files found through url()). The viewer makes no database calls of its own.
  // One that nobody can supply is left out and reported, so the map still opens. These layers are region-wide and not cut to the
  // boundary, which is why they count as reaching past it for the mask below.
  function mergeShared(own, refs, supplied, missing) {
    const inserts = [];
    (refs || []).forEach((ref, i) => {
      const L = supplied && supplied[i];
      if (!L || !L.tiles) { missing.push(ref.title || ref.key); return; }
      inserts.push({ at: Number.isFinite(ref.position) ? ref.position : own.length, L: Object.assign({ opacity: 1, legend: [] }, L, {
        id: L.id || "shared-" + i, title: ref.title || L.title, group: ref.group ?? L.group ?? "", visible: ref.visible !== false,
        exclusive: !!ref.exclusive, shared: true }) });
    });
    if (!inserts.length) return own.slice();
    inserts.sort((a, b) => a.at - b.at);
    const out = [];
    let k = 0;
    for (let i = 0; i <= own.length; i++) {
      while (k < inserts.length && inserts[k].at <= i) out.push(inserts[k++].L);
      if (i < own.length) out.push(own[i]);
    }
    while (k < inserts.length) out.push(inserts[k++].L);
    return out;
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
    let toolMode = null;                           // "measure" while measuring: map clicks add points, no popups

    // ---------------------------------------------------------------- 3D: hills in relief, off until asked for
    // Elevation is only downloaded while 3D is on. Default: free terrain tiles (in NZ made from the LINZ 8 m DEM);
    // the portal passes LINZ Basemaps elevation (LiDAR where flown) when it has a LINZ key.
    let threeD = false;
    const fillOpacity = {};
    const terrainSrc = () => Object.assign({ type: "raster-dem", tileSize: 256, maxzoom: 15 },
      opts.terrain || RCLViewer.terrain || {
        tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"], encoding: "terrarium",
        attribution: "Elevation: Mapzen terrain tiles (LINZ 8 m DEM)" });
    // auto: switched by the photo view, which moves the map itself (no tilt here) and leaves the person's own choice saved.
    // Every move with the hills on passes freezeElevation: MapLibre (5.x) otherwise keeps the ground height it guessed when
    // the move began (sea level, if 3D has only just been switched on and no elevation tile has arrived) and stops following
    // the ground afterwards, so the camera can end up inside a hill: a large flat blank wedge across the map.
    function setThreeD(on, auto) {
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
        if (!auto) onGround(map.getCenter(), () => threeD && map.easeTo({ pitch: 62, bearing: map.getBearing() || -20, duration: 900, freezeElevation: true }));
      } else {
        map.setTerrain(null);
        if (map.getLayer("hillshade")) map.setLayoutProperty("hillshade", "visibility", "none");
        Object.entries(fillOpacity).forEach(([id, v]) => map.getLayer(id) && map.setPaintProperty(id, "fill-opacity", v));
        if (!auto) map.easeTo({ pitch: 0, bearing: 0, duration: 600 });
      }
      if (!auto) storeSet("rv-3d", on ? "1" : "");
    }
    const ctl3d = el("div", { class: "maplibregl-ctrl maplibregl-ctrl-group rv-3d" });
    const btn3d = el("button", { type: "button", "aria-pressed": "false", title: "Show the hills in 3D (drag with the right mouse button, or two fingers, to tilt and turn)" }, "3D");
    ctl3d.appendChild(btn3d);
    map.addControl({ onAdd: () => ctl3d, onRemove: () => ctl3d.remove() }, "top-right");
    btn3d.addEventListener("click", () => setThreeD(!threeD));

    const sharedMissing = [];                      // shared layers the map refers to that could not be supplied
    const layers = mergeShared(m.layers.map((L) => Object.assign({}, L)), m.shared_layers, opts.shared, sharedMissing);   // top first, as in QGIS
    // "one at a time" groups (mutually exclusive in QGIS): only the top one that starts on stays on
    const exOn = {};
    layers.forEach((L) => { if (L.exclusive && L.visible) { if (exOn[L.group]) L.visible = false; else exOn[L.group] = true; } });
    // reference layers (waterways, roads): drawn under the property's layers and over the outside shading.
    // Off for a map with "reference": false, or one at a time with "reference": {"roads": false}
    const REFS = referenceDefs(m, opts, document.baseURI).map((d) => Object.assign({}, d, {
      ready: false,
      L: { id: d.id, title: d.title, ref: true, visible: storeGet(d.store) !== "0", labels: d.labels } }));
    const refWanted = REFS.length > 0;
    // context layers (platform core layers with their own style): off until switched on, remembered on this device
    const CTX = contextDefs(m, opts).map((d) => Object.assign({}, d, {
      ready: false,
      L: { id: d.id, title: d.title, ctx: true, visible: storeGet(d.store) === "1", labels: d.labels } }));
    // where each context and reference map layer sits, bottom first: areas, then lines, then roads and waterways, then points;
    // all of them under the property's own layers
    const CTX_Z = { fill: 1, line: 2, circle: 4 }, REF_Z = 3;
    const stackZ = {};
    const ctxIdsAbove = (z) => CTX.flatMap((o) => mapIds[o.id] || []).filter((id) => stackZ[id] > z);
    const hitIds = [];
    const coneIds = [];                            // photo cones are clickable too: a cone picks the photo facing that way
    const mapIds = {};                             // web layer id -> map layer ids (for the on/off switch)
    const own = (L, id) => { (mapIds[L.id] = mapIds[L.id] || []).push(id); return id; };
    let suggestions = [];
    let maskOn = true;

    // add the property's layers as soon as the map's style is ready, without waiting for the background imagery
    function addRefLayers(R, before, vis) {
      const c = Object.fromEntries(R.classes.map((k) => [k[0], k]));
      if (R.key === "waterways") {
        const colour = ["match", ["get", "wclass"], "River", c.River[2], "Canal or race", c["Canal or race"][2],
          "Stream or creek", c["Stream or creek"][2], "Drain", c.Drain[2], c["Small waterway"][2]];
        const w = (k) => ["match", ["get", "wclass"], "River", k * 1.6, "Canal or race", k * 1.2, "Stream or creek", k, k * 0.7];
        map.addLayer({ id: own(R.L, "ref-ww-small"), type: "line", source: R.src, "source-layer": "small", minzoom: 12,
          layout: { visibility: vis, "line-cap": "round", "line-join": "round" },
          paint: { "line-color": colour, "line-opacity": 0.85,
            "line-width": ["interpolate", ["exponential", 1.5], ["zoom"], 12, 0.5, 15, 1.2, 18, 2.6] } }, before);
        map.addLayer({ id: own(R.L, "ref-ww-main"), type: "line", source: R.src, "source-layer": "main",
          layout: { visibility: vis, "line-cap": "round", "line-join": "round" },
          paint: { "line-color": colour, "line-opacity": 0.95,
            "line-width": ["interpolate", ["exponential", 1.5], ["zoom"], 7, w(0.5), 11, w(1.1), 14, w(1.8), 17, w(3.2), 20, w(5)] } }, before);
        return;
      }
      // roads: minor (metalled, unmetalled dashed) under major (sealed, highways, each with a dark casing)
      const building = ["==", ["get", "status"], "under construction"];
      const minorW = ["interpolate", ["exponential", 1.5], ["zoom"], 11, 0.6, 14, 1.8, 18, 5];
      const majorW = ["interpolate", ["exponential", 1.5], ["zoom"], 6, ["match", ["get", "rclass"], "highway", 0.8, 0.4],
        10, ["match", ["get", "rclass"], "highway", 1.6, 0.9], 14, ["match", ["get", "rclass"], "highway", 4, 2.6],
        18, ["match", ["get", "rclass"], "highway", 9, 7]];
      const casingW = ["interpolate", ["exponential", 1.5], ["zoom"], 6, ["match", ["get", "rclass"], "highway", 1.8, 1.2],
        10, ["match", ["get", "rclass"], "highway", 2.8, 1.9], 14, ["match", ["get", "rclass"], "highway", 6, 4.4],
        18, ["match", ["get", "rclass"], "highway", 12, 10]];
      const lay = { visibility: vis, "line-cap": "round", "line-join": "round" };
      map.addLayer({ id: own(R.L, "ref-rd-metalled"), type: "line", source: R.src, "source-layer": "minor", minzoom: 11,
        filter: ["all", ["==", ["get", "rclass"], "metalled"], ["!", building]], layout: lay,
        paint: { "line-color": c.metalled[2], "line-opacity": 0.9, "line-width": minorW } }, before);
      map.addLayer({ id: own(R.L, "ref-rd-unmetalled"), type: "line", source: R.src, "source-layer": "minor", minzoom: 11,
        filter: ["any", ["==", ["get", "rclass"], "unmetalled"], building], layout: Object.assign({}, lay, { "line-cap": "butt" }),
        paint: { "line-color": c.unmetalled[2], "line-opacity": 0.9, "line-width": minorW, "line-dasharray": [2.5, 2] } }, before);
      map.addLayer({ id: own(R.L, "ref-rd-casing"), type: "line", source: R.src, "source-layer": "major", filter: ["!", building],
        layout: lay, paint: { "line-color": "#1b1b1b", "line-opacity": 0.55, "line-width": casingW } }, before);
      map.addLayer({ id: own(R.L, "ref-rd-major"), type: "line", source: R.src, "source-layer": "major", filter: ["!", building],
        layout: lay, paint: { "line-color": ["match", ["get", "rclass"], "highway", c.highway[2], c.sealed[2]], "line-width": majorW } }, before);
      map.addLayer({ id: own(R.L, "ref-rd-building"), type: "line", source: R.src, "source-layer": "major", filter: building,
        layout: Object.assign({}, lay, { "line-cap": "butt" }),
        paint: { "line-color": ["match", ["get", "rclass"], "highway", c.highway[2], c.sealed[2]], "line-width": majorW,
          "line-dasharray": [2, 1.5] } }, before);
    }
    function addReference() {
      REFS.forEach((R, ri) => {
        const urls = R.urls;
        const probe = (i) => {
          if (i >= urls.length) return;                         // not available here: its row stays hidden
          fetch(urls[i], { headers: { Range: "bytes=0-6" } }).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject()))
            .then((b) => {
              if (new TextDecoder().decode(new Uint8Array(b).slice(0, 7)) !== "PMTiles") return probe(i + 1);
              // under the reference layers above this one (whichever loads first) and the property's own layers
              const above = new Set(REFS.slice(ri + 1).flatMap((o) => mapIds[o.id] || []).concat(ctxIdsAbove(REF_Z)));
              const ownIds = new Set(Object.entries(mapIds).filter(([k]) => !REFS.some((o) => o.id === k) && !CTX.some((o) => o.id === k)).flatMap(([, v]) => v));
              const before = (map.getStyle().layers.find((l) => above.has(l.id) || ownIds.has(l.id)) || {}).id ||
                (map.getLayer("boundary-halo") ? "boundary-halo" : undefined);
              map.addSource(R.src, { type: "vector", url: "pmtiles://" + urls[i], attribution: R.credit });
              addRefLayers(R, before, R.L.visible ? "visible" : "none");
              (mapIds[R.id] || []).forEach((id) => { stackZ[id] = REF_Z + ri * 0.01; });
              const refIds = new Set(REFS.concat(CTX).flatMap((o) => mapIds[o.id] || []));
              const lowest = (map.getStyle().layers.find((l) => refIds.has(l.id)) || {}).id;
              if (map.getLayer("mask") && lowest) map.moveLayer("mask", lowest);     // shading under all reference layers
              R.ready = true;
              const row = root.querySelector(`.rv-ref-row[data-ref="${R.key}"]`), head = root.querySelector(".rv-ref-group");
              if (row) row.hidden = false;
              if (head) head.hidden = false;
            }).catch(() => probe(i + 1));
        };
        probe(0);
      });
    }
    // context layers: each from its own file, once it answers as a PMTiles file; each map layer slotted in by its kind
    function addContext() {
      CTX.forEach((C, ci) => {
        fetch(C.url, { headers: { Range: "bytes=0-6" } }).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject()))
          .then((b) => {
            if (new TextDecoder().decode(new Uint8Array(b).slice(0, 7)) !== "PMTiles") return;
            map.addSource(C.src, { type: "vector", url: "pmtiles://" + C.url, attribution: C.credit });
            const vis = C.L.visible ? "visible" : "none";
            C.layers.forEach((d, j) => {
              const z = CTX_Z[d.type] + ci * 0.001 + j * 0.00001;
              const ownIds = new Set(Object.entries(mapIds).filter(([k]) => !REFS.some((o) => o.id === k) && !CTX.some((o) => o.id === k)).flatMap(([, v]) => v));
              const before = (map.getStyle().layers.find((l) => stackZ[l.id] > z || ownIds.has(l.id)) || {}).id ||
                (map.getLayer("boundary-halo") ? "boundary-halo" : undefined);
              const id = `${C.id}-${j}`;
              const def = Object.assign({ id, type: d.type, source: C.src, "source-layer": C.sourceLayer, paint: d.paint,
                layout: Object.assign({}, d.layout, { visibility: vis }) }, d.filter ? { filter: d.filter } : {},
                d.minzoom !== undefined ? { minzoom: d.minzoom } : {}, d.maxzoom !== undefined ? { maxzoom: d.maxzoom } : {});
              try { map.addLayer(def, before); } catch (e) { return; }      // a definition MapLibre refuses is left out
              if (!map.getLayer(id)) return;
              own(C.L, id); stackZ[id] = z;
            });
            const all = new Set(REFS.concat(CTX).flatMap((o) => mapIds[o.id] || []));
            const lowest = (map.getStyle().layers.find((l) => all.has(l.id)) || {}).id;
            if (map.getLayer("mask") && lowest) map.moveLayer("mask", lowest);     // shading under all of them
            C.ready = true;
            const row = root.querySelector(`.rv-ctx-row[data-ctx="${C.key}"]`), head = root.querySelector(".rv-ctx-group");
            if (row) row.hidden = false;
            if (head) head.hidden = false;
            if (C.L.visible) placeLabels();
          }).catch(() => {});
      });
    }
    let started = false;
    const setup = () => {
      if (started) return;
      started = true;
      // bottom to top
      layers.slice().reverse().forEach((L) => {
        if (L.vector && L.features) return addVector(L);
        if (!L.tiles) return;
        // big imagery comes in pieces (each under 1 GB), each covering part of the area and zooms: draw them all
        rasterParts(L).forEach((P) => {
          const src = { type: "raster", url: "pmtiles://" + url(P.tiles), tileSize: 256, minzoom: P.minzoom };
          if (P.bounds) src.bounds = P.bounds;
          map.addSource(P.id, src);
          map.addLayer({ id: own(L, P.id), type: "raster", source: P.id, minzoom: Math.max(0, P.minzoom - 0.5),
            paint: { "raster-opacity": L.opacity ?? 1, "raster-fade-duration": 0, "raster-resampling": "linear" },
            layout: { visibility: L.visible ? "visible" : "none" } });
        });
      });
      map.addSource("boundary", { type: "geojson", data: url(m.boundary) });
      map.addLayer({ id: "boundary-halo", type: "line", source: "boundary", paint: { "line-color": "#0b1612", "line-width": 5, "line-opacity": 0.45 } });
      map.addLayer({ id: "boundary", type: "line", source: "boundary", paint: { "line-color": "#ffffff", "line-width": 2, "line-dasharray": [3, 2] } });
      if (refWanted) addReference();
      if (CTX.length) addContext();
      if (m.mask) {
        // shade the land outside the property: the whole world with the property cut out of it
        fetch(url(m.boundary)).then((r) => r.json()).then((fc) => {
          map.addSource("mask", { type: "geojson", data: maskOf(fc) });
          // layers that reach past the boundary (roads, rivers: "around_m") stay bright outside it: the shading then goes
          // under all the property's own layers (the rest are cut to the boundary, where the shading has its hole anyway)
          // the property's own layers are cut to the boundary (where the shading has its hole), so the shading can sit
          // under all of them: then reference waterways and layers reaching past the boundary stay bright outside it
          const ownIds = new Set(Object.values(mapIds).flat());
          const lowest = (map.getStyle().layers.find((l) => ownIds.has(l.id)) || {}).id || null;
          map.addLayer({ id: "mask", type: "fill", source: "mask", layout: { visibility: maskOn ? "visible" : "none" },
            paint: { "fill-color": m.mask.color || "#000000", "fill-opacity": Number(m.mask.opacity) || 0.5, "fill-antialias": false } },
          lowest || "boundary-halo");
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
        if (picking || toolMode === "measure") { map.getCanvas().style.cursor = "crosshair"; return; }
        const f = map.queryRenderedFeatures(box(e.point, 6), { layers: targetIds() });
        map.getCanvas().style.cursor = f.length ? "pointer" : "";
      });
      map.on("click", (e) => {
        if (toolMode === "measure") return;           // the measure tool has its own click handler
        if (picking) return pickAt(e);
        const f = map.queryRenderedFeatures(box(e.point, 8), { layers: targetIds() });
        if (!f.length) { clearSelection(); closeSheet(); photoState.leave(); return; }   // away from a photo: back to the overview
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
      const title = featureTitle(L, p, cls);
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
      showDetails(html, lngLat, ctx, photoView(feat, L));
    }

    // ---- a photo with a direction: the map turns to look the way the camera did (as the farm platform does): over the
    // photo's spot, facing its direction, tilted to the camera's angle (or 55°), close in; the spot sits low in the free
    // part of the map so the view ahead has room, and the details go in a card in the corner instead of over that view
    function photoView(feat, L) {
      const p = feat.properties || {}, d = Number(p._dir);
      if (!L || !L.draw || L.draw.type !== "direction" || p._dir == null || !Number.isFinite(d) || feat.geometry.type !== "Point") return null;
      const tilt = p._pitch != null && p._pitch !== "" && Number.isFinite(Number(p._pitch)) ? Number(p._pitch) : 55;
      return { center: feat.geometry.coordinates, bearing: ((d % 360) + 360) % 360,
               pitch: Math.max(0, Math.min(tilt, map.getMaxPitch())), zoom: Math.min(Math.max(map.getZoom(), 17), 18.5) };
    }
    function lookFrom(view) {
      const c = map.getContainer().getBoundingClientRect(), W = c.width, H = c.height;
      let x0 = 0, x1 = W, y0 = 0, y1 = H;
      if (narrow()) {
        const sr = sheet.hidden ? null : sheet.getBoundingClientRect();
        if (sr && sr.top > c.top) y1 = Math.min(H, sr.top - c.top);
        y0 = 50;
      } else {
        const pr = panel.getBoundingClientRect();
        if (!panel.classList.contains("collapsed")) x0 = Math.max(0, pr.right - c.left);
        x1 = W - 56;                                          // the zoom and 3D buttons
        if (x1 - 380 - x0 > 260) x1 -= 380;                   // the photo's card, top right
      }
      const x = (x0 + x1) / 2, y = y0 + (y1 - y0) * 0.78;
      const still = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      map.easeTo({ ...view, offset: [x - W / 2, y - H / 2], duration: still ? 0 : 1300, essential: true, freezeElevation: true });
    }
    // With the hills on, the camera's height is measured from the ground where it looks. Just after 3D is switched on that
    // ground is not known until its elevation tile arrives (MapLibre says sea level), so wait for it, briefly, then stand there.
    function onGround(at, go) {
      if (!map.getTerrain()) return go();
      let done = false, timer = null;
      const run = (force) => {
        if (done) return;
        const g = map.queryTerrainElevation(at);
        if (!g && force !== true) return;
        done = true; clearTimeout(timer); map.off("data", run);
        if (g) map.jumpTo({ elevation: g });
        go();
      };
      map.on("data", run);
      timer = setTimeout(() => run(true), 2500);
      run();
    }
    const photoState = photoViewState({
      get: () => ({ center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() }),
      threeD: () => threeD,
      setThreeD: (on) => { setThreeD(on, true); if (!photoState.active()) storeSet("rv-3d", on ? "1" : ""); },   // the way back is saved
      look: (view) => onGround(view.center, () => lookFrom(view)),
      move: (camera) => {
        const still = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        map.easeTo({ ...camera, duration: still ? 0 : 900, essential: true, freezeElevation: true });
      },
      whole: () => map.fitBounds(m.bounds, wholeView(pad())),
    });
    // the details card for a photo view: fixed in the top right corner, styled like a popup, without a pointer
    function floatCard(html) {
      const box = el("div", { class: "rv-floatpop" });
      box.innerHTML = `<div class="maplibregl-popup-content"><button type="button" class="maplibregl-popup-close-button" aria-label="Close popup">×</button>${html}</div>`;
      mapEl.appendChild(box);
      const card = { remove: () => box.remove(), getElement: () => box };
      box.querySelector(".maplibregl-popup-close-button").addEventListener("click", () => { if (popup === card) popup = null; card.remove(); select(null); photoState.leave(); });
      return card;
    }
    function showDetails(html, lngLat, ctx, view) {
      if (popup) { popup.remove(); popup = null; }
      if (narrow()) {
        const body = openSheet(html);
        wire(body, ctx);
        if (view) requestAnimationFrame(() => photoState.enter(view)); else photoState.leave();
      } else if (view) {
        closeSheet();
        popup = floatCard(html);
        wire(popup.getElement(), ctx);
        photoState.enter(view);
      } else {
        closeSheet();
        const backing = photoState.leave();           // something else picked: back out of a photo's view first
        popup =new maplibregl.Popup({ maxWidth: "340px", offset: 12 }).setLngLat(lngLat).setHTML(html).addTo(map);
        popup.on("close", () => { select(null); popup = null; });
        wire(popup.getElement(), ctx);
        // keep the whole popup on screen (photos make it tall)
        const fitPopup = () => {
          if (!popup || backing) return;              // a pan now would stop the way back
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
    sheet.querySelector(".rv-sheet-close").addEventListener("click", () => { closeSheet(); clearSelection(); cancelPick(); photoState.leave(); });
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
      lb.innerHTML = `<img alt="Photo" src="${esc(src)}"><button class="rv-lightbox-close" type="button" aria-label="Close photo"><span aria-hidden="true">×</span>Close</button>`;
      lightboxWire(lb, document);
      // on the page itself, not inside the viewer: a page that holds the viewer under its own header (the farm platform)
      // would otherwise draw that header over the close button
      document.body.appendChild(lb);
      lb.querySelector(".rv-lightbox-close").focus();
    }

    // ---------------------------------------------------------------- suggestions
    let picking = false, marker = null, suggOn = true;
    const banner = el("div", { class: "rv-banner", hidden: "" });
    banner.innerHTML = `<span>Tap the spot, or the thing on the map, your suggestion is about</span><button type="button" class="rv-btn">Cancel</button>`;
    root.appendChild(banner);
    banner.querySelector("button").addEventListener("click", cancelPick);

    function startPick() {
      endTool();                                  // a tool and picking a spot don't mix
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
    REFS.forEach((R) => labelLayers.push(R.L));          // last: the property's own labels win
    CTX.forEach((C) => { if (C.labels) labelLayers.push(C.L); });
    let labelsOn = true;
    const labelBox = el("div", { class: "rv-labels", "aria-hidden": "true" });
    mapEl.insertBefore(labelBox, mapEl.querySelector(".maplibregl-control-container"));   // under controls and popups
    const labelData = {};                                   // layer id -> [{text, type, coords, bbox}]
    const layerOn = (L) => { const c = root.querySelector("#rv-l-" + L.id); return c ? c.checked : L.visible; };
    let placed = [];
    let printing = false;                                   // laying the map out for print: no panel or sheet to avoid
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
        const lines = {};                                   // text -> [coords]: joined up below
        (fc.features || []).forEach((f) => { try {
          const t = f.properties && f.properties._lbl;
          if (!t || !f.geometry) return;
          let parts = flat(f.geometry, []).filter((pt) => ["Polygon", "Line", "Point"].includes(pt.type));
          if (areaLayer || parts.some((pt) => pt.type === "Polygon")) parts = parts.filter((pt) => pt.type === "Polygon");
          parts.forEach((pt) => {
            if (pt.type === "Line") { (lines[t] = lines[t] || []).push(pt.c); return; }
            const it = { text: t, type: pt.type, bbox: bboxOf(pt.c), coords: pt.c };
            if (pt.type === "Polygon") { it.raw = pt.c; it.coords = outlineAt(it, 15); }   // 3D uses a ~3 m outline
            labelData[L.id].push(it);
          });
        } catch (e) { /* one odd shape never stops the rest being labelled */ } });
        // a road or river comes in many short sections (Topo50 cuts them at every junction): sections with the same name
        // that meet are joined into one line, so the name has room to be written along it
        Object.entries(lines).forEach(([t, parts]) => joinLines(parts).forEach((c) => {
          const thinned = c.length <= 420 ? c : c.filter((_, i) => i % Math.ceil(c.length / 400) === 0 || i === c.length - 1);
          labelData[L.id].push({ text: t, type: "Line", bbox: bboxOf(c), coords: thinned });
        }));
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
    // join line pieces that share an end into longer lines (greedy; where three meet, as braids do, any one continues)
    function joinLines(parts) {
      const key = (p) => p[0].toFixed(6) + "," + p[1].toFixed(6), ends = {};
      parts.forEach((c, i) => { if (c.length < 2) return; [key(c[0]), key(c[c.length - 1])].forEach((k) => (ends[k] = ends[k] || []).push(i)); });
      const used = new Array(parts.length).fill(false), out = [];
      const next = (k) => (ends[k] || []).find((j) => !used[j]);
      parts.forEach((c, i) => {
        if (used[i] || c.length < 2) return;
        used[i] = true;
        let line = c.slice();
        for (let j = next(key(line[line.length - 1])); j !== undefined; j = next(key(line[line.length - 1]))) {
          used[j] = true; const d = parts[j];
          line = line.concat((key(d[0]) === key(line[line.length - 1]) ? d : d.slice().reverse()).slice(1));
        }
        for (let j = next(key(line[0])); j !== undefined; j = next(key(line[0]))) {
          used[j] = true; const d = parts[j];
          line = (key(d[d.length - 1]) === key(line[0]) ? d : d.slice().reverse()).slice(0, -1).concat(line);
        }
        out.push(line);
      });
      return out;
    }
    // the parts of a screen polyline inside the box [x0, y0, x1, y1], each a list of points (segments are cut at the edge)
    function runsOf(pts, x0, y0, x1, y1) {
      const runs = []; let cur = null;
      for (let i = 1; i < pts.length; i++) {
        const [ax, ay] = pts[i - 1], [bx, by] = pts[i], dx = bx - ax, dy = by - ay;
        let t0 = 0, t1 = 1, ok = true;
        [[-dx, ax - x0], [dx, x1 - ax], [-dy, ay - y0], [dy, y1 - ay]].forEach(([p, q]) => {
          if (!ok) return;
          if (p === 0) { if (q < 0) ok = false; return; }
          const r = q / p;
          if (p < 0) { if (r > t1) ok = false; else if (r > t0) t0 = r; } else { if (r < t0) ok = false; else if (r < t1) t1 = r; }
        });
        if (!ok) { cur = null; continue; }
        const a = [ax + t0 * dx, ay + t0 * dy], b = [ax + t1 * dx, ay + t1 * dy];
        if (cur && t0 === 0) cur.push(b); else { cur = [a, b]; runs.push(cur); }
        if (t1 < 1) cur = null;
      }
      return runs;
    }
    // a straight-enough stretch of a run, the label's width long, centred near distance s along it: where the label
    // goes and its angle (degrees, kept upright), or null where the line bends too much there
    function alongLine(run, cum, s, tw, th) {
      const len = cum[cum.length - 1];
      const at = (d) => { let i = 1; while (i < cum.length - 1 && cum[i] < d) i++;
        const seg = cum[i] - cum[i - 1] || 1, k = (d - cum[i - 1]) / seg;
        return [run[i - 1][0] + k * (run[i][0] - run[i - 1][0]), run[i - 1][1] + k * (run[i][1] - run[i - 1][1])]; };
      for (const shift of [0, 0.3, -0.3, 0.6, -0.6, 0.9, -0.9]) {
        const c = s + shift * tw, d0 = c - tw / 2, d1 = c + tw / 2;
        if (d0 < 0 || d1 > len) continue;
        const a = at(d0), b = at(d1), dx = b[0] - a[0], dy = b[1] - a[1], chord = Math.hypot(dx, dy) || 1;
        let bend = 0;
        for (let i = 1; i < run.length - 1; i++) {
          if (cum[i] <= d0 || cum[i] >= d1) continue;
          bend = Math.max(bend, Math.abs((run[i][0] - a[0]) * dy - (run[i][1] - a[1]) * dx) / chord);
        }
        if (bend > th * 0.5 || chord < tw * 0.85) continue;
        let ang = (Math.atan2(dy, dx) * 180) / Math.PI;
        if (ang > 90) ang -= 180; else if (ang <= -90) ang += 180;
        return { at: at(c), ang };
      }
      return null;
    }
    // label boxes, turned or not: { cx, cy, hw, hh, ang (degrees) }; overlap by separating axes
    function corners(o) {
      const r = (o.ang * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
      return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => [o.cx + u * o.hw * c - v * o.hh * s, o.cy + u * o.hw * s + v * o.hh * c]);
    }
    function overlaps(a, b) {
      if (Math.hypot(a.cx - b.cx, a.cy - b.cy) > Math.hypot(a.hw, a.hh) + Math.hypot(b.hw, b.hh)) return false;
      const ca = corners(a), cb = corners(b);
      for (const o of [a, b]) {
        const r = (o.ang * Math.PI) / 180;
        for (const [ux, uy] of [[Math.cos(r), Math.sin(r)], [-Math.sin(r), Math.cos(r)]]) {
          const pa = ca.map(([x, y]) => x * ux + y * uy), pb = cb.map(([x, y]) => x * ux + y * uy);
          if (Math.max(...pa) < Math.min(...pb) || Math.max(...pb) < Math.min(...pa)) return false;
        }
      }
      return true;
    }
    const LINE_REPEAT = 450;                                // a long road or river is named again about every 450 px
    const SAME_GAP = 300;                                   // ... but never within 300 px of the same name (braided rivers)
    const AREA_GAP = 640;                                   // a context area, drawn in tile pieces, is named once in about this much
    const POINT_GAP = 160;                                  // and points of the same name close together (a town's bores) once
    const REPEAT = 340;                                     // big areas show their label again about every 340 px
    function placeLabels() {
      const t0 = performance.now();
      try { placeLabelsNow(); } finally { RCLViewer.stats.labelsMs = Math.round(performance.now() - t0); }
    }
    // names along the reference layers (river names; road names and "SH 1"), from the tiles already loaded for this view
    function refLabels() {
      const z = map.getZoom();
      REFS.forEach((R) => {
        labelData[R.id] = [];
        if (!R.ready || !layerOn(R.L) || z < R.labelFrom) return;
        const by = {}, seenPart = new Set();
        R.labelLayers.forEach((sl) => map.querySourceFeatures(R.src, { sourceLayer: sl }).forEach((f) => {
          const t = f.properties && R.labelText(f.properties, z), g = f.geometry;
          if (!t || !g) return;
          (g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : []).forEach((c) => {
            if (c.length < 2) return;
            const k = t + c[0].join() + c[c.length - 1].join();
            if (seenPart.has(k)) return;                        // the same piece from a neighbouring tile
            seenPart.add(k); (by[t] = by[t] || []).push(c);
          });
        }));
        const out = [];
        Object.entries(by).forEach(([t, parts]) => joinLines(parts).forEach((c) => {
          const bb = bboxOf(c);
          out.push({ text: t, type: "Line", bbox: bb, coords: c.length <= 300 ? c : c.filter((_, i) => i % Math.ceil(c.length / 280) === 0 || i === c.length - 1),
            size: (bb[2] - bb[0]) + (bb[3] - bb[1]) });
        }));
        labelData[R.id] = out.sort((a, b) => b.size - a.size).slice(0, 200);   // the longest first, enough for one screen
      });
    }
    // names on the context layers that are on, from the tiles already loaded for this view: areas (a piece per tile, the
    // same name never written twice close together), lines joined up by name, points
    function ctxLabels() {
      const z = map.getZoom();
      CTX.forEach((C) => {
        if (!C.labels) return;
        labelData[C.id] = [];
        if (!C.ready || !layerOn(C.L) || z < C.labels.minzoom - 0.25) return;
        const out = [], lines = {}, seenPart = new Set();
        if (C.labels.sourceLayer) {
          // CL3: one point per area (the build's <key>-labels): named once, centred; a point a tile repeats (its edge) once
          map.querySourceFeatures(C.src, { sourceLayer: C.labels.sourceLayer }).forEach((f) => {
            const p = f.properties || {}, g = f.geometry;
            let t = contextText(C.labels.text, p);
            if (!t || !g || g.type !== "Point") return;
            if (C.labels.upper) t = t.toUpperCase();
            const c = g.coordinates, k = t + "|" + c[0].toFixed(3) + "," + c[1].toFixed(3);
            if (seenPart.has(k)) return;
            seenPart.add(k);
            out.push({ text: t, type: "Point", bbox: [c[0], c[1], c[0], c[1]], coords: c, near: "area",
              r: typeof p.label_r === "number" ? p.label_r : null, color: colourFor(C.labels.colorBy, p) });
          });
          out.sort((a, b) => (b.r || 0) - (a.r || 0));
          // a big area whose point is out of sight (a zone seen close up) is named once, on the roomiest part of it in view
          const vb = map.getBounds(), w = vb.getWest(), s = vb.getSouth(), e = vb.getEast(), n = vb.getNorth();
          const pr = panel.getBoundingClientRect(), mr = mapEl.getBoundingClientRect();
          const left = !printing && !narrow() && !panel.classList.contains("collapsed") ? Math.max(0, pr.right - mr.left) : 0;
          const shown = new Set(out.filter((o) => { const q = map.project(o.coords); return q.x >= left && q.x <= mapEl.clientWidth && q.y >= 0 && q.y <= mapEl.clientHeight; })
            .map((o) => o.text));
          const best = {};
          map.querySourceFeatures(C.src, { sourceLayer: C.sourceLayer }).forEach((f) => {
            const p = f.properties || {}, g = f.geometry;
            let t = contextText(C.labels.text, p);
            if (!t || !g || !/Polygon$/.test(g.type)) return;
            if (C.labels.upper) t = t.toUpperCase();
            if (shown.has(t)) return;
            (g.type === "Polygon" ? [g.coordinates] : g.coordinates).forEach((c) => {
              if (!c[0] || c[0].length < 4) return;
              const bb = bboxOf(c), seen = Math.max(0, Math.min(bb[2], e) - Math.max(bb[0], w)) * Math.max(0, Math.min(bb[3], n) - Math.max(bb[1], s));
              if (seen > 0 && (!best[t] || seen > best[t].seen)) best[t] = { text: t, type: "Polygon", bbox: bb, raw: c, coords: c, near: true, once: true, seen,
                color: colourFor(C.labels.colorBy, p) };
            });
          });
          labelData[C.id] = out.slice(0, 300).concat(Object.values(best));
          return;
        }
        map.querySourceFeatures(C.src, { sourceLayer: C.sourceLayer }).forEach((f) => {
          const t = contextText(C.labels.text, f.properties || {}), g = f.geometry;
          if (!t || !g) return;
          const parts = /^Multi/.test(g.type) ? g.coordinates.map((c) => [g.type.slice(5), c]) : [[g.type, g.coordinates]];
          parts.forEach(([type, c]) => {
            const k = t + type + JSON.stringify(type === "Point" ? c : type === "Polygon" ? [c[0][0], c[0].length] : [c[0], c[c.length - 1]]);
            if (seenPart.has(k)) return;                          // the same piece from a neighbouring tile
            seenPart.add(k);
            if (type === "Polygon" && c[0] && c[0].length > 3) out.push({ text: t, type: "Polygon", bbox: bboxOf(c), raw: c, coords: c, near: true });
            else if (type === "LineString" && c.length > 1) (lines[t] = lines[t] || []).push(c);
            else if (type === "Point") out.push({ text: t, type: "Point", bbox: [c[0], c[1], c[0], c[1]], coords: c, near: "point" });
          });
        });
        Object.entries(lines).forEach(([t, ps]) => joinLines(ps).forEach((c) => {
          const bb = bboxOf(c);
          out.push({ text: t, type: "Line", bbox: bb, coords: c.length <= 300 ? c : c.filter((_, i) => i % Math.ceil(c.length / 280) === 0 || i === c.length - 1) });
        }));
        const size = (f) => (f.bbox[2] - f.bbox[0]) + (f.bbox[3] - f.bbox[1]);
        labelData[C.id] = out.sort((a, b) => size(b) - size(a)).slice(0, 300);
      });
    }
    let refTimer = null;
    map.on("sourcedata", (e) => {
      if (!REFS.concat(CTX).some((R) => R.src === e.sourceId) || !e.tile) return;
      clearTimeout(refTimer); refTimer = setTimeout(placeLabels, 350);
    });
    function placeLabelsNow() {
      refLabels();
      ctxLabels();
      labelBox.innerHTML = ""; placed = [];
      if (!labelsOn || !labelLayers.length) return;
      const z = map.getZoom(), b = map.getBounds(), W = mapEl.clientWidth, H = mapEl.clientHeight;
      const pr = panel.getBoundingClientRect(), mr = mapEl.getBoundingClientRect();
      const left = !printing && !narrow() && !panel.classList.contains("collapsed") ? Math.max(0, pr.right - mr.left) : 0;
      const peek = !printing && narrow() ? parseFloat(getComputedStyle(root).getPropertyValue("--peek")) || 0 : 0;   // phone: under the sheet
      const x0 = left + 4, y0 = 4, x1 = W - 4, y1 = H - peek - 4;
      const cands = [], terrain3d = !!map.getTerrain();
      labelLayers.forEach((L, order) => {
        const st = L.labels || {};
        if (!layerOn(L) || !labelData[L.id] || z < (st.minzoom ?? L.visible_from ?? 0) - 0.25 || (st.maxzoom && z > st.maxzoom)) return;
        const size = st.size || 12;
        labelData[L.id].forEach((f) => {
          if (f.bbox[2] < b.getWest() || f.bbox[0] > b.getEast() || f.bbox[3] < b.getSouth() || f.bbox[1] > b.getNorth()) return;
          let tw = f.text.length * size * 0.58 + 6, th = size * 1.3;
          if (st.upper || st.spacing) tw = f.text.length * size * ((st.upper ? 0.7 : 0.58) + (st.spacing || 0)) + 6;
          if (st.padding) { tw += st.padding * 2; th += st.padding * 2; }        // room kept clear around it
          let at = null, weight = 0, alts = null;
          if (f.near === "area") {
            // an area's one label point: centred on it, and only where the area is big enough on screen to hold its name
            const q = map.project(f.coords);
            if (q.x < x0 || q.x > x1 || q.y < y0 || q.y > y1) return;
            if (f.r != null) {
              const mpp = (40075016.686 * Math.cos((f.coords[1] * Math.PI) / 180)) / (512 * Math.pow(2, z));
              if (f.r / mpp < size * 0.55) return;
            }
            cands.push({ L, f, at: [q.x, q.y], alts: null, tw, th, weight: f.r || 0, st, order });
            return;
          }
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
            if (!f.once && Math.max(Mx - mx, My - my) > REPEAT * 0.9) {     // long or big on screen (an area named once: not again)
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
            // along the line, turned to follow it: each visible stretch named at its middle, long ones again every ~450 px
            const scr = f.coords.map((p) => { const q = map.project(p); return [q.x, q.y]; });
            runsOf(scr, x0, y0, x1, y1).forEach((run) => {
              const cum = [0];
              for (let i = 1; i < run.length; i++) cum.push(cum[i - 1] + Math.hypot(run[i][0] - run[i - 1][0], run[i][1] - run[i - 1][1]));
              const len = cum[cum.length - 1];
              if (len < tw + 4) return;
              const spots = [len / 2];
              const rep = st.repeat || LINE_REPEAT;               // a context layer's "symbol-spacing" names it less often
              for (let d = len / 2 + rep; d < len - tw / 2; d += rep) spots.push(d);
              for (let d = len / 2 - rep; d > tw / 2; d -= rep) spots.push(d);
              spots.forEach((d, k) => {
                const fit = alongLine(run, cum, d, tw, th);
                if (fit) cands.push({ L, f, at: fit.at, ang: fit.ang, alts: null, tw, th, weight: len, st, order, again: k > 0, line: true });
              });
            });
            return;
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
      const free = (o) => corners(o).every(([x, y]) => x >= x0 && x <= x1 && y >= y0 && y <= y1)
        && !placed.some((p) => overlaps(o, p.box));
      const sameName = {};                                  // layer + name -> where it is already written (lines)
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
        const nameKey = c.L.id + "\u0000" + c.f.text;
        const apart = c.line || c.f.near;
        if (apart && (sameName[nameKey] || []).some((q) => Math.hypot(q[0] - c.at[0], q[1] - c.at[1]) < (c.f.near === "point" ? POINT_GAP : c.f.near ? AREA_GAP : Math.max(SAME_GAP, (c.st.repeat || 0) * 0.7)))) return;
        let box = null;
        for (const at of c.alts || [c.at]) {
          const b2 = { cx: at[0], cy: at[1], hw: c.tw / 2, hh: c.th / 2, ang: c.ang || 0 };
          if (free(b2) && seen(c, at)) { box = b2; c.at = at; break; }
        }
        if (!box) return;
        if (apart) (sameName[nameKey] = sameName[nameKey] || []).push(c.at);
        const e = document.createElement("span");
        e.className = "rv-label";
        e.textContent = c.f.text;
        const hex = (v) => (/^#[0-9a-f]{3,8}$/i.test(String(v || "")) ? v : null);     // colours from the package: hex only
        const colour = hex(c.f.color) || hex(c.st.color);                        // a context label may take its area's own hue
        const halo = hex(c.st.halo) || (colour && parseInt(colour.slice(1, 3), 16) > 160 ? "#000000" : "#ffffff");
        e.style.cssText = `font-size:${Math.min(Math.max(+c.st.size || 12, 6), 48)}px;color:${colour || "#1b1b1b"};font-weight:${c.st.bold ? 700 : 600};`
          + `${c.st.italic ? "font-style:italic;" : ""}text-shadow:0 0 2px ${halo},0 0 2px ${halo},0 0 3px ${halo},0 0 4px ${halo};`
          + (c.st.spacing ? `letter-spacing:${c.st.spacing}em;` : "");
        e.style.transform = `translate(${c.at[0]}px,${c.at[1]}px) translate(-50%,-50%)` + (c.ang ? ` rotate(${c.ang.toFixed(1)}deg)` : "");
        labelBox.appendChild(e);
        placed.push({ box, e, lnglat: map.unproject(c.at), ang: c.ang || 0, bearing: map.getBearing(),
          text: c.f.text, at: c.at.slice(), colour: colour || "#1b1b1b", halo, size: Math.min(Math.max(+c.st.size || 12, 6), 48),
          bold: !!c.st.bold, italic: !!c.st.italic, spacing: c.st.spacing || 0 });
      });
    }
    // while the map moves, labels move with it; once it stops they're placed again for what's on screen
    map.on("move", () => {
      const brg = map.getBearing();
      placed.forEach((p) => {
        const q = map.project(p.lnglat), a = p.ang ? p.ang - (brg - p.bearing) : 0;
        p.e.style.transform = `translate(${q.x}px,${q.y}px) translate(-50%,-50%)` + (a ? ` rotate(${a.toFixed(1)}deg)` : "");
      });
    });
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
        ${sharedMissing.length ? `<p class="rv-shared-note" role="status">Not shown on this map: ${esc(sharedMissing.join(", "))} (not available just now).</p>` : ""}
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
      const cid = "rv-l-" + String(L.id).replace(/[^a-z0-9_-]/gi, "");
      const count = `<span class="rv-count">${esc(L.feature_count || "")}</span>`;
      const rivals = L.exclusive ? layers.filter((o) => o !== L && o.exclusive && o.group === L.group).map((o) => o.title) : [];
      if (rivals.length) row.title = "Switching this on switches off " + rivals.join(", ");
      row.innerHTML = `<div class="rv-layer-row"><label for="${cid}"><input id="${cid}" class="rv-switch" type="checkbox" ${L.visible ? "checked" : ""}><span>${esc(L.title)}</span></label>${count}</div>`;
      let legend = L.legend || [];
      if (L.draw) {
        legend = drawLegend(L).map((g) => ({ label: g.label, src: legendIcon(g.color, L.draw.type === "direction") }));
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
      if (op) op.addEventListener("input", (e) => rasterParts(L).forEach((P) => map.getLayer(P.id) && map.setPaintProperty(P.id, "raster-opacity", e.target.value / 100)));
    });

    if (refWanted) {
      body.appendChild(el("div", { class: "rv-group rv-ref-group", hidden: "" }, "Reference"));
      REFS.slice().reverse().forEach((R) => {                // top first, like the map's own layers
        const row = el("div", { class: "rv-layer rv-ref-row" + (R.L.visible ? "" : " off"), hidden: "" });
        row.dataset.ref = R.key;
        row.innerHTML = `<div class="rv-layer-row"><label for="rv-l-${R.id}"><input id="rv-l-${R.id}" class="rv-switch" type="checkbox" ${R.L.visible ? "checked" : ""}><span>${esc(R.title)}</span></label><span class="rv-count"></span></div>
          <ul class="rv-legend">${R.classes.map(([, label, c, w, o]) => `<li><img alt="" src="${lineIcon(c, w, o)}"><span>${esc(label)}</span></li>`).join("")}</ul>
          <div class="rv-ref-note">${esc(R.credit)}</div>`;
        row.dataset.from = 0; row.dataset.count = "";
        body.appendChild(row);
        row.querySelector("input").addEventListener("change", (e) => {
          const on = e.target.checked;
          R.L.visible = on; storeSet(R.store, on ? "1" : "0");
          row.classList.toggle("off", !on);
          (mapIds[R.id] || []).forEach((id) => map.getLayer(id) && map.setLayoutProperty(id, "visibility", on ? "visible" : "none"));
          placeLabels();
        });
      });
    }
    if (CTX.length) {
      body.appendChild(el("div", { class: "rv-group rv-ctx-group", hidden: "" }, "Context layers"));
      CTX.forEach((C) => {                                    // in the order given
        const row = el("div", { class: "rv-layer rv-ctx-row" + (C.L.visible ? "" : " off"), hidden: "" });
        row.dataset.ctx = C.key;
        const one = C.legend.length === 1 ? `<img alt="" src="${contextIcon(C.legend[0])}" style="width:20px;height:20px">` : "";
        row.innerHTML = `<div class="rv-layer-row"><label for="rv-l-${C.id}"><input id="rv-l-${C.id}" class="rv-switch" type="checkbox" ${C.L.visible ? "checked" : ""}>${one}<span>${esc(C.title)}</span></label><span class="rv-count"></span></div>`
          + (C.legend.length > 1 ? `<ul class="rv-legend">${C.legend.map((g) => `<li><img alt="" src="${contextIcon(g)}"><span>${esc(g.label)}</span></li>`).join("")}</ul>` : "")
          + (C.note ? `<div class="rv-ref-note">${esc(C.note)}</div>` : "")
          + (C.credit ? `<div class="rv-ref-note">${esc(C.credit)}</div>` : "");
        row.dataset.from = 0; row.dataset.count = "";
        body.appendChild(row);
        row.querySelector("input").addEventListener("change", (e) => {
          const on = e.target.checked;
          C.L.visible = on; storeSet(C.store, on ? "1" : "0");
          row.classList.toggle("off", !on);
          (mapIds[C.id] || []).forEach((id) => map.getLayer(id) && map.setLayoutProperty(id, "visibility", on ? "visible" : "none"));
          placeLabels();
        });
      });
    }
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
    fit.addEventListener("click", () => {
      if (photoState.end()) clearSelection();      // out of a photo's view, its card closed, 3D as the person had it
      map.fitBounds(m.bounds, wholeView(pad()));
    });
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

    // ---------------------------------------------------------------- tools: compare (swipe), measure, print
    const tools = el("div", { class: "maplibregl-ctrl maplibregl-ctrl-group rv-tools" });
    const ICONS = {
      compare: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2.5" y="3.5" width="15" height="13" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 2v16" stroke="currentColor" stroke-width="1.8"/><path d="M2.5 5 9 5 9 15 2.5 15Z" fill="currentColor" opacity=".35"/></svg>',
      measure: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2.5 13.5 13.5 2.5l4 4-11 11z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M6 10l1.6 1.6M8.5 7.5l1.6 1.6M11 5l1.6 1.6" stroke="currentColor" stroke-width="1.4"/></svg>',
      print: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.5 7V2.5h9V7" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="2.5" y="7" width="15" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M5.5 11.5h9v6h-9z" fill="var(--btnbg, #fff)" stroke="currentColor" stroke-width="1.6"/></svg>',
    };
    const toolBtn = (key, title) => {
      const b = el("button", { type: "button", "aria-pressed": "false", title, "aria-label": title });
      b.innerHTML = ICONS[key];
      tools.appendChild(b);
      return b;
    };
    const rasters = layers.filter((L) => L.tiles);
    const btnCompare = rasters.length >= 2 ? toolBtn("compare", "Compare two layers side by side (drag the divider)") : null;
    const btnMeasure = toolBtn("measure", "Measure a distance or an area");
    const btnPrint = toolBtn("print", "Print this view, or save it as a PDF");
    map.addControl({ onAdd: () => tools, onRemove: () => tools.remove() }, "top-right");
    let stopTool = null;                           // ends whichever tool is running
    const startTool = (name, start) => {
      if (stopTool) stopTool();
      if (picking) cancelPick();
      stopTool = start();
      toolMode = name;
    };
    const endTool = () => { if (stopTool) { const f = stopTool; stopTool = null; toolMode = null; f(); } };
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && stopTool) endTool(); });

    // ---- compare: a second map with the right-hand layer, over this one, cut off left of the divider
    const isOn = (L) => (mapIds[L.id] || []).some((id) => map.getLayer(id) && map.getLayoutProperty(id, "visibility") !== "none");
    const yearOf = (L) => { const y = String(L.title || "").match(/\b(19|20)\d{2}\b/); return y ? Number(y[0]) : null; };
    function compareDefaults() {
      const pool = rasters.filter((L) => L.kind === "imagery").length >= 2 ? rasters.filter((L) => L.kind === "imagery") : rasters;
      const dated = pool.filter((L) => yearOf(L) != null).sort((a, b) => yearOf(a) - yearOf(b));
      if (dated.length >= 2) return [dated[0], dated[dated.length - 1]];          // earliest left, latest right
      return [pool[1], pool[0]];                                                 // QGIS order: top layer on the right
    }
    function startCompare() {
      photoState.end();
      if (threeD) setThreeD(false);
      clearSelection(); closeSheet();
      let [left, right] = compareDefaults();
      const before = Object.fromEntries(rasters.map((L) => [L.id, isOn(L)]));
      const cmpEl = el("div", { class: "rv-compare-map", "aria-hidden": "true" });
      mapEl.insertBefore(cmpEl, labelBox);
      // the overlay is a copy of this map (same basemap, layers, labels' lines, photos) with the right-hand layer
      // shown instead of the left-hand one; it follows every change made here
      const tIds = (L) => (mapIds[L.id] || []).filter((id) => id.startsWith("t-"));
      const overlayStyle = () => {
        const st = JSON.parse(JSON.stringify(map.getStyle()));
        delete st.terrain;
        const leftIds = new Set(tIds(left)), rightIds = new Set(tIds(right));
        st.layers = st.layers.filter((l) => l.id !== "hillshade").map((l) => {
          if (leftIds.has(l.id)) l.layout = Object.assign({}, l.layout, { visibility: "none" });
          if (rightIds.has(l.id)) l.layout = Object.assign({}, l.layout, { visibility: "visible" });
          return l;
        });
        delete st.sources.dem; delete st.sources["dem-shade"];
        return st;
      };
      const cmp = new maplibregl.Map({ container: cmpEl, style: overlayStyle(), interactive: false, attributionControl: false,
        center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch(), maxZoom: 22, maxPitch: 75 });
      cmp.on("styleimagemissing", (e) => {                 // photo cones are drawn images: make them again here
        const mm = /^cone-(.+)-(\d+)$/.exec(e.id);
        const L = mm && layers.find((x) => x.id === mm[1]);
        if (!L || !L.draw || cmp.hasImage(e.id)) return;
        const c = (L.draw.colors && L.draw.colors[Number(mm[2])]) || "#e8590c";
        cmp.addImage(e.id, coneCanvas(c, 128).getContext("2d").getImageData(0, 0, 128, 128), { pixelRatio: 2 });
      });
      const sync = () => cmp.jumpTo({ center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch(), padding: map.getPadding() });
      map.on("move", sync);
      let restyle = 0;
      const follow = () => { clearTimeout(restyle); restyle = setTimeout(() => cmp.setStyle(overlayStyle()), 60); };
      map.on("styledata", follow);
      const onResize = () => { cmp.resize(); sync(); place(divX); };
      window.addEventListener("resize", onResize);
      const showRight = follow;
      const showLeft = () => rasters.forEach((L) => switches[L.id] && switches[L.id](L === left || (L !== right && before[L.id] && L.kind !== "imagery")));
      // the bar: pick the two layers
      const opt = (sel) => rasters.map((L) => `<option value="${esc(L.id)}"${L === sel ? " selected" : ""}>${esc(L.title)}</option>`).join("");
      const bar = el("div", { class: "rv-toolbar rv-compare-bar", role: "group", "aria-label": "Compare layers" });
      bar.innerHTML = `<label><span>Left</span><select class="rv-cmp-left">${opt(left)}</select></label>`
        + `<label><span>Right</span><select class="rv-cmp-right">${opt(right)}</select></label>`
        + `<button type="button" class="rv-btn rv-tool-done">Done</button>`;
      root.appendChild(bar);
      const byId = (id) => rasters.find((L) => L.id === id);
      bar.querySelector(".rv-cmp-left").addEventListener("change", (e) => { left = byId(e.target.value); showLeft(); });
      bar.querySelector(".rv-cmp-right").addEventListener("change", (e) => { right = byId(e.target.value); showLeft(); showRight(); });
      bar.querySelector(".rv-tool-done").addEventListener("click", endTool);
      // the divider
      const divider = el("div", { class: "rv-divider", role: "slider", tabindex: "0", "aria-label": "Divider between the two layers",
        "aria-valuemin": "0", "aria-valuemax": "100" });
      divider.innerHTML = '<span class="rv-divider-handle" aria-hidden="true">‹ ›</span>';
      root.appendChild(divider);
      let divX = 0;
      const place = (x) => {
        const w = root.clientWidth;
        divX = Math.max(0, Math.min(w, x));
        cmpEl.style.clipPath = `inset(0 0 0 ${divX}px)`;
        divider.style.left = divX + "px";
        divider.setAttribute("aria-valuenow", String(Math.round((100 * divX) / Math.max(w, 1))));
      };
      const panelRight = () => (narrow() ? 0 : panel.getBoundingClientRect().right - root.getBoundingClientRect().left);
      place((panelRight() + root.clientWidth) / 2);
      divider.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        divider.setPointerCapture(e.pointerId);
        const left0 = root.getBoundingClientRect().left;
        const mv = (ev) => place(ev.clientX - left0);
        const up = () => { divider.removeEventListener("pointermove", mv); divider.removeEventListener("pointerup", up); divider.removeEventListener("pointercancel", up); };
        divider.addEventListener("pointermove", mv);
        divider.addEventListener("pointerup", up);
        divider.addEventListener("pointercancel", up);
      });
      divider.addEventListener("keydown", (e) => {
        const step = e.shiftKey ? 60 : 15;
        if (e.key === "ArrowLeft") { place(divX - step); e.preventDefault(); }
        if (e.key === "ArrowRight") { place(divX + step); e.preventDefault(); }
      });
      root.classList.add("rv-comparing");
      btnCompare.setAttribute("aria-pressed", "true");
      showLeft();
      showRight();
      return () => {
        map.off("move", sync); map.off("styledata", follow); clearTimeout(restyle);
        window.removeEventListener("resize", onResize);
        cmp.remove(); cmpEl.remove(); bar.remove(); divider.remove();
        rasters.forEach((L) => switches[L.id] && switches[L.id](before[L.id]));
        root.classList.remove("rv-comparing");
        btnCompare.setAttribute("aria-pressed", "false");
      };
    }
    if (btnCompare) btnCompare.addEventListener("click", () => (toolMode === "compare" ? endTool() : startTool("compare", startCompare)));

    // ---- measure: distances along a line, or an area (both measured on the ground, curved earth)
    const R_EARTH = 6371008.8;
    const rad = (d) => (d * Math.PI) / 180;
    const dist = (a, b) => {
      const s = Math.sin(rad(b[1] - a[1]) / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(rad(b[0] - a[0]) / 2) ** 2;
      return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(s)));
    };
    const pathLength = (pts) => pts.slice(1).reduce((t, p, i) => t + dist(pts[i], p), 0);
    const ringArea = (pts) => {                     // spherical polygon area (as used by turf), square metres
      const n = pts.length;
      if (n < 3) return 0;
      let t = 0;
      for (let i = 0; i < n; i++) {
        const p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
        t += (rad(p3[0]) - rad(p1[0])) * Math.sin(rad(p2[1]));
      }
      return Math.abs((t * 6378137 * 6378137) / 2);
    };
    const fmtLen = (mtr) => (mtr < 1000 ? `${mtr < 10 ? mtr.toFixed(1) : Math.round(mtr)} m` : `${(mtr / 1000).toFixed(mtr < 10000 ? 2 : 1)} km`);
    const fmtArea = (m2) => (m2 < 1000 ? `${Math.round(m2)} m²` : `${(m2 / 10000).toLocaleString("en-NZ", { maximumFractionDigits: m2 < 100000 ? 2 : 1 })} ha`);
    RCLViewer.measure = { dist, pathLength, ringArea, fmtLen, fmtArea };   // for tests
    function startMeasure() {
      clearSelection(); closeSheet();
      let kind = "line", pts = [], hover = null, done = false;
      const dbl = map.doubleClickZoom.isEnabled();
      map.doubleClickZoom.disable();
      const fc = () => {
        const all = hover && !done ? pts.concat([hover]) : pts;
        const f = [];
        if (kind === "area" && all.length >= 3) f.push({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [all.concat([all[0]])] } });
        if (all.length >= 2) f.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: kind === "area" && all.length >= 3 ? all.concat([all[0]]) : all } });
        pts.forEach((p) => f.push({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: p } }));
        return { type: "FeatureCollection", features: f };
      };
      if (!map.getSource("measure")) {
        map.addSource("measure", { type: "geojson", data: fc() });
        map.addLayer({ id: "measure-fill", type: "fill", source: "measure", filter: ["==", ["geometry-type"], "Polygon"], paint: { "fill-color": "#fec956", "fill-opacity": 0.18 } });
        map.addLayer({ id: "measure-halo", type: "line", source: "measure", filter: ["==", ["geometry-type"], "LineString"], paint: { "line-color": "#231f20", "line-width": 5, "line-opacity": 0.5 } });
        map.addLayer({ id: "measure-line", type: "line", source: "measure", filter: ["==", ["geometry-type"], "LineString"], paint: { "line-color": "#fec956", "line-width": 2.5, "line-dasharray": [2, 1] } });
        map.addLayer({ id: "measure-pts", type: "circle", source: "measure", filter: ["==", ["geometry-type"], "Point"], paint: { "circle-radius": 4.5, "circle-color": "#fff", "circle-stroke-color": "#231f20", "circle-stroke-width": 2 } });
      }
      const bar = el("div", { class: "rv-toolbar rv-measure-bar", role: "group", "aria-label": "Measure" });
      bar.innerHTML = `<div class="rv-seg" role="radiogroup" aria-label="What to measure"><button type="button" data-k="line" aria-pressed="true">Distance</button><button type="button" data-k="area" aria-pressed="false">Area</button></div>`
        + `<div class="rv-measure-out" aria-live="polite"></div>`
        + `<button type="button" class="rv-link rv-m-undo">Undo</button><button type="button" class="rv-link rv-m-clear">Clear</button>`
        + `<button type="button" class="rv-btn rv-m-finish">Finish</button><button type="button" class="rv-btn rv-tool-done">Close</button>`;
      root.appendChild(bar);
      const out = bar.querySelector(".rv-measure-out");
      const draw = () => {
        map.getSource("measure").setData(fc());
        const all = hover && !done ? pts.concat([hover]) : pts;
        if (!all.length) out.innerHTML = `<span class="rv-hint">${narrow() ? "Tap" : "Click"} the map to start${kind === "area" ? " outlining an area" : ""}</span>`;
        else if (kind === "line") out.innerHTML = `<b>${esc(fmtLen(pathLength(all)))}</b>`;
        else out.innerHTML = all.length < 3 ? `<span class="rv-hint">Add ${3 - all.length} more point${all.length === 2 ? "" : "s"}</span>`
          : `<b>${esc(fmtArea(ringArea(all)))}</b><span class="rv-hint">perimeter ${esc(fmtLen(pathLength(all.concat([all[0]]))))}</span>`;
        bar.querySelector(".rv-m-finish").hidden = done || pts.length < (kind === "area" ? 3 : 2);
      };
      const near = (a, b) => { const p = map.project(a), q = map.project(b); return Math.hypot(p.x - q.x, p.y - q.y) < 4; };
      const onClick = (e) => {
        const p = [e.lngLat.lng, e.lngLat.lat];
        if (done) { pts = []; done = false; }
        if (pts.length && near(pts[pts.length - 1], p)) return;          // the second click of a double-click
        if (kind === "area" && pts.length >= 3 && near(pts[0], p)) { done = true; return draw(); }   // closed the shape
        pts.push(p); draw();
      };
      const onMove = (e) => { if (!done && pts.length) { hover = [e.lngLat.lng, e.lngLat.lat]; draw(); } };
      const onDbl = (e) => { e.preventDefault(); if (pts.length >= (kind === "area" ? 3 : 2)) { done = true; hover = null; draw(); } };
      map.on("click", onClick); map.on("mousemove", onMove); map.on("dblclick", onDbl);
      bar.querySelectorAll("[data-k]").forEach((b) => b.addEventListener("click", () => {
        kind = b.dataset.k; done = false; hover = null;
        bar.querySelectorAll("[data-k]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
        draw();
      }));
      bar.querySelector(".rv-m-undo").addEventListener("click", () => { pts.pop(); done = false; draw(); });
      bar.querySelector(".rv-m-clear").addEventListener("click", () => { pts = []; done = false; hover = null; draw(); });
      bar.querySelector(".rv-m-finish").addEventListener("click", () => { done = true; hover = null; draw(); });
      bar.querySelector(".rv-tool-done").addEventListener("click", endTool);
      root.classList.add("rv-measuring");
      btnMeasure.setAttribute("aria-pressed", "true");
      draw();
      return () => {
        map.off("click", onClick); map.off("mousemove", onMove); map.off("dblclick", onDbl);
        if (dbl) map.doubleClickZoom.enable();
        pts = []; hover = null;
        if (map.getSource("measure")) map.getSource("measure").setData({ type: "FeatureCollection", features: [] });
        bar.remove();
        map.getCanvas().style.cursor = "";
        root.classList.remove("rv-measuring");
        btnMeasure.setAttribute("aria-pressed", "false");
      };
    }
    btnMeasure.addEventListener("click", () => (toolMode === "measure" ? endTool() : startTool("measure", startMeasure)));

    // ---- print: a one-page layout (title, map, scale, north arrow, legend, credit), then the browser's print dialog
    function niceScale(mpp, maxPx) {
      const maxM = mpp * maxPx, p = 10 ** Math.floor(Math.log10(maxM));
      const n = [5, 2, 1].map((k) => k * p).find((v) => v <= maxM) || p;
      return { metres: n, px: n / mpp, label: n >= 1000 ? `${n / 1000} km` : `${n} m` };
    }
    function legendFor(L) {
      if (L.draw) {
        const lg = drawLegend(L);
        return lg.map((g) => ({ label: lg.length > 1 ? g.label : "", src: legendIcon(g.color, L.draw.type === "direction") }));
      }
      return (L.legend || []).map((g) => ({ label: g.label, src: url(g.icon) }));
    }
    // one A4 landscape page, always: the map drawn again at print resolution for the space it has on the page, labels
    // painted into the picture, a legend of what's on (and in view) that shrinks to fit, scale, north arrow, credits
    const PAGE = { mapW: 204, mapH: 150, ratio: 2.5 };             // map size on the page (mm), pixels per CSS pixel
    function scaleFor(mppPaper) {                                     // ground metres per mm of paper
      const maxM = mppPaper * 42, p = 10 ** Math.floor(Math.log10(maxM));
      const n = [5, 2, 1].map((k) => k * p).find((v) => v <= maxM) || p;
      const fmt = (v) => (n >= 1000 ? `${+(v / 1000).toFixed(2)}` : `${+v.toFixed(1)}`);
      const sig = (v) => { const e = 10 ** (Math.floor(Math.log10(v)) - 1); return Math.round(v / e) * e; };
      return { mm: n / mppPaper, n, unit: n >= 1000 ? "km" : "m", half: fmt(n / 2), full: fmt(n), ratio: sig(mppPaper * 1000) };
    }
    function legendFor(L, present) {
      let items;
      if (L.draw) {
        const lg = drawLegend(L);
        items = lg.map((g) => ({ i: g.i, label: lg.length > 1 ? g.label : "", src: legendIcon(g.color, L.draw.type === "direction") }));
      } else items = (L.legend || []).map((g, i) => ({ i, label: g.label, src: url(g.icon) }));
      if (present && items.length > 1) items = items.filter((g) => present.has(g.i));
      return items;
    }
    function printLegend() {
      const blocks = [];
      layers.forEach((L) => {
        if (!isOn(L)) return;
        let present = null;
        if (L.features && map.getLayer("hit-" + L.id)) {
          const got = map.queryRenderedFeatures({ layers: ["hit-" + L.id] });
          if (!got.length) return;                                  // nothing of it in this view
          present = new Set(got.map((f) => (f.properties._cls == null ? 0 : Number(f.properties._cls))));
        }
        const items = legendFor(L, present);
        if (items.length === 1 && !items[0].label) blocks.push({ title: L.title, icon: items[0].src, items: [] });
        else blocks.push({ title: L.title, items: items.filter((g) => g.label) });
      });
      REFS.slice().reverse().forEach((R) => {
        if (!R.ready || !layerOn(R.L)) return;
        const ids = (mapIds[R.id] || []).filter((id) => map.getLayer(id));
        const have = new Set(map.queryRenderedFeatures({ layers: ids }).map((f) => f.properties[R.prop]));
        const items = R.classes.filter(([k]) => have.has(k)).map(([, label, c, w, o]) => ({ label, src: lineIcon(c, w, Object.assign({ casing: c === "#f2f2f2" ? "#777" : undefined }, o)) }));
        if (items.length) blocks.push({ title: R.title, items });
      });
      CTX.forEach((C) => {
        if (!C.ready || !layerOn(C.L) || !C.legend.length) return;
        if (C.legend.length === 1) blocks.push({ title: C.title, icon: contextIcon(C.legend[0]), items: [] });
        else blocks.push({ title: C.title, items: C.legend.map((g) => ({ label: g.label, src: contextIcon(g) })) });
      });
      return blocks;
    }
    function paintLabels(g, k, list) {                               // the labels placed for print, into the picture
      const fam = getComputedStyle(labelBox.querySelector(".rv-label") || labelBox).fontFamily || "sans-serif";
      g.textAlign = "center"; g.textBaseline = "middle"; g.lineJoin = "round";
      list.forEach((p) => {
        g.save();
        g.translate(p.at[0] * k, p.at[1] * k);
        if (p.ang) g.rotate((p.ang * Math.PI) / 180);
        g.font = `${p.italic ? "italic " : ""}${p.bold ? 700 : 600} ${p.size * k}px ${fam}`;
        if (p.spacing && "letterSpacing" in g) g.letterSpacing = `${p.spacing * p.size * k}px`;
        g.strokeStyle = p.halo; g.lineWidth = 3.2 * k; g.globalAlpha = 0.9; g.strokeText(p.text, 0, 0);
        g.globalAlpha = 1; g.fillStyle = p.colour; g.fillText(p.text, 0, 0);
        g.restore();
      });
    }
    function capture() {                                             // -> Promise of {img, zoom, lat, bearing, pitch}
      return new Promise((resolve, reject) => {
        const pxmm = 96 / 25.4, cw = Math.round(PAGE.mapW * pxmm), ch = Math.round(PAGE.mapH * pxmm);
        const W = mapEl.clientWidth, H = mapEl.clientHeight;
        const pr = panel.getBoundingClientRect(), mr = mapEl.getBoundingClientRect();
        const left = !narrow() && !panel.classList.contains("collapsed") ? Math.max(0, pr.right - mr.left) : 0;
        const peek = narrow() ? parseFloat(getComputedStyle(root).getPropertyValue("--peek")) || 0 : 0;
        const fw = Math.max(200, W - left), fh = Math.max(200, H - peek);
        const was = { center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch(), padding: map.getPadding() };
        const centre = map.unproject([left + fw / 2, fh / 2]);
        const zoom = was.zoom + Math.log2(Math.min(cw / fw, ch / fh));   // the same view, sized for the page
        const restore = () => {
          printing = false;
          mapEl.style.cssText = "";
          try { map.setPixelRatio(window.devicePixelRatio || 1); } catch (e) { /* older map library */ }
          map.resize(); map.jumpTo(was); placeLabels();
        };
        printing = true;
        mapEl.style.cssText = `inset:auto;left:0;top:0;width:${cw}px;height:${ch}px;`;
        try { map.setPixelRatio(PAGE.ratio); } catch (e) { /* older map library: screen resolution */ }
        map.resize();
        map.jumpTo({ center: centre, zoom, bearing: was.bearing, pitch: was.pitch, padding: { top: 0, bottom: 0, left: 0, right: 0 } });
        let done = false;
        const grab = () => {
          if (done) return; done = true;
          placeLabelsNow();
          const legend = printLegend();
          map.once("render", () => {
            let src;
            try { src = map.getCanvas().toDataURL("image/png"); } catch (e) { src = null; }
            const info = { zoom: map.getZoom(), lat: map.getCenter().lat, bearing: map.getBearing(), pitch: map.getPitch(), legend };
            const k = map.getCanvas().width / cw;
            const snap = placed.slice();                         // restoring the screen places its own labels again
            const labelsDraw = (g) => paintLabels(g, k, snap);
            restore();
            if (!src) return reject(new Error("canvas"));
            const im = new Image();
            im.onload = () => {
              const c = document.createElement("canvas"); c.width = im.width; c.height = im.height;
              const g = c.getContext("2d"); g.drawImage(im, 0, 0); labelsDraw(g);
              resolve(Object.assign(info, { img: c.toDataURL("image/jpeg", 0.92) }));
            };
            im.onerror = () => reject(new Error("image"));
            im.src = src;
          });
          map.triggerRepaint();
        };
        map.once("idle", grab);
        setTimeout(grab, 20000);                                     // slow imagery: print what has arrived
      });
    }
    function printView() {
      if (document.querySelector(".rv-print")) return;
      const busy = el("div", { class: "rv-print-busy" }, "Preparing the print…");
      root.appendChild(busy);
      capture().then((v) => {
        busy.remove();
        const pxmm = 96 / 25.4, cw = Math.round(PAGE.mapW * pxmm);
        const mpp = (40075016.686 * Math.cos(rad(v.lat))) / (512 * 2 ** v.zoom);      // ground metres per CSS pixel
        const sc = v.pitch < 5 ? scaleFor(mpp * cw / PAGE.mapW) : null;
        const property = m.property && m.property !== (m.map_title || m.title) ? m.property : "";
        const meta = [property, m.survey_date ? "Surveyed " + fmtDate(m.survey_date) : ""].filter(Boolean).join(" · ");
        const bmOn = ["aerial", "map"].find((k) => map.getLayoutProperty("bm-" + k, "visibility") !== "none");
        const credits = [bmOn ? String(BASEMAPS[bmOn].attribution || "").replace(/<[^>]*>/g, "") : "",
          ...REFS.filter((R) => R.ready && layerOn(R.L)).map((R) => R.credit), ...CTX.filter((C) => C.ready && layerOn(C.L)).map((C) => C.credit), threeD ? "Elevation: LINZ" : ""].filter(Boolean).join(" · ");
        const segs = sc ? [0, 1, 2, 3].map((i) => `<rect x="${(i * sc.mm) / 4}" y="0" width="${sc.mm / 4}" height="1.6" fill="${i % 2 ? "#fff" : "#1b2a24"}" stroke="#1b2a24" stroke-width=".25"/>`).join("") : "";
        const scale = sc ? `<div class="rv-pl-scale"><svg width="${sc.mm + 2}mm" height="2.2mm" viewBox="-1 -0.3 ${sc.mm + 2} 2.2">${segs}</svg>
            <div class="rv-pl-ticks" style="width:${sc.mm}mm"><span>0</span><span>${sc.half}</span><span>${sc.full} ${sc.unit}</span></div>
            <div class="rv-pl-ratio">Scale 1:${sc.ratio.toLocaleString("en-NZ")} at A4</div></div>`
          : `<div class="rv-pl-scale"><div class="rv-pl-ratio">Perspective view, not to scale</div></div>`;
        const north = `<div class="rv-pl-north"><svg viewBox="-10 -12 20 24" style="transform:rotate(${-v.bearing}deg)"><path d="M0-11 6 8 0 4-6 8z" fill="#1b2a24"/><path d="M0-11 0 4-6 8z" fill="#fff" stroke="#1b2a24" stroke-width=".8"/></svg><b>N</b></div>`;
        const blocks = v.legend.map((b) => `<section class="rv-pl-blk"><h4>${b.icon ? `<img alt="" src="${esc(b.icon)}">` : ""}${esc(b.title)}</h4>`
          + (b.items.length ? `<ul>${b.items.map((g) => `<li><img alt="" src="${esc(g.src)}"><span>${esc(g.label)}</span></li>`).join("")}</ul>` : "") + "</section>").join("");
        const sheet = el("div", { class: "rv-print rv-print-measure" });
        sheet.innerHTML = `<header class="rv-pl-head"><img class="rv-pl-logo" src="brand/logo.png" alt="Rural Consulting">
            <div class="rv-pl-ht"><div class="rv-pl-title">${esc(m.map_title || m.title)}</div><div class="rv-pl-meta">${esc(meta)}</div></div></header>
          <div class="rv-pl-body">
            <figure class="rv-pl-fig" style="width:${PAGE.mapW}mm;height:${PAGE.mapH}mm"><img class="rv-pl-map" alt="Map" src="${v.img}">
              <div class="rv-pl-plate rv-pl-plate-l">${scale}</div><div class="rv-pl-plate rv-pl-plate-r">${north}</div></figure>
            <aside class="rv-pl-legend"><div class="rv-pl-lh">Legend</div><div class="rv-pl-lcols">${blocks || '<p class="rv-pl-none">No layers switched on.</p>'}</div></aside>
          </div>
          <footer class="rv-pl-foot"><div class="rv-pl-f1"><span>Rural Consulting Limited · ruralconsulting.co.nz</span><span>${esc(credits)}</span>
              <span>Printed ${esc(new Date().toLocaleDateString("en-NZ", { day: "numeric", month: "long", year: "numeric" }))}</span></div>
            <div class="rv-pl-f2">Indicative only: boundaries and features are approximate and are not a legal survey. Check on the ground before relying on them.</div></footer>`;
        document.body.appendChild(sheet);
        fitLegend(sheet.querySelector(".rv-pl-lcols"));
        sheet.classList.remove("rv-print-measure");
        document.body.classList.add("rv-printing");
        let cleaned = false;
        const clean = () => { if (cleaned) return; cleaned = true; sheet.remove(); document.body.classList.remove("rv-printing"); window.removeEventListener("afterprint", clean); };
        window.addEventListener("afterprint", clean);
        const imgs = [...sheet.querySelectorAll("img")];
        Promise.all(imgs.map((i) => (i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; })))).then(() => {
          window.print();
          setTimeout(clean, 1000);                   // browsers that don't send afterprint
        });
      }).catch(() => { busy.remove(); alert("Sorry, this map view can't be printed in this browser."); });
    }
    // shrink the legend until it fits its box: smaller type, then two columns, then "+ N more"
    function fitLegend(box) {
      const over = () => box.scrollHeight > box.clientHeight + 1 || box.scrollWidth > box.clientWidth + 1;
      for (const cols of [1, 2]) {
        box.style.columnCount = cols;
        for (const pt of [8.5, 8, 7.5, 7, 6.5]) { box.style.fontSize = pt + "pt"; if (!over()) return; }
      }
      const items = [...box.querySelectorAll("li, .rv-pl-blk")].reverse();
      let hidden = 0;
      const more = el("p", { class: "rv-pl-more" });
      box.appendChild(more);
      for (const it of items) {
        if (!over()) break;
        if (it.classList.contains("rv-pl-blk") && it.querySelector("li")) continue;
        hidden += it.tagName === "LI" || !it.querySelector("ul") ? 1 : 0;      // an emptied heading isn't counted again
        it.remove();
        more.textContent = `+ ${hidden} more`;
      }
      if (!hidden) more.remove();
    }
    btnPrint.addEventListener("click", () => { endTool(); printView(); });
    return map;
  }

  // A layer's map-image files: one, or the pieces big imagery is saved in (manifest "tile_parts", from plugin 0.10.1).
  // Each piece: its own source and layer id ("t-<id>", "t-<id>-2"...), its zooms and the area it covers.
  function rasterParts(L) {
    const from = L.visible_from || L.minzoom || 0;
    const parts = Array.isArray(L.tile_parts) && L.tile_parts.length > 1 ? L.tile_parts : [{ tiles: L.tiles }];
    return parts.filter((P) => P && P.tiles).map((P, i) => ({
      id: "t-" + L.id + (i ? "-" + (i + 1) : ""), tiles: P.tiles,
      minzoom: Math.max(from, Number(P.minzoom) || 0),
      bounds: Array.isArray(P.bounds) && P.bounds.length === 4 ? P.bounds : null,
    }));
  }

  const RCLViewer = { mount, mergeShared, referenceDefs, contextDefs, contextText, rasterParts, featureTitle, drawLegend, wholeView, photoViewState, lightboxWire, terrain: null, stats: {} };
  window.RCLViewer = RCLViewer;
})();
