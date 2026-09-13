/* global window, document */
// Renderer: renders the queue, collects options, and forwards drops/clicks to
// main through window.unpacker. No Node access here.

const api = window.unpacker;
const $ = (id) => document.getElementById(id);

let info = null;
let settings = null;
let action = "auto";
const jobEls = new Map();
const jobs = new Map();
const pwQueue = [];
let pwOpen = null;

// ── boot ────────────────────────────────────────────────────────

async function boot() {
  [info, settings] = await Promise.all([api.appInfo(), api.settings.get()]);
  applyTheme();
  fillSelect($("optFormat"), info.targets, (t) => [t.id, t.label]);
  fillSelect($("convFormat"), info.targets, (t) => [t.id, t.label]);
  fillSelect($("optLevel"), info.levels, (l) => [l.id, l.label]);
  fillSelect($("convLevel"), info.levels, (l) => [l.id, l.label]);
  fillSelect($("optSplit"), info.splitSizes, (s) => [s.id, s.label]);
  fillSelect($("convSplit"), info.splitSizes, (s) => [s.id, s.label]);

  $("optFormat").value = settings.format;
  $("optLevel").value = String(settings.level);
  $("optSplit").value = settings.split;
  $("optOnePerItem").checked = settings.onePerItem;
  $("optDeleteOriginal").checked = settings.deleteOriginalAfterConvert;
  $("convFormat").value = settings.convertTarget;
  $("convLevel").value = String(settings.level);
  document.querySelector(`input[name=outMode][value=${settings.outputMode}]`).checked = true;
  $("outDirLabel").textContent = settings.outputDir || "";

  const badge = $("engineBadge");
  if (info.engine.path) {
    badge.textContent = `7-Zip ${info.engine.version || ""}${info.rar ? " + WinRAR" : ""}`.trim();
    badge.title = `${info.engine.path}${info.rar ? `\n${info.rar}` : ""}`;
  } else {
    badge.textContent = "engine missing";
    badge.classList.add("bad");
    notice(info.engine.error, "err", 0);
  }
  $("footVersion").textContent = `v${info.version}`;
  $("updVersion").textContent = info.version;
  $("aboutVersion").textContent = `v${info.version}`;
  fillAbout();

  for (const j of await api.jobs.list()) upsertJob(j);
  api.jobs.onChange(upsertJob);
  api.jobs.onRemoved((id) => {
    const el = jobEls.get(id);
    if (el) el.remove();
    jobEls.delete(id);
    jobs.delete(id);
    refreshStats();
  });
  api.onCliRequest(handleCliRequest);
  api.onShot(async ({ which, paths }) => {
    for (const id of ["pwModal", "convModal", "pkModal", "tkModal", "meModal"]) $(id).hidden = true;
    showTab("archives");
    if (which === "pack") await openPackModal(paths);
    else if (which === "takeout") await openTakeoutModal(paths);
    else if (which === "massExtract") await openMassExtractModal(paths);
    else if (which === "settings") showTab("settings");
    else if (which === "about") showTab("about");
    else if (which === "convert") openConvertModal(paths, `${paths.length} archives selected.`);
    else if (which === "takeoutTab") {
      showTab("takeout");
      if (paths.length && window.takeoutTab) await window.takeoutTab.onDrop(paths);
    } else if (which === "archivesTab") showTab("archives");
  });
  api.update.onStatus((s) => {
    if (s.state === "ready") notice(`Update ${s.version} downloaded. It installs when you close the app.`, "ok", 0, { label: "Restart now", fn: () => api.update.installNow() });
    showUpdateStatus(s);
  });
  wireUi();
}

function fillSelect(sel, items, map) {
  sel.innerHTML = "";
  for (const it of items) {
    const [v, l] = map(it);
    const o = document.createElement("option");
    o.value = v;
    o.textContent = l;
    sel.appendChild(o);
  }
}

const PAGES = { archives: ["tabArchives", "Archives"], takeout: ["tabTakeout", "Google Takeout"], settings: ["pageSettings", "Settings"], about: ["pageAbout", "About"] };
function showTab(name) {
  if (!PAGES[name]) name = "archives";
  document.body.dataset.tab = name;
  for (const b of $("tabs").children) b.classList.toggle("on", b.dataset.tab === name);
  for (const [key, [id]] of Object.entries(PAGES)) $(id).hidden = key !== name;
  $("pageTitle").textContent = PAGES[name][1];
  $("archivesActions").hidden = name !== "archives";
  $("dropZone").classList.remove("over");
  if (name === "settings") openSettings();
}

