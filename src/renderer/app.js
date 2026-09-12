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
  $("aboutLine").textContent = `Unpacker V2 ${info.version} · engine: ${info.engine.path || "none"} · RAR creation: ${info.rar ? "via WinRAR" : "not available (WinRAR not installed)"}`;

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
  api.update.onStatus((s) => {
    if (s.state === "ready") notice(`Update ${s.version} downloaded. It installs when you close the app.`, "ok", 0, { label: "Restart now", fn: () => api.update.installNow() });
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
    submitPaths(paths);
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
  $("btnSettings").addEventListener("click", openSettings);
  $("setClose").addEventListener("click", () => ($("setModal").hidden = true));
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
  $("setContextMenu").checked = await api.contextMenu.get();
  $("setModal").hidden = false;
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

async function handleCliRequest({ type, paths }) {
  if (type === "extract-to") {
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
  el.className = `job ${job.state}`;
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
  $("queueStats").textContent = all.length ? `${running} running · ${queued} queued · ${done} done${failed ? ` · ${failed} failed` : ""}` : "";
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
