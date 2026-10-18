/* RCL customer portal: email + password sign in (accounts made by RCL), property list, map, change password. */
(function () {
  "use strict";
  const cfg = window.RCL_PORTAL || {};
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const LINK_HOURS = 12;
  const sb = supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });

  const ACCOUNT = "~password", INBOX = "~inbox", INSIGHTS = "~insights";
  function show(id) {
    ["screen-signin", "screen-account", "screen-list", "screen-map", "screen-inbox", "screen-insights"].forEach((s) => { document.getElementById(s).hidden = s !== id; });
  }
  function msg(t, where = "#msg") { $(where).textContent = t || ""; }

  // ---------------------------------------------------------------- sign in
  $("#f-signin").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("#email").value.trim().toLowerCase();
    const password = $("#password").value;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return msg("Enter a valid email address.");
    if (!password) return msg("Enter your password.");
    const b = e.submitter || $("#f-signin button");
    b.disabled = true; msg("");
    const { error } = await sb.auth.signInWithPassword({ email, password });
    b.disabled = false;
    if (error) {
      if (error.status === 429) return msg("Too many attempts. Wait a few minutes and try again.");
      if (error.status === 400 || /invalid/i.test(error.message)) return msg("That email and password don't match. Check them and try again.");
      return msg("We couldn't sign you in just now. Try again in a minute.");
    }
    $("#password").value = "";
    staff = null; cache = null;
    route();
  });
  async function signOut() { await sb.auth.signOut(); staff = null; cache = null; location.hash = ""; route(); }
  $("#b-signout").addEventListener("click", signOut);
  $("#b-password").addEventListener("click", () => { location.hash = ACCOUNT; });

  // ---------------------------------------------------------------- change password
  let returnTo = "";
  $("#b-cancel-pw").addEventListener("click", () => { location.hash = returnTo; });
  ["#pw1", "#pw2"].forEach((s) => $(s).addEventListener("input", () => msg("", "#pw-msg")));
  ["#email", "#password"].forEach((s) => $(s).addEventListener("input", () => msg("")));
  $("#f-password").addEventListener("submit", async (e) => {
    e.preventDefault();
    const p1 = $("#pw1").value, p2 = $("#pw2").value;
    if (p1.length < 10) return msg("Use at least 10 characters.", "#pw-msg");
    if (p1 !== p2) return msg("The two passwords don't match.", "#pw-msg");
    const b = e.submitter || $("#f-password button[type=submit]");
    b.disabled = true; msg("", "#pw-msg");
    const { error } = await sb.auth.updateUser({ password: p1 });
    b.disabled = false;
    if (error) {
      if (/different from the old/i.test(error.message)) return msg("That's your current password. Choose a new one.", "#pw-msg");
      if (/weak|short|characters/i.test(error.message)) return msg("That password is too easy to guess. Try a longer one.", "#pw-msg");
      return msg("Couldn't save the new password. Try again in a minute.", "#pw-msg");
    }
    $("#pw1").value = $("#pw2").value = "";
    alert("Password changed. Use the new one next time you sign in.");
    location.hash = returnTo;
  });
  async function showAccount(session) {
    show("screen-account");
    document.title = "Change password | Rural Consulting";
    $("#acct-email").value = session.user.email || "";
    msg("", "#pw-msg");
    $("#pw1").focus();
  }

  // ---------------------------------------------------------------- RCL staff
  let staff = null;
  async function isStaff() {
    if (staff === null) {
      const { data, error } = await sb.rpc("is_staff");
      staff = !error && data === true;
    }
    return staff;
  }
  async function inboxButton() {
    const b = $("#staff-row");
    if (!(await isStaff())) { b.hidden = true; return; }
    b.hidden = false;
    const { data } = await sb.from("suggestions").select("id,status");
    const n = (data || []).filter((x) => x.status === "new").length;
    $("#inbox-badge").textContent = n ? n + " new" : "";
  }
  $("#b-inbox").addEventListener("click", () => { location.hash = INBOX; });
  $("#b-insights").addEventListener("click", () => { location.hash = INSIGHTS; });
  $("#b-ib-insights").addEventListener("click", () => { location.hash = INSIGHTS; });
  $("#b-in-props").addEventListener("click", () => { location.hash = ""; });
  $("#b-in-inbox").addEventListener("click", () => { location.hash = INBOX; });
  $("#b-in-signout").addEventListener("click", () => signOut());

  // ---------------------------------------------------------------- staff insights dashboard
  async function showInsights() {
    show("screen-insights");
    document.title = "Insights | Rural Consulting";
    const box = $("#insights");
    if (!box.dataset.loaded) box.innerHTML = '<p class="pt-msg">Loading…</p>';
    const { data, error } = await sb.rpc("staff_insights");
    if (error || !data) { box.innerHTML = '<p class="pt-msg">Couldn\'t load the insights. If this is new, run the latest schema.sql in Supabase. Refresh to try again.</p>'; return; }
    box.dataset.loaded = "1";
    RCLInsights.render(box, data, {
      openMap: (farm) => { location.hash = farm.slug; },
      openInbox: () => { location.hash = INBOX; },
    });
  }

  // ---------------------------------------------------------------- lists: properties, then a property's maps
  const fmt = (d) => d ? new Date(d).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" }) : "";
  let cache = null;
  async function load() {
    if (cache) return cache;
    const [{ data: farms, error: e1 }, { data: maps, error: e2 }] = await Promise.all([
      sb.from("my_farms").select("*").order("name"), sb.from("my_maps").select("*").order("title")]);
    if (e1 || e2) throw e1 || e2;
    const byFarm = {};
    maps.forEach((m) => { (byFarm[m.farm_id] = byFarm[m.farm_id] || []).push(m); });
    cache = { farms: farms.filter((f) => byFarm[f.id]), byFarm };
    setTimeout(() => { cache = null; }, 60000);
    return cache;
  }

  function renderList({ heading, items, back, empty, search }) {
    $("#list-title").textContent = heading;
    $("#b-list-back").hidden = !back;
    if (back) $("#b-list-back").onclick = back;
    const box = $("#list-search");
    box.hidden = !search;
    const ul = $("#farms");
    const draw = () => {
      const q = box.value.trim().toLowerCase();
      const shown = items.filter((x) => !q || x.search.includes(q));
      ul.innerHTML = shown.map((x, i) => `<li><button type="button" data-i="${items.indexOf(x)}">
          ${x.kicker ? `<small>${esc(x.kicker)}</small>` : ""}<b>${esc(x.title)}</b>
          ${x.text ? `<span class="pt-desc">${esc(x.text)}</span>` : ""}<span>${esc(x.meta || "")}</span></button></li>`).join("");
      ul.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => { location.hash = items[+b.dataset.i].hash; }));
      msg(shown.length ? "" : (q ? "Nothing matches that search." : empty), "#list-msg");
    };
    box.oninput = draw;
    if (!search) box.value = "";
    draw();
    show("screen-list");
    inboxButton();
  }

  function showFarms(c) {
    document.title = "Farm maps | Rural Consulting";
    renderList({
      heading: "Your properties", empty: "No maps have been shared with this account yet.", search: c.farms.length > 6,
      items: c.farms.map((f) => {
        const maps = c.byFarm[f.id];
        return { title: f.name, hash: f.slug, search: (f.name + " " + maps.map((m) => m.title).join(" ")).toLowerCase(),
          meta: maps.length === 1 ? maps[0].title : `${maps.length} maps`, };
      }),
    });
  }

  function showMaps(f, maps, many) {
    document.title = f.name + " | Rural Consulting";
    renderList({
      heading: f.name, back: many ? () => { location.hash = ""; } : null, empty: "No maps yet.",
      items: maps.map((m) => ({ kicker: m.kind || "", title: m.title, text: m.description || "", hash: f.slug + "/" + m.slug,
        search: m.title.toLowerCase(), meta: [m.survey_date ? "Surveyed " + fmt(m.survey_date) : "", "Updated " + fmt(m.published_at)].filter(Boolean).join(" · ") })),
    });
  }

  // ---------------------------------------------------------------- map
  let refreshing = false;
  async function openMap(f, mp, maps, manyFarms, focus) {
    show("screen-map");
    const mapEl = $("#screen-map");
    mapEl.innerHTML = '<div class="pt-loading">Loading map…</div>';
    const { data: pkg, error } = await sb.from("packages").select("manifest, storage_prefix")
      .eq("map_id", mp.id).eq("is_current", true).single();
    if (error || !pkg) { mapEl.innerHTML = '<div class="pt-loading">This map is not available right now.</div>'; return; }
    const m = Object.assign({}, pkg.manifest, { property: f.name, title: mp.title, map_title: mp.title,
      description: mp.description || "", kind: mp.kind || "" });
    // files are stored by content (file_map); older packages used <prefix>/<rel>
    const where = (rel) => (m.file_map && m.file_map[rel]) || pkg.storage_prefix + "/" + rel;
    const byPath = {};
    m.files.forEach((rel) => { (byPath[where(rel)] = byPath[where(rel)] || []).push(rel); });
    const paths = Object.keys(byPath);
    const urls = {};
    for (let i = 0; i < paths.length; i += 500) {               // sign in batches
      const { data, error: e2 } = await sb.storage.from("farm-maps").createSignedUrls(paths.slice(i, i + 500), LINK_HOURS * 3600);
      if (e2) { mapEl.innerHTML = '<div class="pt-loading">This map is not available right now.</div>'; return; }
      data.forEach((d) => { if (d.signedUrl) (byPath[d.path] || []).forEach((rel) => { urls[rel] = d.signedUrl; }); });
    }
    document.title = mp.title + " · " + f.name + " | Rural Consulting";
    mapEl.innerHTML = "";
    const staffHere = await isStaff();
    const suggest = suggestionsFor(f, mp);
    suggest.focus = focus || null;
    if (staffHere) suggest.manage = (s) => { location.hash = INBOX + "/" + s.id; };
    window.rclMap = RCLViewer.mount(mapEl, {
      manifest: m,
      url: (rel) => urls[rel] || "",
      onBack: manyFarms ? () => { location.hash = ""; } : null,
      backLabel: "All properties",
      maps: maps.length > 1 ? maps.map((x) => ({ id: x.slug, title: x.title, kind: x.kind })) : null,
      currentMap: mp.slug,
      onSwitchMap: (slug) => { location.hash = f.slug + "/" + slug; },
      actions: [
        ...(staffHere ? [{ label: "Suggestions inbox", onClick: () => { location.hash = INBOX; } },
                         { label: "Insights", onClick: () => { location.hash = INSIGHTS; } }] : []),
        { label: "Change password", onClick: () => { location.hash = ACCOUNT; } },
        { label: "Sign out", onClick: signOut },
      ],
      suggest,
      terrain: cfg.linzKey ? { tiles: [`https://basemaps.linz.govt.nz/v1/tiles/elevation/WebMercatorQuad/{z}/{x}/{y}.png?api=${encodeURIComponent(cfg.linzKey)}&pipeline=terrain-rgb`],
        encoding: "mapbox", attribution: "Elevation © Toitū Te Whenua LINZ, CC BY 4.0" } : null,
    });
    // links expire; reload quietly before they do
    clearTimeout(openMap.timer);
    openMap.timer = setTimeout(() => { refreshing = true; route(); }, (LINK_HOURS - 0.5) * 3600 * 1000);
    // record the visit (not the automatic refresh); the database ignores repeats within 30 minutes
    if (!refreshing) {
      const device = window.matchMedia("(max-width: 720px), (pointer: coarse)").matches ? "phone" : "computer";
      sb.from("map_views").insert({ farm_id: f.id, map_id: mp.id, device }).then(() => {}, () => {});
    }
    refreshing = false;
  }

  // ---------------------------------------------------------------- suggestions
  const PHOTOS = "suggestion-photos";
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
    : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));

  // phone photos are big: send a 2000 px JPEG (keeps detail, uploads quickly on a farm connection)
  async function shrink(file, max = 2000) {
    let bmp;
    try { bmp = await createImageBitmap(file, { imageOrientation: "from-image" }); }
    catch (e) { bmp = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => bad(new Error("That file isn't a photo we can read.")); i.src = URL.createObjectURL(file); }); }
    const w = bmp.width, h = bmp.height, k = Math.min(1, max / Math.max(w, h));
    const c = document.createElement("canvas");
    c.width = Math.round(w * k); c.height = Math.round(h * k);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    return new Promise((ok) => c.toBlob(ok, "image/jpeg", 0.85));
  }

  function suggestionsFor(farm, mp) {
    return {
      async list() {
        const { data, error } = await sb.from("suggestions").select("*").eq("farm_id", farm.id).eq("map_id", mp.id)
          .order("created_at", { ascending: false });
        if (error) throw error;
        const paths = data.flatMap((s) => s.photos || []);
        const signed = {};
        if (paths.length) {
          const { data: urls } = await sb.storage.from(PHOTOS).createSignedUrls(paths, LINK_HOURS * 3600);
          (urls || []).forEach((u) => { if (u.signedUrl) signed[u.path] = u.signedUrl; });
        }
        return data.map((s) => ({ ...s, photo_urls: (s.photos || []).map((p) => signed[p]).filter(Boolean) }));
      },
      async submit(d) {
        const id = uuid();
        const photos = [];
        for (let i = 0; i < d.files.length; i++) {
          const blob = await shrink(d.files[i]);
          const path = `${farm.id}/${id}/${i + 1}.jpg`;
          const { error } = await sb.storage.from(PHOTOS).upload(path, blob, { contentType: "image/jpeg", upsert: false });
          if (error) throw new Error("a photo couldn't be uploaded. Check your connection and try again.");
          photos.push(path);
        }
        const { error } = await sb.from("suggestions").insert({
          id, farm_id: farm.id, map_id: mp.id, lng: d.lng, lat: d.lat, layer_id: d.layer_id, layer_title: d.layer_title,
          feature_id: d.feature_id || null, feature_label: d.feature_label || null, body: d.text, photos,
        });
        if (error) throw new Error("it couldn't be saved. Check your connection and try again.");
      },
    };
  }

  // ---------------------------------------------------------------- staff inbox: every suggestion, its status, reply, notes and history
  const STATUSES = [
    ["new", "New", "#e8590c"], ["in_progress", "In progress", "#1c7ed6"],
    ["done", "Done", "#2f9e44"], ["not_changed", "Not changed", "#868e96"]];
  const ST = Object.fromEntries(STATUSES.map(([k, label, color]) => [k, { label, color }]));
  const chip = (st) => `<span class="ib-chip" style="background:${(ST[st] || ST.new).color}">${esc((ST[st] || ST.new).label)}</span>`;
  const when = (d) => d ? new Date(d).toLocaleString("en-NZ", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }) : "";
  const ib = { rows: [], farms: {}, maps: {}, show: "open", farm: "", q: "", loaded: 0 };

  async function inboxLoad(force) {
    if (!force && Date.now() - ib.loaded < 30000) return;
    const [s, f, m] = await Promise.all([
      sb.from("suggestions").select("*").order("created_at", { ascending: false }),
      sb.from("farms").select("id,name,slug"), sb.from("maps").select("id,farm_id,title,slug")]);
    if (s.error || f.error || m.error) throw s.error || f.error || m.error;
    ib.rows = s.data;
    ib.farms = Object.fromEntries(f.data.map((x) => [x.id, x]));
    ib.maps = Object.fromEntries(m.data.map((x) => [x.id, x]));
    ib.loaded = Date.now();
  }
  const where = (s) => {
    const f = ib.farms[s.farm_id], m = ib.maps[s.map_id];
    return { farm: f ? f.name : "Property removed", map: m ? m.title : "", hash: f && m ? `${f.slug}/${m.slug}/s:${s.id}` : "" };
  };

  function inboxFilters() {
    const open = ib.rows.filter((s) => s.status === "new" || s.status === "in_progress").length;
    const count = (k) => ib.rows.filter((s) => s.status === k).length;
    const opts = [["open", `Open (${open})`], ...STATUSES.map(([k, l]) => [k, `${l} (${count(k)})`]), ["all", `All (${ib.rows.length})`]];
    $("#ib-status").innerHTML = opts.map(([k, l]) => `<button type="button" data-k="${k}" aria-pressed="${k === ib.show}">${esc(l)}</button>`).join("");
    $("#ib-status").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => { ib.show = b.dataset.k; inboxRender(); }));
    const farmIds = [...new Set(ib.rows.map((s) => s.farm_id))].sort((a, b) => where({ farm_id: a }).farm.localeCompare(where({ farm_id: b }).farm));
    $("#ib-farm").innerHTML = `<option value="">All properties</option>` +
      farmIds.map((id) => `<option value="${esc(id)}" ${id === ib.farm ? "selected" : ""}>${esc(where({ farm_id: id }).farm)}</option>`).join("");
  }
  $("#ib-farm").addEventListener("change", (e) => { ib.farm = e.target.value; inboxRender(); });
  $("#ib-search").addEventListener("input", (e) => { ib.q = e.target.value.trim().toLowerCase(); inboxRender(); });
  $("#b-ib-props").addEventListener("click", () => { location.hash = ""; });
  $("#b-ib-signout").addEventListener("click", signOut);

  function inboxRender() {
    inboxFilters();
    const id = currentInboxId();
    const rows = ib.rows.filter((s) => (ib.show === "all" || (ib.show === "open" ? ["new", "in_progress"].includes(s.status) : s.status === ib.show))
      && (!ib.farm || s.farm_id === ib.farm)
      && (!ib.q || [s.body, s.reply, s.author_email, s.layer_title, s.feature_label, where(s).farm, where(s).map].join(" ").toLowerCase().includes(ib.q)));
    $("#ib-list").innerHTML = rows.map((s) => {
      const w = where(s), n = (s.photos || []).length;
      return `<li><a href="#${INBOX}/${esc(s.id)}" class="${s.id === id ? "on" : ""}">
        <span class="ib-row-top">${chip(s.status)}<b>${esc(w.farm)}</b>${w.map ? `<span>· ${esc(w.map)}</span>` : ""}</span>
        <span class="ib-snip">${esc(s.body)}</span>
        <small>${esc(s.author_email || "")} · ${fmt(s.created_at)}${n ? ` · ${n} photo${n > 1 ? "s" : ""}` : ""}${s.reply ? " · replied" : ""}</small></a></li>`;
    }).join("");
    msg(rows.length ? "" : (ib.rows.length ? "Nothing here with these filters." : "No suggestions yet."), "#ib-msg");
  }
  const currentInboxId = () => decodeURIComponent(location.hash.slice(INBOX.length + 2) || "");

  async function showInbox(id) {
    show("screen-inbox");
    document.title = "Suggestions | Rural Consulting";
    $("#ib-wrap").classList.toggle("has-detail", !!id);
    $("#screen-inbox").classList.toggle("ib-has-detail", !!id);
    try { await inboxLoad(!ib.loaded); } catch (e) { msg("Couldn't load suggestions. Refresh to try again.", "#ib-msg"); return; }
    if (id && !ib.rows.some((s) => s.id === id)) { try { await inboxLoad(true); } catch (e) { /* shown below */ } }
    inboxRender();
    const s = ib.rows.find((x) => x.id === id);
    if (!id) { $("#ib-detail").innerHTML = `<p class="ib-empty">Pick a suggestion to see it, reply, and keep track of what's been done.</p>`; return; }
    if (!s) { $("#ib-detail").innerHTML = `<p class="ib-empty">That suggestion has been deleted.</p><a class="pt-link" href="#${INBOX}">← All suggestions</a>`; return; }
    return showSuggestionDetail(s);
  }

  async function showSuggestionDetail(s) {
    const box = $("#ib-detail"), w = where(s);
    const about = [s.layer_title, s.feature_label].filter(Boolean).join(" · ") || "A spot on the map";
    box.innerHTML = `
      <a class="pt-link ib-back" href="#${INBOX}">← All suggestions</a>
      <div class="ib-kicker">${chip(s.status)}<span>${esc(w.farm)}${w.map ? " · " + esc(w.map) : ""}</span></div>
      <h2>${esc(about)}</h2>
      <p class="ib-body">${esc(s.body).replace(/\n/g, "<br>")}</p>
      <div class="ib-photos"></div>
      <p class="ib-meta">From ${esc(s.author_email || "unknown")}, ${when(s.created_at)}${w.hash ? ` · <a href="#${esc(w.hash)}">See it on the map</a>` : ""}</p>
      <h3>Status</h3>
      <div class="ib-seg ib-setstatus" role="group" aria-label="Status">${STATUSES.map(([k, l]) => `<button type="button" data-k="${k}" aria-pressed="${k === s.status}">${esc(l)}</button>`).join("")}</div>
      <h3>Reply to the customer</h3>
      <p class="ib-help">They see this with their suggestion on the map.</p>
      <textarea id="ib-reply" rows="3" maxlength="2000">${esc(s.reply || "")}</textarea>
      <div class="ib-row"><button type="button" class="ib-btn" id="ib-save-reply">Save reply</button><span class="ib-saved" id="ib-reply-msg"></span></div>
      <h3>Internal note</h3>
      <p class="ib-help">Only RCL staff see notes. Use them for what you've done or still need to do.</p>
      <textarea id="ib-note" rows="2" maxlength="4000" placeholder="e.g. Fence line moved in QGIS, republish next week"></textarea>
      <div class="ib-row"><button type="button" class="ib-btn" id="ib-add-note">Add note</button><span class="ib-saved" id="ib-note-msg"></span></div>
      <h3>History</h3>
      <ol class="ib-history" id="ib-history"><li>Loading…</li></ol>
      <div class="ib-danger"><button type="button" class="pt-link" id="ib-delete">Delete this suggestion</button></div>`;
    if ((s.photos || []).length) {
      const { data } = await sb.storage.from(PHOTOS).createSignedUrls(s.photos, LINK_HOURS * 3600);
      box.querySelector(".ib-photos").innerHTML = (data || []).filter((u) => u.signedUrl)
        .map((u, i) => `<a href="${esc(u.signedUrl)}" target="_blank" rel="noopener"><img alt="Photo ${i + 1}" src="${esc(u.signedUrl)}"></a>`).join("");
    }
    loadHistory(s);
    box.querySelectorAll(".ib-setstatus button").forEach((b) => b.addEventListener("click", async () => {
      if (b.dataset.k === s.status) return;
      const { error } = await sb.from("suggestions").update({ status: b.dataset.k }).eq("id", s.id);
      if (error) return alert("Couldn't change the status. Try again.");
      s.status = b.dataset.k;
      box.querySelectorAll(".ib-setstatus button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      box.querySelector(".ib-kicker .ib-chip").outerHTML = chip(s.status);
      inboxRender(); loadHistory(s);
    }));
    $("#ib-save-reply").addEventListener("click", async () => {
      const reply = $("#ib-reply").value.trim() || null;
      if (reply === (s.reply || null)) return;
      const { error } = await sb.from("suggestions").update({ reply }).eq("id", s.id);
      if (error) return msg("Couldn't save. Try again.", "#ib-reply-msg");
      s.reply = reply; msg("Saved", "#ib-reply-msg");
      inboxRender(); loadHistory(s);
    });
    $("#ib-reply").addEventListener("input", () => msg("", "#ib-reply-msg"));
    $("#ib-add-note").addEventListener("click", async () => {
      const body = $("#ib-note").value.trim();
      if (!body) return;
      const { error } = await sb.from("suggestion_events").insert({ suggestion_id: s.id, kind: "note", body });
      if (error) return msg("Couldn't add the note. Try again.", "#ib-note-msg");
      $("#ib-note").value = ""; msg("", "#ib-note-msg");
      loadHistory(s);
    });
    $("#ib-delete").addEventListener("click", async () => {
      if (!confirm("Delete this suggestion, its photos and history? The customer won't see it any more. This can't be undone.")) return;
      if ((s.photos || []).length) await sb.storage.from(PHOTOS).remove(s.photos);
      const { error } = await sb.from("suggestions").delete().eq("id", s.id);
      if (error) return alert("Couldn't delete it. Try again.");
      ib.rows = ib.rows.filter((x) => x.id !== s.id);
      location.hash = INBOX;
    });
  }

  async function loadHistory(s) {
    const { data, error } = await sb.from("suggestion_events").select("*").eq("suggestion_id", s.id).order("at");
    const ol = $("#ib-history");
    if (!ol || currentInboxId() !== s.id) return;
    if (error) { ol.innerHTML = "<li>Couldn't load the history.</li>"; return; }
    const what = (e) => {
      if (e.kind === "created") return "Sent the suggestion";
      if (e.kind === "status") return "Status: " + esc((ST[e.status] || { label: e.status }).label);
      if (e.kind === "reply") return e.body ? `Replied: <q>${esc(e.body)}</q>` : "Removed the reply";
      if (e.kind === "note") return `<span class="ib-note">Note:</span> ${esc(e.body).replace(/\n/g, "<br>")}`;
      return esc(e.body || e.kind);
    };
    ol.innerHTML = (data || []).map((e) => `<li class="ib-ev-${esc(e.kind)}"><small>${when(e.at)} · ${esc(e.by_email || "")}</small><div>${what(e)}</div></li>`).join("")
      || "<li>Nothing yet.</li>";
  }

  // ---------------------------------------------------------------- routing: #property or #property/map
  async function route() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { show("screen-signin"); document.title = "Farm maps | Rural Consulting"; return; }
    if (location.hash === "#" + ACCOUNT) return showAccount(session);
    returnTo = location.hash.replace(/^#/, "");
    if (location.hash === "#" + INSIGHTS) {
      if (await isStaff()) return showInsights();
      location.hash = ""; return;
    }
    if (location.hash.startsWith("#" + INBOX)) {
      if (await isStaff()) return showInbox(location.hash.slice(INBOX.length + 2));
      location.hash = ""; return;
    }
    $("#signed-in-as").textContent = "Signed in as " + (session.user.email || "");
    let c;
    try { c = await load(); } catch (e) {
      renderList({ heading: "Your properties", items: [], empty: "Couldn't load your properties. Refresh to try again." });
      return;
    }
    const [fs, ms, extra] = decodeURIComponent(location.hash.replace(/^#/, "")).split("/");
    const f = c.farms.find((x) => x.slug === fs) || (c.farms.length === 1 ? c.farms[0] : null);
    if (!f) return showFarms(c);
    const maps = c.byFarm[f.id];
    const mp = maps.find((x) => x.slug === ms) || (maps.length === 1 ? maps[0] : null);
    if (!mp) return showMaps(f, maps, c.farms.length > 1);
    const focus = extra && extra.startsWith("s:") ? extra.slice(2) : null;
    return openMap(f, mp, maps, c.farms.length > 1, focus);
  }
  window.addEventListener("hashchange", route);
  sb.auth.onAuthStateChange((event) => { if (event === "SIGNED_OUT") show("screen-signin"); });

  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
    document.body.innerHTML = '<p style="padding:24px;font-family:system-ui">Portal not configured: set supabaseUrl and supabaseAnonKey in config.js.</p>';
  } else {
    route();
  }
})();