function showUpdateStatus(s) {
  const map = {
    checking: "Checking GitHub Releases…",
    available: `Version ${s.version} is available; downloading in the background.`,
    downloading: `Downloading update… ${s.percent || 0}%`,
    ready: `Version ${s.version} is downloaded. It installs when the app closes, or restart now.`,
    current: "You have the latest version.",
    error: `Could not check: ${s.message}`,
    dev: s.message,
    disabled: s.message,
  };
  $("updStatus").textContent = map[s.state] || s.state;
  $("updRestart").hidden = s.state !== "ready";
}

function fillAbout() {
  const rows = [
    ["7-Zip engine", info.engine.path ? `${info.engine.version || "?"} — ${info.engine.path}` : info.engine.error],
    ["RAR creation", info.rar ? `WinRAR — ${info.rar}` : "not available (WinRAR not installed; extraction still works)"],
    ["Build", info.isPackaged ? "installed" : "running from source"],
  ];
  const t = $("aboutEngines");
  t.innerHTML = "";
  for (const [k, v] of rows) {
    const tr = document.createElement("tr");
    const a = document.createElement("td");
    a.textContent = k;
    const b = document.createElement("td");
    b.textContent = v;
    b.className = "mono";
    tr.append(a, b);
    t.appendChild(tr);
  }
}

function applyTheme() {
  document.body.dataset.theme = settings.theme === "light" ? "light" : "dark";
}

// ── options → job options ───────────────────────────────────────

function currentOptions() {
  const pw = $("optPassword").value;
  const outMode = document.querySelector("input[name=outMode]:checked").value;
  return {
    format: $("optFormat").value,
    level: Number($("optLevel").value),
    split: $("optSplit").value,
    password: action === "convert" ? undefined : pw || undefined,
    outPassword: action === "convert" ? pw || undefined : undefined,
    onePerItem: $("optOnePerItem").checked,
    deleteOriginal: $("optDeleteOriginal").checked,
    outputMode: outMode,
    outputDir: settings.outputDir,
  };
}

async function submitPaths(paths, act = action, options = currentOptions()) {
  if (!paths.length) return;
  // Smart compress intercepts plain "compress these" drops with an analysis step.
  if ($("optSmart").checked && (act === "compress" || (act === "auto" && !paths.some(looksLikeArchive)))) {
    return openPackModal(paths);
  }
  const res = await api.jobs.addPaths({ paths, action: act, options });
  for (const s of res.skipped) notice(`Skipped ${basename(s.path)}: ${s.reason}`, "warn");
  if (!res.added.length && !res.skipped.length) notice("Nothing to do.", "warn");
}

// ── UI wiring ───────────────────────────────────────────────────

