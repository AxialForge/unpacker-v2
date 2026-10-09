/* global window, document, api, $, notice, fmtBytes, basename, jobs */
// The Snapchat page: a four-step wizard over the "snapchat" job.
// Same shape as takeout-tab.js; uses the globals app.js defines.

(function snapchatTab() {
  const state = { step: 1, found: null, picked: { exports: new Set(), folders: new Set() }, jobs: [], done: false };
  const page = (n) => document.querySelector(`[data-sc-page="${n}"]`);
  const any = () => state.picked.exports.size + state.picked.folders.size > 0;

  function go(n) {
    state.step = n;
    for (const li of $("scSteps").children) {
      const k = Number(li.dataset.step);
      li.classList.toggle("on", k === n);
      li.classList.toggle("past", k < n);
    }
    for (let k = 1; k <= 4; k += 1) page(k).hidden = k !== n;
    $("scBack").hidden = n !== 2;
    $("scNext").hidden = n === 4;
    $("scNext").textContent = n === 2 ? "Start" : "Next";
    $("scNext").disabled = n === 3 || (n === 1 && !any());
    $("scHint").textContent = n === 1 ? (state.found ? state.combineNote || "" : "Nothing selected yet.") : n === 2 ? "Nothing is written until you press Start." : "";
  }

  async function discover(paths) {
    if (!paths.length) return;
    const r = await api.snapchat.discover(paths);
    state.found = r;
    state.picked.exports = new Set(r.exports.map((e) => e.id));
    state.picked.folders = new Set(r.folders.map((f) => f.root));
    render();
    $("scDestRow").hidden = !r.exports.length;
    state.combineNote = r.exports.length > 1 ? "Several exports of one account: they are combined into one folder and one library." : "";
    if (r.exports.length) $("scDest").value = `${r.folder}\\Snapchat-export`;
    if (!r.exports.length && !r.folders.length) notice("No Snapchat export found there. The files are named like mydata~1790635398407.zip.", "warn", 12000);
    go(1);
  }

  function row(checked, onChange, title, sizeText, metaText, warn) {
    const el = document.createElement("label");
    el.className = "tk-export";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = checked;
    cb.addEventListener("change", () => {
      onChange(cb.checked);
      $("scNext").disabled = !any();
    });
    const name = document.createElement("span");
    name.textContent = title;
    const size = document.createElement("span");
    size.className = "mono";
    size.textContent = sizeText;
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = metaText;
    if (warn) {
      const g = document.createElement("span");
      g.className = "gap";
      g.textContent = ` — ${warn}`;
      meta.appendChild(g);
    }
    el.append(cb, name, size, meta);
    return el;
  }

  function render() {
    const box = $("scFound");
    box.innerHTML = "";
    for (const ex of state.found.exports) {
      const p = ex.peek || {};
      const bits = [`${ex.parts.length} file${ex.parts.length === 1 ? "" : "s"}`];
      if (p.photos || p.videos) bits.push(`${p.photos} photos, ${p.videos} videos, ${p.overlays} overlays`);
      if (p.sections && p.sections.length) bits.push(`data: ${p.sections.join(", ")}`);
      const warn = [ex.missing.length ? `missing part${ex.missing.length === 1 ? "" : "s"} ${ex.missing.join(", ")}` : "", ex.duplicates.length ? `${ex.duplicates.length} repeated download ignored` : "", p.error ? `could not be read: ${p.error}` : ""].filter(Boolean).join("; ");
      box.appendChild(
        row(
          true,
          (on) => (on ? state.picked.exports.add(ex.id) : state.picked.exports.delete(ex.id)),
          `Snapchat export ${ex.id}`,
          fmtBytes(ex.totalBytes),
          bits.join(" · "),
          warn
        )
      );
    }
    for (const f of state.found.folders) {
      box.appendChild(row(true, (on) => (on ? state.picked.folders.add(f.root) : state.picked.folders.delete(f.root)), "Already-extracted export folder", "", f.root, ""));
    }
  }

  async function start() {
    const r = state.found;
    const res = await api.snapchat.run({
      exports: r.exports.filter((e) => state.picked.exports.has(e.id)),
      folders: r.folders.filter((f) => state.picked.folders.has(f.root)).map((f) => f.root),
      extract: { dest: $("scDest").value.trim(), verifyFirst: $("scVerify").checked, trashParts: $("scTrashParts").checked },
      organize: { library: $("scLibrary").value.trim(), yearMonth: $("scYearMonth").checked, rename: $("scRename").checked, dates: $("scDates").checked, exif: $("scExif").checked, gps: $("scGps").checked, overlays: $("scOverlays").value, burn: $("scBurn").checked, exportLog: $("scLog").checked },
    });
    state.jobs = res.jobs;
    state.done = false;
    go(3);
    rail();
  }

  function elapsed(ms) {
    const s = Math.floor(ms / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  }

  function rail() {
    const list = $("scRail");
    list.innerHTML = "";
    let active = null;
    let allDone = state.jobs.length > 0;
    let failed = null;
    for (const id of state.jobs) {
      const j = jobs.get(id);
      const st = j ? j.state : "queued";
      const li = document.createElement("li");
      li.className = st;
      li.textContent = j ? `${j.label} — ${j.stage}${st === "running" ? ` ${Math.round(j.progress)}%` : ""}` : "Waiting…";
      if (j && j.warnings.length) {
        const w = document.createElement("div");
        w.className = "muted";
        w.textContent = j.warnings.join(" · ");
        li.appendChild(w);
      }
      list.appendChild(li);
      if (st === "running" && !active) active = j;
      if (st !== "done") allDone = false;
      if (["failed", "cancelled", "needs-password"].includes(st) && !failed) failed = j;
    }
    if (active) {
      $("scStage").textContent = `${active.stage} · ${Math.round(active.progress)}%${active.startedAt ? ` · ${elapsed(Date.now() - active.startedAt)}` : ""}${active.file ? `\n${active.file}` : ""}`;
      $("scBar").style.width = `${active.progress}%`;
    }
    if (state.step === 3 && !state.done && (allDone || failed)) finish(failed);
  }

  function finish(failed) {
    state.done = true;
    const lines = [];
    let lib = null;
    for (const id of state.jobs) {
      const j = jobs.get(id);
      if (!j) continue;
      lines.push(`${j.state.toUpperCase().padEnd(10)} ${j.label}`);
      if (j.output) {
        lines.push(`           ${j.output}`);
        if (j.state === "done" && !lib) lib = j.output;
      }
      if (j.error) lines.push(`           ${j.error}`);
      for (const w of j.warnings) lines.push(`           ! ${w}`);
    }
    $("scDoneTitle").textContent = failed ? (failed.state === "cancelled" ? "Cancelled" : "Stopped with a problem") : "Done";
    $("scSummary").textContent = lines.join("\n");
    $("scBrowse").hidden = !lib;
    $("scBrowse").onclick = () => window.libraryTab && window.libraryTab.openFolder(lib);
    $("scOpenLibrary").hidden = !lib;
    $("scOpenReport").hidden = !lib;
    $("scOpenLibrary").onclick = () => api.shell.openPath(lib);
    $("scOpenReport").onclick = () => api.shell.openPath(`${lib}\\Snapchat library report.txt`);
    go(4);
  }

  function wire() {
    $("scPickFiles").addEventListener("click", async () => discover(await api.dialog.chooseFolder("Choose the folder holding your Snapchat download")));
    $("scPickFolder").addEventListener("click", async () => discover(await api.dialog.chooseFolder("Choose the extracted Snapchat export folder")));
    $("scDestBrowse").addEventListener("click", async () => {
      const [d] = await api.dialog.chooseFolder("Extract the export into which folder?");
      if (d) $("scDest").value = d;
    });
    $("scLibraryBrowse").addEventListener("click", async () => {
      const [d] = await api.dialog.chooseFolder("Put the library where?");
      if (d) $("scLibrary").value = d;
    });
    $("scNext").addEventListener("click", () => {
      if (state.step === 1) {
        $("scExtractPanel").style.display = state.found.exports.some((e) => state.picked.exports.has(e.id)) ? "" : "none";
        go(2);
      } else if (state.step === 2) start();
    });
    $("scBack").addEventListener("click", () => go(1));
    $("scCancel").addEventListener("click", () => state.jobs.forEach((id) => api.jobs.cancel(id)));
    $("scAgain").addEventListener("click", () => {
      state.found = null;
      state.picked = { exports: new Set(), folders: new Set() };
      state.jobs = [];
      $("scFound").innerHTML = "";
      $("scDestRow").hidden = true;
      go(1);
    });
    api.jobs.onChange(() => state.step === 3 && rail());
    setInterval(() => state.step === 3 && rail(), 1000);
    go(1);
  }

  window.snapchatTab = { onDrop: (paths) => discover(paths) };
  const ready = () => (typeof api !== "undefined" && $("scSteps") ? wire() : setTimeout(ready, 30));
  ready();
})();
