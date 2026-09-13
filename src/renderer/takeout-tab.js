/* global window, document, api, $, notice, fmtBytes, basename, dirname, jobs */
// The Google Takeout tab: a four-step wizard over the takeout + organize jobs.
// Relies on the globals app.js defines (api, $, notice, fmtBytes, basename, dirname).

(function takeoutTab() {
  const state = {
    step: 1,
    found: null, // { exports, trees, folder }
    picked: { exports: new Set(), trees: new Set() },
    jobs: { extract: [], organize: [] },
    done: null,
  };

  const page = (n) => document.querySelector(`.wz-page[data-page="${n}"]`);

  function go(n) {
    state.step = n;
    for (const li of $("wzSteps").children) {
      const k = Number(li.dataset.step);
      li.classList.toggle("on", k === n);
      li.classList.toggle("past", k < n);
    }
    for (let k = 1; k <= 4; k += 1) page(k).hidden = k !== n;
    $("wzBack").hidden = n === 1 || n === 3;
    $("wzNext").hidden = n === 4;
    $("wzNext").textContent = n === 2 ? "Start" : "Next";
    $("wzNext").disabled = n === 3 || (n === 1 && !hasSelection());
    $("wzHint").textContent = n === 1 ? (state.found ? "" : "Nothing selected yet.") : n === 2 ? "Nothing is written until you press Start." : "";
    if (n === 3) $("wzNext").disabled = true;
  }

  const hasSelection = () => state.picked.exports.size + state.picked.trees.size > 0;

  // ── step 1: discovery ────────────────────────────────────────────

  async function discover(paths) {
    if (!paths.length) return;
    const r = await api.takeout.discover(paths);
    state.found = r;
    state.picked.exports = new Set(r.exports.map((e) => e.id));
    state.picked.trees = new Set(r.trees.map((t) => t.root));
    renderFound();
    if (r.exports.length) {
      $("wzDest").value = await api.takeout.defaultDest(r.exports[0].parts[0].path);
    }
    $("wzDestRow").hidden = !r.exports.length;
    if (!r.exports.length && !r.trees.length) notice("No Takeout parts or Takeout folder found there. Parts are named like takeout-20260912T140102Z-001.zip.", "warn", 12000);
    go(1);
  }

  function renderFound() {
    const box = $("wzFound");
    box.innerHTML = "";
    const r = state.found;
    if (!r) return;
    for (const ex of r.exports) {
      const row = document.createElement("label");
      row.className = "tk-export";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = state.picked.exports.has(ex.id);
      cb.addEventListener("change", () => {
        if (cb.checked) state.picked.exports.add(ex.id);
        else state.picked.exports.delete(ex.id);
        $("wzNext").disabled = !hasSelection();
      });
      const name = document.createElement("span");
      name.textContent = `Export from ${ex.date}${ex.set ? `, set ${ex.set}` : ""} (${ex.format})`;
      const size = document.createElement("span");
      size.className = "mono";
      size.textContent = fmtBytes(ex.totalBytes);
      const meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = `${ex.parts.length} part${ex.parts.length === 1 ? "" : "s"}: ${basename(ex.parts[0].path)} … ${basename(ex.parts[ex.parts.length - 1].path)}`;
      if (ex.missing.length) {
        const gap = document.createElement("span");
        gap.className = "gap";
        gap.textContent = ` — missing part${ex.missing.length === 1 ? "" : "s"} ${ex.missing.map((n) => String(n).padStart(3, "0")).join(", ")}. Download them, or merge what's here and re-run later.`;
        meta.appendChild(gap);
      }
      if (ex.duplicates && ex.duplicates.length) {
        const dup = document.createElement("span");
        dup.className = ex.duplicates.some((d) => !d.sameSize) ? "gap" : "";
        dup.textContent = ` — ${ex.duplicates.length} re-downloaded cop${ex.duplicates.length === 1 ? "y" : "ies"} ignored (${ex.duplicates.map((d) => basename(d.path)).join(", ")})${ex.duplicates.some((d) => !d.sameSize) ? "; sizes differ, the damage check will tell which is good" : ""}.`;
        meta.appendChild(dup);
      }
      row.append(cb, name, size, meta);
      box.appendChild(row);
    }
    for (const t of r.trees) {
      const row = document.createElement("label");
      row.className = "tk-export";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = state.picked.trees.has(t.root);
      cb.addEventListener("change", () => {
        if (cb.checked) state.picked.trees.add(t.root);
        else state.picked.trees.delete(t.root);
        $("wzNext").disabled = !hasSelection();
      });
      const name = document.createElement("span");
      name.textContent = "Already-extracted Takeout folder";
      const size = document.createElement("span");
      size.className = "mono";
      size.textContent = fmtBytes(t.services.reduce((n, s) => n + s.bytes, 0));
      const meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = `${t.root} — ${t.services.map((s) => `${s.name} (${s.files.toLocaleString()} files)`).join(", ") || "empty"}`;
      row.append(cb, name, size, meta);
      box.appendChild(row);
    }
  }

  // ── step 2: options ──────────────────────────────────────────────

  function fillOptions() {
    const r = state.found;
    const anyExports = r.exports.some((e) => state.picked.exports.has(e.id));
    $("wzExtractPanel").style.display = anyExports ? "" : "none";
    // services seen in extracted trees (exports are unknown until extracted)
    const names = new Map();
    for (const t of r.trees) if (state.picked.trees.has(t.root)) for (const s of t.services) if (s.name !== "Google Photos") names.set(s.name, (names.get(s.name) || 0) + s.files);
    const list = $("wzServiceList");
    list.innerHTML = "";
    for (const [name, files] of names) {
      const l = document.createElement("label");
      l.className = "check";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = true;
      cb.dataset.service = name;
      l.append(cb, ` ${name} (${files.toLocaleString()} files)`);
      list.appendChild(l);
    }
    if (!$("wzLibrary").value) $("wzLibrary").placeholder = anyExports ? `${$("wzDest").value}\\Library` : r.trees[0] ? `${dirname(r.trees[0].root)}\\Library` : "";
    syncOrganize();
  }

  function syncOrganize() {
    const on = $("wzOrganize").checked;
    for (const id of ["wzPhotoOpts", "wzServiceOpts"]) $(id).style.opacity = on ? "1" : "0.5";
    for (const el of document.querySelectorAll("#wzPhotoOpts input, #wzPhotoOpts select, #wzServiceOpts input, #wzLibrary, #wzLibraryBrowse")) el.disabled = !on;
    const ph = on && $("wzPhotos").checked;
    for (const id of ["wzDates", "wzExif", "wzYearMonth", "wzDedupe", "wzSidecars"]) $(id).disabled = !ph;
  }

  function organizeOptions() {
    if (!$("wzOrganize").checked) return null;
    const skip = [...document.querySelectorAll("#wzServiceList input")].filter((c) => !c.checked).map((c) => c.dataset.service);
    return {
      enabled: true,
      library: $("wzLibrary").value.trim(),
      photos: { enabled: $("wzPhotos").checked, dates: $("wzDates").checked, exif: $("wzExif").checked, yearMonth: $("wzYearMonth").checked, dedupe: $("wzDedupe").checked, sidecars: $("wzSidecars").value },
      services: { enabled: $("wzServices").checked, skip },
    };
  }

  // ── step 3: run ──────────────────────────────────────────────────

  async function start() {
    const r = state.found;
    const exportsPicked = r.exports.filter((e) => state.picked.exports.has(e.id));
    const trees = r.trees.filter((t) => state.picked.trees.has(t.root)).map((t) => t.root);
    const organize = organizeOptions();
    if (!exportsPicked.length && !organize) return notice("Nothing to do: no parts to extract and organizing is off.", "warn");
    state.jobs = await api.takeout.runPipeline({
      exports: exportsPicked,
      trees,
      extract: { dest: $("wzDest").value.trim(), verifyFirst: $("wzVerify").checked, resume: $("wzResume").checked, overwrite: $("wzOverwrite").value, trashParts: $("wzTrashParts").checked },
      organize,
    });
    state.done = null;
    renderRail();
    go(3);
  }

  function railItems() {
    const items = [];
    for (const id of state.jobs.extract) items.push({ id, label: "Check and extract the parts", kind: "extract" });
    for (const id of state.jobs.organize) items.push({ id, label: "Organize into libraries", kind: "organize" });
    return items;
  }

  function renderRail() {
    const rail = $("wzRail");
    rail.innerHTML = "";
    let active = null;
    let allDone = true;
    let failed = null;
    for (const it of railItems()) {
      const j = jobs.get(it.id);
      const li = document.createElement("li");
      const st = j ? j.state : "queued";
      li.className = st;
      li.textContent = `${it.label}${j ? ` — ${j.stage}${st === "running" ? ` ${Math.round(j.progress)}%` : ""}` : ""}`;
      if (j && j.warnings.length) {
        const w = document.createElement("div");
        w.className = "muted";
        w.textContent = j.warnings.join(" · ");
        li.appendChild(w);
      }
      rail.appendChild(li);
      if (st === "running" && !active) active = j;
      if (st !== "done") allDone = false;
      if ((st === "failed" || st === "needs-password") && !failed) failed = j;
      if (st === "cancelled" && !failed) failed = j;
    }
    if (active) {
      $("wzStage").textContent = active.file || active.stage;
      $("wzBar").style.width = `${active.progress}%`;
    }
    if (state.step === 3 && (allDone || failed)) finish(allDone ? null : failed);
  }

  function finish(failedJob) {
    if (state.done) return;
    state.done = { ok: !failedJob, job: failedJob };
    const lines = [];
    for (const it of railItems()) {
      const j = jobs.get(it.id);
      if (!j) continue;
      lines.push(`${j.state.toUpperCase().padEnd(10)} ${it.label}`);
      if (j.output) lines.push(`           ${j.output}`);
      if (j.error) lines.push(`           ${j.error}`);
      for (const w of j.warnings) lines.push(`           ! ${w}`);
    }
    $("wzDoneTitle").textContent = failedJob ? (failedJob.state === "cancelled" ? "Cancelled" : "Stopped with a problem") : "Done";
    $("wzSummary").textContent = lines.join("\n");
    const org = state.jobs.organize.map((id) => jobs.get(id)).find((j) => j && j.state === "done");
    const ex = state.jobs.extract.map((id) => jobs.get(id)).find((j) => j && j.state === "done");
    const lib = org ? org.output : ex ? ex.output : null;
    $("wzOpenLibrary").hidden = !lib;
    $("wzOpenLibrary").onclick = () => api.shell.openPath(lib);
    $("wzOpenLibrary").textContent = org ? "Open the library" : "Open the merged folder";
    $("wzOpenReport").hidden = !lib;
    $("wzOpenReport").onclick = () => api.shell.openPath(org ? `${org.output}\\Takeout-organize-report.txt` : `${ex.output}\\Takeout-import-report.txt`);
    go(4);
  }

  // ── wiring ───────────────────────────────────────────────────────

  function wire() {
    $("wzPickDownloads").addEventListener("click", async () => discover(await api.dialog.chooseFolder("Choose the folder holding your Takeout downloads")));
    $("wzPickTree").addEventListener("click", async () => discover(await api.dialog.chooseFolder("Choose the folder that holds Takeout/")));
    $("wzDestBrowse").addEventListener("click", async () => {
      const [d] = await api.dialog.chooseFolder("Extract the parts into which folder?");
      if (d) $("wzDest").value = d;
    });
    $("wzLibraryBrowse").addEventListener("click", async () => {
      const [d] = await api.dialog.chooseFolder("Put the library where?");
      if (d) $("wzLibrary").value = d;
    });
    $("wzOrganize").addEventListener("change", syncOrganize);
    $("wzPhotos").addEventListener("change", syncOrganize);
    $("wzNext").addEventListener("click", () => {
      if (state.step === 1) {
        fillOptions();
        go(2);
      } else if (state.step === 2) start();
    });
    $("wzBack").addEventListener("click", () => go(Math.max(1, state.step - 1)));
    $("wzCancel").addEventListener("click", () => {
      for (const id of [...state.jobs.extract, ...state.jobs.organize]) api.jobs.cancel(id);
    });
    $("wzAgain").addEventListener("click", () => {
      state.found = null;
      state.picked = { exports: new Set(), trees: new Set() };
      state.jobs = { extract: [], organize: [] };
      state.done = null;
      $("wzFound").innerHTML = "";
      $("wzDestRow").hidden = true;
      go(1);
    });
    api.jobs.onChange(() => {
      if (state.step === 3) renderRail();
    });
    go(1);
  }

  window.takeoutTab = { onDrop: (paths) => discover(paths), wire };
  // app.js boots asynchronously; wire once its globals exist
  const ready = () => (typeof api !== "undefined" && $("wzSteps") ? wire() : setTimeout(ready, 30));
  ready();
})();