function wireUi() {
  const dz = $("dropZone");
  const stop = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };
  for (const ev of ["dragenter", "dragover"]) {
    document.addEventListener(ev, (e) => {
      stop(e);
      dz.classList.add("over");
    });
  }
  document.addEventListener("dragleave", (e) => {
    stop(e);
    if (e.target === document.documentElement || e.relatedTarget == null) dz.classList.remove("over");
  });
  document.addEventListener("drop", (e) => {
    stop(e);
    dz.classList.remove("over");
    const paths = [...(e.dataTransfer.files || [])].map((f) => api.pathForFile(f)).filter(Boolean);
    if (document.body.dataset.tab === "takeout" && window.takeoutTab) return window.takeoutTab.onDrop(paths);
    submitPaths(paths);
  });

  // top-level tabs: Archives (the queue) / Google Takeout (the wizard)
  $("tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]");
    if (b) showTab(b.dataset.tab);
  });

  $("actionSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-action]");
    if (!b) return;
    action = b.dataset.action;
    for (const x of $("actionSeg").children) x.classList.toggle("on", x === b);
    $("optPassword").placeholder = action === "convert" ? "password for the new archives" : "none";
  });

  $("btnAddFiles").addEventListener("click", async () => submitPaths(await api.dialog.chooseFiles(), action === "auto" ? "compress" : action));
  $("btnAddFolder").addEventListener("click", async () => submitPaths(await api.dialog.chooseFolder("Choose folders to compress"), "compress"));
  $("btnOpenArchives").addEventListener("click", async () => submitPaths(await api.dialog.chooseArchives(), action === "auto" || action === "compress" ? "extract" : action));
  $("btnMassConvert").addEventListener("click", async () => {
    const dirs = await api.dialog.chooseFolder("Choose a folder to scan for archives");
    if (!dirs.length) return;
    const found = [];
    for (const d of dirs) found.push(...(await api.jobs.scanFolder(d)));
    if (!found.length) return notice("No archives found in that folder.", "warn");
    openConvertModal(found, `Found ${found.length} archive${found.length === 1 ? "" : "s"} under ${dirs.map(basename).join(", ")}.`);
  });
  $("btnTakeout").addEventListener("click", async () => {
    const dirs = await api.dialog.chooseFolder("Choose the folder holding your Takeout downloads");
    if (dirs.length) openTakeoutModal(dirs);
  });
  $("tkCancel").addEventListener("click", () => ($("tkModal").hidden = true));
  $("tkOk").addEventListener("click", startTakeout);
  $("tkDestBrowse").addEventListener("click", async () => {
    const [d] = await api.dialog.chooseFolder("Merge the export into which folder?");
    if (d) $("tkDest").value = d;
  });
  $("btnMassExtract").addEventListener("click", async () => {
    const dirs = await api.dialog.chooseFolder("Choose a folder to scan for archives");
    if (dirs.length) openMassExtractModal(dirs);
  });
  $("meDest").addEventListener("change", () => {
    $("meMergeRow").hidden = $("meDest").value !== "merge";
  });
  $("meMergeBrowse").addEventListener("click", async () => {
    const [d] = await api.dialog.chooseFolder("Merge everything into which folder?");
    if (d) $("meMergeDir").value = d;
  });
  $("meCancel").addEventListener("click", () => ($("meModal").hidden = true));
  $("meOk").addEventListener("click", startMassExtract);
  api.groups.onChange(upsertGroup);
  api.groups.list().then((gs) => gs.forEach(upsertGroup));
  $("btnVerifyManifest").addEventListener("click", async () => {
    const r = await api.pack.verifyManifest();
    if (r.added.length) notice(`Verifying ${r.added.length} manifest${r.added.length === 1 ? "" : "s"}. A .verify.txt report lands next to each.`, "ok");
  });
  $("pkPreset").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-preset]");
    if (b) applyPreset(b.dataset.preset);
  });
  for (const id of ["pkFormat", "pkLevel", "pkChunk", "pkMode", "pkManifest", "pkHash"]) {
    $(id).addEventListener("change", () => {
      if (pkPreset !== "custom") applyPreset("custom");
      else syncPackNote();
    });
  }
  $("pkPassword").addEventListener("input", syncPackNote);
  $("pkCancel").addEventListener("click", () => ($("pkModal").hidden = true));
  $("pkOk").addEventListener("click", startPack);
  $("btnClear").addEventListener("click", () => api.jobs.clearFinished());

  // persist the panel choices as defaults
  $("optFormat").addEventListener("change", () => save({ format: $("optFormat").value }));
  $("optLevel").addEventListener("change", () => save({ level: Number($("optLevel").value) }));
  $("optSplit").addEventListener("change", () => save({ split: $("optSplit").value }));
  $("optOnePerItem").addEventListener("change", () => save({ onePerItem: $("optOnePerItem").checked }));
  $("optDeleteOriginal").addEventListener("change", () => save({ deleteOriginalAfterConvert: $("optDeleteOriginal").checked }));
  for (const r of document.querySelectorAll("input[name=outMode]")) r.addEventListener("change", () => save({ outputMode: r.value }));
  $("btnOutDir").addEventListener("click", async () => {
    const [d] = await api.dialog.chooseFolder("Choose output folder");
    if (!d) return;
    await save({ outputDir: d, outputMode: "folder" });
    $("outDirLabel").textContent = d;
    document.querySelector("input[name=outMode][value=folder]").checked = true;
  });

  // password modal
  $("pwOk").addEventListener("click", submitPassword);
  $("pwInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitPassword();
    if (e.key === "Escape") skipPassword();
  });
  $("pwCancel").addEventListener("click", skipPassword);

  // convert modal
  $("convCancel").addEventListener("click", () => ($("convModal").hidden = true));
  $("convOk").addEventListener("click", startConvert);

  // settings modal
  $("updCheck").addEventListener("click", async () => {
    $("updStatus").textContent = "Checking GitHub Releases…";
    const r = await api.update.check();
    if (r && r.state === "checked" && !r.version) $("updStatus").textContent = "You have the latest version.";
  });
  $("updRestart").addEventListener("click", () => api.update.installNow());
  for (const b of document.querySelectorAll("#pageAbout button[data-url]")) b.addEventListener("click", () => api.shell.openExternal(b.dataset.url));
  $("setConcurrency").addEventListener("change", () => save({ concurrency: Number($("setConcurrency").value) }));
  $("setExtractMode").addEventListener("change", () => save({ extractMode: $("setExtractMode").value }));
  $("setOverwrite").addEventListener("change", () => save({ overwrite: $("setOverwrite").value }));
  $("setTheme").addEventListener("change", async () => {
    await save({ theme: $("setTheme").value });
    applyTheme();
  });
  $("setTempDir").addEventListener("change", () => save({ tempDir: $("setTempDir").value.trim() }));
  $("setTempBrowse").addEventListener("click", async () => {
    const [d] = await api.dialog.chooseFolder("Choose temporary folder");
    if (!d) return;
    $("setTempDir").value = d;
    save({ tempDir: d });
  });
  $("setVerify").addEventListener("change", () => save({ verify: $("setVerify").checked }));
  $("setHighRatio").addEventListener("change", () => save({ allowHighRatio: $("setHighRatio").checked }));
  $("setAutoUpdate").addEventListener("change", () => save({ autoUpdate: $("setAutoUpdate").checked }));
  $("setAllowLinks").addEventListener("change", () => save({ allowLinks: $("setAllowLinks").checked }));
  $("setPreventSleep").addEventListener("change", () => save({ preventSleep: $("setPreventSleep").checked }));
  $("setCloseToTray").addEventListener("change", () => save({ closeToTray: $("setCloseToTray").checked }));
  $("pkPlacement").addEventListener("change", syncPackNote);
  api.onActivity(({ busy, awake }) => {
    $("awakeBadge").hidden = !(busy && awake);
  });
  $("setContextMenu").addEventListener("change", async () => {
    const want = $("setContextMenu").checked;
    try {
      const now = await api.contextMenu.set(want);
      $("setContextMenu").checked = now;
      notice(now ? "Explorer menu entries added." : "Explorer menu entries removed.", "ok");
    } catch (err) {
      $("setContextMenu").checked = !want;
      notice(`Could not change the Explorer menu: ${err.message}`, "err");
    }
  });
}

