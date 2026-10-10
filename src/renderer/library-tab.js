/* global window, document, api, $, notice, fmtBytes */
// The Library page: a read-only visual directory of a result folder (Takeout,
// Snapchat, or anything). Folder tree on the left, grid or list in the middle,
// a preview on the right. Media comes through the unp:// protocol, which only
// serves files inside a folder opened here.

(function libraryTab() {
  const state = { lib: null, rel: "", view: "grid", listing: null, selected: null, search: "" };
  const treeExpand = new Map(); // rel -> expand(open=true) for the tree node
  const ICON = { photo: "🖼", video: "🎞", audio: "🎵", text: "📄", table: "📊", document: "📑", archive: "🗜", other: "📎", dir: "📁" };
  const KIND_WORD = { photo: "photos", video: "videos", audio: "audio files", text: "text files", table: "spreadsheets", document: "documents", archive: "archives", other: "other files" };

  const mediaUrl = (rel, thumb) => `unp://${state.lib.id}/${rel.split("/").map(encodeURIComponent).join("/")}${thumb ? "?thumb=1" : ""}`;
  const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString() : "");

  async function openFolder(dir) {
    const r = await api.library.open(dir);
    if (r.error) return notice(r.error, "warn");
    state.lib = r;
    state.rel = "";
    state.selected = null;
    state.search = "";
    $("libSearch").value = "";
    $("libSearch").disabled = false;
    $("libEmpty").hidden = true;
    $("libTree").hidden = false;
    closePreview();
    buildTree();
    await show("");
    if (typeof window.showTab === "function") window.showTab("library");
  }

  // ── tree ──
  function buildTree() {
    const tree = $("libTree");
    tree.textContent = "";
    treeExpand.clear();
    tree.appendChild(treeNode({ name: state.lib.name, rel: "" }, true));
  }

  function treeNode(d, root) {
    const el = document.createElement("div");
    el.className = "tn";
    el.dataset.rel = d.rel;
    const row = document.createElement("div");
    row.className = "tn-row";
    const tog = document.createElement("span");
    tog.className = "tn-tog";
    tog.textContent = "›";
    const name = document.createElement("span");
    name.className = "tn-name";
    name.textContent = (root ? "" : "") + d.name;
    row.append(tog, name);
    const kids = document.createElement("div");
    kids.className = "tn-kids";
    kids.hidden = true;
    el.append(row, kids);
    let loaded = false;
    const expand = async (open) => {
      if (!loaded) {
        loaded = true;
        const l = await api.library.list(state.lib.id, d.rel);
        if (l.error) return;
        for (const sub of l.dirs) kids.appendChild(treeNode(sub));
        if (!l.dirs.length) tog.classList.add("leaf");
      }
      kids.hidden = open === undefined ? !kids.hidden : !open;
      tog.classList.toggle("open", !kids.hidden);
    };
    treeExpand.set(d.rel, expand);
    tog.addEventListener("click", (e) => {
      e.stopPropagation();
      expand();
    });
    name.addEventListener("click", () => {
      show(d.rel);
      if (kids.hidden) expand();
    });
    if (root) expand(true);
    return el;
  }

  async function markTree() {
    // open every ancestor of the current folder so the tree follows the grid
    const parts = state.rel ? state.rel.split("/") : [];
    for (let i = 0; i <= parts.length; i += 1) {
      const f = treeExpand.get(parts.slice(0, i).join("/"));
      if (f) await f(true);
    }
    for (const n of $("libTree").querySelectorAll(".tn-row")) n.classList.toggle("on", n.parentElement.dataset.rel === state.rel);
  }

  // ── listing ──
  async function show(rel) {
    state.rel = rel;
    state.search = "";
    $("libSearch").value = "";
    const l = await api.library.list(state.lib.id, rel);
    if (l.error) return notice(l.error, "warn");
    state.listing = l;
    renderCrumbs();
    renderSummary(l.summary);
    renderStatus(l);
    renderItems([...l.dirs.map((d) => ({ ...d, dir: true })), ...l.files]);
    markTree();
    $("libGrid").scrollTop = 0;
  }

  function renderCrumbs() {
    const c = $("libCrumbs");
    c.textContent = "";
    const parts = state.rel ? state.rel.split("/") : [];
    const mk = (label, rel, last) => {
      const b = document.createElement("button");
      b.className = "crumb" + (last ? " on" : "");
      b.textContent = label;
      b.title = rel || state.lib.root;
      b.addEventListener("click", () => show(rel));
      c.appendChild(b);
      if (!last) {
        const s = document.createElement("span");
        s.className = "crumb-sep";
        s.textContent = "›";
        c.appendChild(s);
      }
    };
    mk(state.lib.name, "", parts.length === 0);
    parts.forEach((p, i) => mk(p, parts.slice(0, i + 1).join("/"), i === parts.length - 1));
  }

  function renderSummary(sum) {
    const d = $("libSummary");
    d.hidden = !sum;
    if (!sum) return;
    $("libSummaryTitle").textContent = sum.name.replace(/\.txt$/i, "");
    $("libSummaryText").textContent = sum.text.trim();
    d.open = false;
  }

  function renderStatus(l) {
    const bits = [];
    if (l.dirs.length) bits.push(`${l.dirs.length} folder${l.dirs.length === 1 ? "" : "s"}`);
    for (const [k, n] of Object.entries(l.kinds).sort((a, b) => b[1] - a[1])) bits.push(`${n} ${n === 1 ? KIND_WORD[k].replace(/s$/, "") : KIND_WORD[k]}`);
    if (l.bytes) bits.push(fmtBytes(l.bytes));
    $("libStatus").textContent = bits.length ? bits.join(" · ") : "Empty folder";
  }

  function renderItems(items) {
    const g = $("libGrid");
    g.textContent = "";
    g.className = `lib-grid ${state.view}`;
    const frag = document.createDocumentFragment();
    for (const it of items) frag.appendChild(itemEl(it));
    g.appendChild(frag);
    lazy.observe();
  }

  function itemEl(it) {
    const el = document.createElement("div");
    el.className = "li" + (it.dir ? " dir" : ` k-${it.kind}`);
    el.dataset.rel = it.rel;
    const th = document.createElement("div");
    th.className = "li-thumb";
    if (!it.dir && (it.view === "photo" || it.view === "video")) {
      const img = document.createElement("img");
      img.dataset.src = mediaUrl(it.rel, true);
      img.alt = "";
      img.loading = "lazy";
      img.addEventListener("error", () => {
        img.remove();
        th.textContent = ICON[it.kind];
      });
      th.appendChild(img);
      if (it.view === "video") {
        const b = document.createElement("span");
        b.className = "li-badge";
        b.textContent = "▶";
        th.appendChild(b);
      }
    } else th.textContent = it.dir ? ICON.dir : ICON[it.kind] || ICON.other;
    const name = document.createElement("div");
    name.className = "li-name";
    name.textContent = it.name;
    name.title = it.name;
    const meta = document.createElement("div");
    meta.className = "li-meta muted";
    meta.textContent = it.dir ? `${it.count} item${it.count === 1 ? "" : "s"}` : `${fmtBytes(it.size)}${state.view === "list" && it.mtime ? "  ·  " + fmtDate(it.mtime) : ""}`;
    el.append(th, name, meta);
    el.addEventListener("click", () => select(it, el));
    el.addEventListener("dblclick", () => (it.dir ? show(it.rel) : api.library.openFile(state.lib.id, it.rel)));
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") it.dir ? show(it.rel) : select(it, el);
    });
    el.tabIndex = 0;
    return el;
  }

  // Thumbnails load only when scrolled into view.
  const lazy = {
    io: null,
    observe() {
      if (!this.io) {
        this.io = new IntersectionObserver(
          (ents) => {
            for (const en of ents) {
              if (!en.isIntersecting) continue;
              const img = en.target;
              img.src = img.dataset.src;
              delete img.dataset.src;
              this.io.unobserve(img);
            }
          },
          { root: $("libGrid"), rootMargin: "300px" }
        );
      }
      for (const img of $("libGrid").querySelectorAll("img[data-src]")) this.io.observe(img);
    },
  };

  // ── preview ──
  async function select(it, el) {
    for (const x of $("libGrid").querySelectorAll(".li.on")) x.classList.remove("on");
    el.classList.add("on");
    state.selected = it;
    if (it.dir) {
      show(it.rel);
      return;
    }
    const pv = $("libPreview");
    pv.hidden = false;
    $("libPvName").textContent = it.name;
    $("libPvName").title = it.rel;
    $("libPvMeta").textContent = `${fmtBytes(it.size)}${it.mtime ? " · " + fmtDate(it.mtime) : ""} · ${it.rel.includes("/") ? it.rel.slice(0, it.rel.lastIndexOf("/")) : state.lib.name}`;
    const body = $("libPvBody");
    body.textContent = "";
    if (it.view === "photo") {
      const img = document.createElement("img");
      img.src = mediaUrl(it.rel);
      img.alt = it.name;
      body.appendChild(img);
    } else if (it.view === "video") {
      const v = document.createElement("video");
      v.src = mediaUrl(it.rel);
      v.controls = true;
      v.preload = "metadata";
      body.appendChild(v);
    } else if (it.view === "audio") {
      const a = document.createElement("audio");
      a.src = mediaUrl(it.rel);
      a.controls = true;
      body.appendChild(a);
    } else if (it.view === "text" || it.view === "table") {
      const r = await api.library.read(state.lib.id, it.rel);
      if (state.selected !== it) return;
      if (r.error) body.textContent = r.error;
      else if (it.view === "table") body.appendChild(tableEl(r.text, r.truncated));
      else {
        const pre = document.createElement("pre");
        pre.textContent = r.text + (r.truncated ? "\n\n… (first 2 MB shown)" : "");
        body.appendChild(pre);
      }
    } else {
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = `${ICON[it.kind] || ICON.other}  No preview for .${it.ext || "?"} files. Open it in its own app.`;
      body.appendChild(p);
    }
  }

  function tableEl(text, truncated) {
    const rows = parseCsv(text, 500);
    const wrap = document.createElement("div");
    wrap.className = "lib-table";
    const t = document.createElement("table");
    rows.rows.forEach((r, i) => {
      const tr = document.createElement("tr");
      for (const c of r) {
        const td = document.createElement(i === 0 ? "th" : "td");
        td.textContent = c;
        tr.appendChild(td);
      }
      t.appendChild(tr);
    });
    wrap.appendChild(t);
    if (rows.more || truncated) {
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = "… first 500 rows shown. Open it in its own app for all of it.";
      wrap.appendChild(p);
    }
    return wrap;
  }

  // Small CSV reader for the preview (quoted fields, CRLF).
  function parseCsv(text, maxRows) {
    const rows = [];
    let row = [];
    let f = "";
    let q = false;
    for (let i = 0; i < text.length; i += 1) {
      const c = text[i];
      if (q) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            f += '"';
            i += 1;
          } else q = false;
        } else f += c;
      } else if (c === '"') q = true;
      else if (c === ",") {
        row.push(f);
        f = "";
      } else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i += 1;
        row.push(f);
        f = "";
        rows.push(row);
        row = [];
        if (rows.length >= maxRows) return { rows, more: true };
      } else f += c;
    }
    if (f.length || row.length) {
      row.push(f);
      rows.push(row);
    }
    return { rows, more: false };
  }

  function closePreview() {
    $("libPreview").hidden = true;
    $("libPvBody").textContent = "";
    state.selected = null;
  }

  // ── search ──
  let searchTimer = null;
  async function runSearch(q) {
    state.search = q;
    if (!q) return show(state.rel);
    const r = await api.library.search(state.lib.id, q);
    if (state.search !== q) return;
    if (r.error) return notice(r.error, "warn");
    $("libSummary").hidden = true;
    $("libStatus").textContent = `${r.hits.length}${r.more ? "+" : ""} match${r.hits.length === 1 ? "" : "es"} for “${q}” in the whole library${r.more ? " (first 500 shown)" : ""}`;
    renderItems(r.hits.map((h) => (h.dir ? h : { ...h, mtime: 0 })));
  }

  function init() {
    $("libOpen").addEventListener("click", async () => {
      const [d] = (await api.dialog.chooseFolder("Choose a library folder to browse")) || [];
      if (d) openFolder(d);
    });
    $("libView").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-view]");
      if (!b) return;
      state.view = b.dataset.view;
      for (const x of $("libView").children) x.classList.toggle("on", x === b);
      if (state.listing) (state.search ? runSearch(state.search) : show(state.rel));
    });
    $("libSearch").addEventListener("input", (e) => {
      clearTimeout(searchTimer);
      const q = e.target.value.trim();
      searchTimer = setTimeout(() => runSearch(q), 250);
    });
    $("libPvClose").addEventListener("click", closePreview);
    $("libPvOpen").addEventListener("click", () => {
      if (state.selected) api.library.openFile(state.lib.id, state.selected.rel);
    });
    $("libPvShow").addEventListener("click", async () => {
      if (!state.selected) return;
      const p = await api.library.abs(state.lib.id, state.selected.rel);
      if (p) api.shell.showInFolder(p);
    });
    document.addEventListener("keydown", (e) => {
      if (document.body.dataset.tab !== "library" || !state.listing) return;
      if (e.key === "Escape" && !$("libPreview").hidden) closePreview();
      if (e.key === "Backspace" && e.target.tagName !== "INPUT" && state.rel) show(state.rel.includes("/") ? state.rel.slice(0, state.rel.lastIndexOf("/")) : "");
    });
  }

  init();
  window.libraryTab = {
    openFolder,
    onDrop: (paths) => {
      if (paths.length) openFolder(paths[0]);
    },
  };
})();