async function save(patch) {
  settings = await api.settings.set(patch);
}

async function openSettings() {
  $("setConcurrency").value = String(settings.concurrency);
  $("setExtractMode").value = settings.extractMode;
  $("setOverwrite").value = settings.overwrite;
  $("setTheme").value = settings.theme;
  $("setTempDir").value = settings.tempDir || "";
  $("setVerify").checked = settings.verify;
  $("setHighRatio").checked = settings.allowHighRatio;
  $("setAutoUpdate").checked = settings.autoUpdate;
  $("setAllowLinks").checked = !!settings.allowLinks;
  $("setPreventSleep").checked = settings.preventSleep !== false;
  $("setCloseToTray").checked = !!settings.closeToTray;
  $("setContextMenu").checked = await api.contextMenu.get();
}

// ── convert modal ───────────────────────────────────────────────

let convPaths = [];
function openConvertModal(paths, summary) {
  convPaths = paths;
  $("convTitle").textContent = paths.length === 1 ? `Convert ${basename(paths[0])}` : "Convert archives";
  $("convSummary").textContent = summary || `${paths.length} archive${paths.length === 1 ? "" : "s"} selected.`;
  $("convDelete").checked = settings.deleteOriginalAfterConvert;
  $("convModal").hidden = false;
}

async function startConvert() {
  const format = $("convFormat").value;
  const target = info.targets.find((t) => t.id === format);
  let paths = convPaths;
  if ($("convSkipSame").checked && target) {
    const ext = target.ext.toLowerCase();
    paths = paths.filter((p) => {
      const l = p.toLowerCase();
      return !(l.endsWith(ext) || l.endsWith(`${ext}.001`));
    });
    const skipped = convPaths.length - paths.length;
    if (skipped) notice(`Skipped ${skipped} already in ${format}.`, "warn");
  }
  $("convModal").hidden = true;
  await save({ convertTarget: format });
  await submitPaths(paths, "convert", {
    format,
    level: Number($("convLevel").value),
    split: $("convSplit").value,
    outPassword: $("convPassword").value || undefined,
    deleteOriginal: $("convDelete").checked,
    outputMode: document.querySelector("input[name=outMode]:checked").value,
    outputDir: settings.outputDir,
  });
}

// ── smart compress ──────────────────────────────────────────────

const ARCHIVE_RX = /\.(zip|zipx|7z|rar|tar|gz|tgz|bz2|tbz2?|xz|txz|zst|tzst|lz|lzma|cab|iso|wim|arj|lzh|cpio|rpm|deb|dmg|vhdx?|001|r\d\d|z\d\d)$/i;
const looksLikeArchive = (p) => ARCHIVE_RX.test(String(p));

let pkPaths = [];
let pkInfo = null;
let pkPreset = "everyday";

async function openPackModal(paths) {
  pkPaths = paths;
  pkInfo = null;
  $("pkTitle").textContent = "Smart compress";
  $("pkSummary").innerHTML = "<span>Analyzing…</span>";
  $("pkSuggest").textContent = "Reading the files and testing how well a sample compresses…";
  $("pkOk").disabled = true;
  fillSelect($("pkFormat"), info.targets, (t) => [t.id, t.label]);
  fillSelect($("pkLevel"), info.levels, (l) => [l.id, l.label]);
  $("pkName").value = paths.length === 1 ? basename(paths[0]).replace(/\.[^.]+$/, (m) => (looksLikeArchive(paths[0]) ? "" : m)) : basename(dirname(paths[0])) || "Archive";
  $("pkPassword").value = $("optPassword").value;
  $("pkModal").hidden = false;
  try {
    pkInfo = await api.pack.analyze(paths, $("pkPassword").value);
  } catch (err) {
    $("pkSuggest").textContent = `Analysis failed: ${err.message}`;
    return;
  }
  fillSelect($("pkChunk"), pkInfo.chunkSizes, (c) => [c.id, c.label]);
  const b = pkInfo.bytes;
  const pct = (n) => (pkInfo.total ? Math.round((n / pkInfo.total) * 100) : 0);
  $("pkSummary").innerHTML = "";
  for (const [label, val] of [
    ["files", pkInfo.files.toLocaleString()],
    ["total", fmtBytes(pkInfo.total)],
    ["media", `${pct(b.media)}%`],
    ["documents/text", `${pct(b.text + b.office)}%`],
    ["already packed", `${pct(b.packed)}%`],
    ["sample compressed to", `${Math.round(pkInfo.probeRatio * 100)}%`],
  ]) {
    const s = document.createElement("span");
    s.innerHTML = `${label} <b></b>`;
    s.querySelector("b").textContent = val;
    $("pkSummary").appendChild(s);
  }
  const sg = pkInfo.suggestion;
  const fmt = info.targets.find((t) => t.id === sg.format);
  $("pkSuggest").innerHTML = "";
  const head = document.createElement("div");
  head.className = "head";
  head.textContent = `Suggested: ${fmt ? fmt.label : sg.format}, ${info.levels.find((l) => l.id === sg.level)?.label || sg.level}${sg.estSavedPct > 3 ? ` — about ${sg.estSavedPct}% smaller` : " — little to gain from compression"}`;
  const why = document.createElement("div");
  why.textContent = sg.reason;
  $("pkSuggest").append(head, why);
  applyPreset(pkPreset);
  $("pkOk").disabled = false;
}

function applyPreset(p) {
  pkPreset = p;
  for (const x of $("pkPreset").children) x.classList.toggle("on", x.dataset.preset === p);
  if (!pkInfo) return;
  const sg = pkInfo.suggestion;
  const custom = p === "custom";
  if (!custom) {
    $("pkFormat").value = sg.format;
    $("pkLevel").value = String(sg.level);
    $("pkMode").value = "chunks";
  }
  if (p === "everyday") {
    $("pkChunk").value = "";
    $("pkManifest").checked = false;
    $("pkHash").checked = false;
  } else if (p === "archival") {
    if (!$("pkChunk").value) $("pkChunk").value = pkInfo.total > 4000 * 1024 ** 2 ? "4g" : "";
    $("pkManifest").checked = true;
    $("pkHash").checked = true;
  }
  syncPackNote();
}

function syncPackNote() {
  const hasChunk = !!$("pkChunk").value;
  $("pkMode").disabled = !hasChunk;
  $("pkHashRow").style.opacity = $("pkManifest").checked ? "1" : "0.5";
  $("pkHash").disabled = !$("pkManifest").checked;
  const notes = [];
  if (hasChunk && $("pkMode").value === "chunks") notes.push("Files are grouped so each archive stays under the limit; folders are kept together when they fit. A single file bigger than the limit becomes its own volume set.");
  if (hasChunk && $("pkMode").value === "volumes") notes.push("One archive cut into .001/.002 pieces. Every piece is needed to open it.");
  if ($("pkPassword").value && $("pkFormat").value === "zip") notes.push("ZIP encrypts contents but not file names. Choose 7z to hide names too.");
  $("pkPlaceRow").style.opacity = $("pkManifest").checked ? "1" : "0.5";
  $("pkPlacement").disabled = !$("pkManifest").checked;
  if ($("pkManifest").checked && $("pkPlacement").value === "beside" && $("pkPassword").value) notes.push("The manifest text file beside the archives lists file names in plain text. Choose \"inside the archives only\" to keep names private.");
  if ($("pkManifest").checked && $("pkPlacement").value === "inside") notes.push("Verify later by choosing any of the archives in \"Verify a manifest\"; the manifest inside it is used.");
  if (pkInfo && $("pkHash").checked && $("pkManifest").checked && pkInfo.total > 50 * 1024 ** 3) notes.push(`Hashing reads all ${fmtBytes(pkInfo.total)} once more before packing.`);
  $("pkNote").textContent = notes.join(" ");
}

async function startPack() {
  $("pkModal").hidden = true;
  const options = {
    format: $("pkFormat").value,
    level: Number($("pkLevel").value),
    solidCap: pkInfo && $("pkFormat").value === "7z" ? pkInfo.suggestion.solidCap : undefined,
    chunkSize: $("pkChunk").value,
    chunkMode: $("pkMode").value,
    name: $("pkName").value.trim(),
    password: $("pkPassword").value || undefined,
    manifest: $("pkManifest").checked,
    hash: $("pkManifest").checked && $("pkHash").checked,
    manifestPlacement: $("pkPlacement").value,
    outputMode: document.querySelector("input[name=outMode]:checked").value,
    outputDir: settings.outputDir,
  };
  await api.pack.start(pkPaths, options);
}

function dirname(p) {
  const parts = String(p).split(/[\\/]/);
  parts.pop();
  return parts.join("\\");
}

// ── mass extract ────────────────────────────────────────────────

let mePaths = [];
async function openMassExtractModal(inputs) {
  const r = await api.massExtract.scan(inputs);
  if (!r.items.length) return notice("No archives found there.", "warn");
  mePaths = r.items.map((i) => i.path);
  const types = Object.entries(r.byType)
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${n} ${t}`)
    .join(", ");
  $("meSummary").textContent = `${r.items.length} archive${r.items.length === 1 ? "" : "s"}, ${fmtBytes(r.totalBytes)} packed (${types}).`;
  $("meMergeDir").value = dirname(mePaths[0]) + "\\Extracted";
  $("meMergeRow").hidden = $("meDest").value !== "merge";
  $("meOverwrite").value = settings.overwrite || "rename";
  $("meModal").hidden = false;
}

async function startMassExtract() {
  $("meModal").hidden = true;
  const r = await api.massExtract.start({
    paths: mePaths,
    options: {
      destMode: $("meDest").value,
      mergeDir: $("meMergeDir").value.trim(),
      overwrite: $("meOverwrite").value,
      nested: $("meNested").value,
      password: $("mePassword").value || undefined,
      sourcesAfter: $("meSources").value,
      sequential: $("meSequential").checked,
    },
  });
  if (r.added.length) notice(`Extracting ${r.added.length} archive${r.added.length === 1 ? "" : "s"}${$("meSequential").checked ? ", one at a time" : ""}.`, "ok");
}

const groupEls = new Map();
function upsertGroup(g) {
  if (g.removed) {
    const old = groupEls.get(g.id);
    if (old) old.remove();
    groupEls.delete(g.id);
    return;
  }
  let el = groupEls.get(g.id);
  if (!el) {
    el = document.createElement("div");
    el.className = "group";
    el.innerHTML = `<div class="title"></div><div class="actions"></div><div class="bar"><i></i></div><div class="status"></div>`;
    $("groups").appendChild(el);
    groupEls.set(g.id, el);
  }
  const terminal = g.done + g.failed + g.cancelled;
  el.className = `group${g.finished ? (g.allOk ? " finished" : " trouble") : ""}`;
  el.querySelector(".title").textContent = `${g.label}${g.total > g.sources ? ` (+${g.total - g.sources} nested)` : ""}`;
  el.querySelector(".bar > i").style.width = `${g.total ? (terminal / g.total) * 100 : 0}%`;
  const bits = [`${g.done} of ${g.total} done`];
  if (g.running) bits.push(`${g.running} running`);
  if (g.queued) bits.push(`${g.queued} waiting`);
  if (g.needsPassword) bits.push(`${g.needsPassword} need a password`);
  if (g.failed) bits.push(`${g.failed} failed`);
  if (g.cancelled) bits.push(`${g.cancelled} cancelled`);
  if (g.finished) bits.push(g.allOk ? "all succeeded" : "finished with problems; sources kept");
  el.querySelector(".status").textContent = bits.join(" · ");
  const actions = el.querySelector(".actions");
  actions.innerHTML = "";
  const btn = (label, fn) => {
    const b = document.createElement("button");
    b.className = "btn small";
    b.textContent = label;
    b.addEventListener("click", fn);
    actions.appendChild(b);
  };
  if (!g.finished) btn("Cancel remaining", () => api.groups.cancel(g.id));
  if (g.finished && g.report) btn("Report", () => api.shell.openPath(g.report));
  if (g.finished && g.mergeDir) btn("Open folder", () => api.shell.openPath(g.mergeDir));
  if (g.finished && g.archivalDir) btn("Open archival folder", () => api.shell.openPath(g.archivalDir));
  if (g.finished) btn("✕", () => api.groups.remove(g.id));
}

// ── google takeout ──────────────────────────────────────────────

let tkExports = [];
async function openTakeoutModal(inputs) {
  tkExports = await api.takeout.scan(inputs);
  if (!tkExports.length) return notice("No Takeout parts found. They are named like takeout-20260912T140102Z-001.zip (or .tgz).", "warn", 12000);
  const box = $("tkExports");
  box.innerHTML = "";
  let total = 0;
  tkExports.forEach((ex, i) => {
    total += ex.totalBytes;
    const row = document.createElement("label");
    row.className = "tk-export";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = true;
    cb.dataset.i = String(i);
    const name = document.createElement("span");
    name.textContent = `Export from ${ex.date} (${ex.format})`;
    const size = document.createElement("span");
    size.className = "mono";
    size.textContent = fmtBytes(ex.totalBytes);
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = `${ex.parts.length} part${ex.parts.length === 1 ? "" : "s"}: ${basename(ex.parts[0].path)} … ${basename(ex.parts[ex.parts.length - 1].path)}`;
    if (ex.missing.length) {
      const gap = document.createElement("span");
      gap.className = "gap";
      gap.textContent = ` — missing part${ex.missing.length === 1 ? "" : "s"} ${ex.missing.map((n) => String(n).padStart(3, "0")).join(", ")}. Download them first, or merge what's here and re-run later.`;
      meta.appendChild(gap);
    }
    row.append(cb, name, size, meta);
    box.appendChild(row);
  });
  $("tkDest").value = await api.takeout.defaultDest(tkExports[0].parts[0].path);
  $("tkSpace").textContent = `Downloads total ${fmtBytes(total)}. Extracted size is usually about the same for photos and videos and larger for mail and documents; the exact figure is checked against free space before anything is written.`;
  $("tkModal").hidden = false;
}

async function startTakeout() {
  const chosen = [...$("tkExports").querySelectorAll("input[type=checkbox]")].filter((c) => c.checked).map((c) => tkExports[Number(c.dataset.i)]);
  if (!chosen.length) return;
  const dest = $("tkDest").value.trim();
  if (!dest) return notice("Choose a folder to merge into.", "warn");
  $("tkModal").hidden = true;
  const res = await api.takeout.start({
    exports: chosen,
    options: {
      dest,
      overwrite: $("tkOverwrite").value,
      verifyFirst: $("tkVerify").checked,
      resume: $("tkResume").checked,
      flatten: $("tkFlatten").checked,
      tidyJson: $("tkJson").checked,
      trashParts: $("tkTrash").checked,
    },
  });
  if (res.added.length) notice(`Merging ${res.added.length} export${res.added.length === 1 ? "" : "s"} into ${dest}. Parts run one at a time; you can close the lid on this one.`, "ok", 10000);
}

function fmtBytes(n) {
  if (n == null || !Number.isFinite(n)) return "-";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

async function handleCliRequest({ type, paths }) {
  if (type === "takeout") {
    openTakeoutModal(paths);
  } else if (type === "extract-all") {
    openMassExtractModal(paths);
  } else if (type === "extract-to") {
    const [dest] = await api.dialog.chooseFolder("Extract to folder");
    if (dest) submitPaths(paths, "extract", { ...currentOptions(), dest });
  } else if (type === "convert") {
    openConvertModal(paths);
  }
}

// ── password prompt ─────────────────────────────────────────────

function askPassword(job) {
  if (pwQueue.some((j) => j.id === job.id) || (pwOpen && pwOpen.id === job.id)) return;
  pwQueue.push(job);
  nextPassword();
}
function nextPassword() {
  if (pwOpen || !pwQueue.length) return;
  pwOpen = pwQueue.shift();
  $("pwFor").textContent = pwOpen.label;
  $("pwInput").value = "";
  $("pwModal").hidden = false;
  $("pwInput").focus();
}
function submitPassword() {
  const pw = $("pwInput").value;
  if (!pw) return;
  const id = pwOpen.id;
  pwOpen = null;
  $("pwModal").hidden = true;
  api.jobs.retry(id, { password: pw });
  nextPassword();
}
function skipPassword() {
  pwOpen = null;
  $("pwModal").hidden = true;
  nextPassword();
}

// ── queue rendering ─────────────────────────────────────────────

function upsertJob(job) {
  const wasNeeding = jobs.get(job.id) && jobs.get(job.id).state === "needs-password";
  jobs.set(job.id, job);
  let el = jobEls.get(job.id);
  if (!el) {
    el = document.createElement("div");
    el.className = "job";
    el.innerHTML = `
      <div class="title"><span class="kind"></span><span class="label"></span></div>
      <div class="actions"></div>
      <div class="bar"><i></i></div>
      <div class="status"><span class="stage"></span><span class="file"></span></div>
      <div class="warn" hidden></div>
      <div class="err" hidden></div>
      <div class="out" hidden></div>`;
    $("queue").appendChild(el);
    jobEls.set(job.id, el);
  }
  el.className = `job ${job.state}${job.warnings.length ? " warned" : ""}`;
  el.querySelector(".kind").textContent = job.kind;
  el.querySelector(".label").textContent = job.label;
  el.querySelector(".label").title = job.inputs.join("\n");
  el.querySelector(".bar > i").style.width = `${job.progress || 0}%`;
  const elapsed = job.startedAt ? ` · ${fmtDuration((job.endedAt || Date.now()) - job.startedAt)}` : "";
  el.querySelector(".stage").textContent = `${job.stage}${job.state === "running" ? ` ${Math.round(job.progress)}%` : ""}${elapsed}`;
  el.querySelector(".file").textContent = job.file || "";
  const warn = el.querySelector(".warn");
  warn.hidden = !job.warnings.length;
  warn.textContent = job.warnings.length ? `Warnings: ${job.warnings.join(" · ")}` : "";
  const err = el.querySelector(".err");
  err.hidden = !(job.state === "failed" || job.state === "needs-password");
  err.textContent = job.error || "";
  const out = el.querySelector(".out");
  out.hidden = !(job.state === "done" && job.output);
  if (!out.hidden) {
    out.innerHTML = "";
    const a = document.createElement("a");
    a.textContent = job.output;
    a.title = "Show in Explorer";
    a.addEventListener("click", () => api.shell.showInFolder(job.output));
    out.appendChild(a);
  }

  const actions = el.querySelector(".actions");
  actions.innerHTML = "";
  const btn = (label, fn, cls = "small") => {
    const b = document.createElement("button");
    b.className = `btn ${cls}`;
    b.textContent = label;
    b.addEventListener("click", fn);
    actions.appendChild(b);
  };
  if (job.state === "running" || job.state === "queued") btn("Cancel", () => api.jobs.cancel(job.id));
  if (job.state === "needs-password") btn("Enter password", () => askPassword(job), "small accent");
  if (job.state === "failed" || job.state === "cancelled") btn("Retry", () => api.jobs.retry(job.id));
  if (job.state !== "running") btn("✕", () => api.jobs.remove(job.id));

  if (job.state === "needs-password" && !wasNeeding) askPassword(job);
  refreshStats();
}

function refreshStats() {
  const all = [...jobs.values()];
  $("queueEmpty").hidden = all.length > 0;
  const running = all.filter((j) => j.state === "running").length;
  const queued = all.filter((j) => j.state === "queued").length;
  const done = all.filter((j) => j.state === "done").length;
  const failed = all.filter((j) => j.state === "failed").length;
  const warned = all.filter((j) => j.state === "done" && j.warnings.length).length;
  $("queueStats").textContent = all.length ? `${running} running · ${queued} queued · ${done} done${warned ? ` (${warned} with warnings)` : ""}${failed ? ` · ${failed} failed` : ""}` : "";
}

// tick the elapsed time of running jobs
setInterval(() => {
  for (const j of jobs.values()) if (j.state === "running") upsertJob(j);
}, 1000);

// ── notices ─────────────────────────────────────────────────────

function notice(text, cls = "warn", ttl = 8000, actionBtn = null) {
  const n = document.createElement("div");
  n.className = `notice ${cls}`;
  const span = document.createElement("span");
  span.textContent = text;
  n.appendChild(span);
  if (actionBtn) {
    const b = document.createElement("button");
    b.className = "btn small";
    b.textContent = actionBtn.label;
    b.addEventListener("click", actionBtn.fn);
    n.appendChild(b);
  }
  const x = document.createElement("button");
  x.textContent = "✕";
  x.addEventListener("click", () => n.remove());
  n.appendChild(x);
  $("notices").appendChild(n);
  if (ttl) setTimeout(() => n.remove(), ttl);
}

function basename(p) {
  return String(p).split(/[\\/]/).pop();
}
function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

boot();
