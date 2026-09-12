// Electron main process: window, engine wiring, the job queue, IPC, and the
// command-line entry points used by the Explorer context menu.

const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage, powerSaveBlocker } = require("electron");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const { Store } = require("./store");
const formats = require("./engine/formats");
const sevenzip = require("./engine/sevenzip");
const rarEngine = require("./engine/rar");
const { JobQueue } = require("./jobs/queue");
const { Runner } = require("./jobs/runner");
const { GroupRegistry } = require("./groups");
const shellIntegration = require("./shell-integration");
const takeout = require("./takeout");
const analyze = require("./analyze");
const chunker = require("./chunker");
const scan = require("./scan");
const updater = require("./updater");

const DEV = process.argv.includes("--dev");

// ── single instance + CLI ───────────────────────────────────────
// Explorer launches one process per selected item. The first instance wins the
// lock; later ones forward their argv here and exit. Compress requests that
// arrive within a short window are merged into ONE archive, which is what a
// multi-select "Add to archive" should mean.

const { parseCli } = require("./cli");
const { closeDecision, wantAwake } = require("./policy");

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    if (mainWindow) showWindow();
    handleCli(parseCli(argv));
  });
}

let mainWindow = null;
let store = null;
let engine = null; // SevenZip instance or null
let engineInfo = { path: null, version: null, error: null };
let rar = null;
let queue = null;
let runner = null;
let groups = null;

const pendingCompress = { paths: [], timer: null };

function handleCli(requests) {
  for (const { flag, paths } of requests) {
    if (!paths.length) continue;
    if (flag === "--compress") {
      pendingCompress.paths.push(...paths);
      clearTimeout(pendingCompress.timer);
      pendingCompress.timer = setTimeout(() => {
        const batch = pendingCompress.paths.splice(0);
        addPaths({ paths: batch, action: "compress" });
      }, 400);
    } else if (flag === "--extract-here") {
      addPaths({ paths, action: "extract" });
    } else if (flag === "--test") {
      addPaths({ paths, action: "test" });
    } else {
      // extract-to / convert need a decision from the user: hand to the renderer
      const send = () => mainWindow && mainWindow.webContents.send("cli:request", { type: flag.slice(2), paths });
      if (mainWindow && mainWindow.webContents.isLoading()) mainWindow.webContents.once("did-finish-load", send);
      else send();
    }
  }
}

// ── window ──────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 760,
    minHeight: 520,
    title: "Unpacker V2",
    backgroundColor: "#14171c",
    autoHideMenuBar: true,
    icon: path.join(__dirname, "..", "..", "assets", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  if (DEV && process.argv.includes("--devtools")) mainWindow.webContents.openDevTools({ mode: "detach" });
  if (DEV) {
    // Echo renderer console to the terminal so `npm run dev` shows UI errors too.
    mainWindow.webContents.on("console-message", (e) => {
      const level = e.level || "";
      if (level === "error" || level === "warning" || level === 2 || level === 3) console.log(`[renderer:${level}] ${e.message} (${e.sourceId}:${e.lineNumber})`);
    });
    mainWindow.webContents.on("preload-error", (_e, p, err) => console.error("[preload-error]", p, err));
  }
  mainWindow.on("close", handleClose);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ── engine + queue ──────────────────────────────────────────────

function initEngine() {
  const exe = sevenzip.locate({ resourcesPath: process.resourcesPath, appPath: app.getAppPath() });
  if (!exe) {
    engineInfo = { path: null, version: null, error: "7-Zip engine (7z.exe) not found. Reinstall Unpacker V2 or install 7-Zip." };
    return;
  }
  engine = new sevenzip.SevenZip(exe);
  engineInfo = { path: exe, version: null, error: null };
  engine.version().then((v) => {
    engineInfo.version = v;
  });
  const rarExe = rarEngine.locate();
  rar = rarExe ? new rarEngine.Rar(rarExe) : null;
}

function initQueue() {
  runner = new Runner({
    sevenZip: engine,
    rar,
    settings: () => store.get(),
    trash: (p) => shell.trashItem(p),
    spawn: (spec) => {
      const j = queue.add(spec);
      if (spec.groupId) groups.attach(spec.groupId, j.id);
      return j;
    },
  });
  queue = new JobQueue((job, ctx) => {
    if (!engine) throw Object.assign(new Error(engineInfo.error), { kind: "fatal" });
    return runner.run(job, ctx);
  }, { concurrency: store.get().concurrency });
  queue.on("change", (job) => {
    if (mainWindow) mainWindow.webContents.send("jobs:change", job);
    onQueueActivity();
  });
  groups = new GroupRegistry({ queue, trash: (p) => shell.trashItem(p) });
  groups.on("change", (g) => mainWindow && mainWindow.webContents.send("groups:change", g));
  queue.on("removed", (id) => mainWindow && mainWindow.webContents.send("jobs:removed", id));
}

/**
 * Turn dropped/selected paths into jobs.
 * action: auto | compress | extract | convert | test
 */
async function addPaths({ paths = [], action = "auto", options = {} }) {
  const s = store.get();
  const added = [];
  const skipped = [];
  const toCompress = [];
  const seen = new Set();

  // Dropping Takeout parts in Auto mode opens the Takeout dialog instead of
  // extracting each part on its own: the parts belong together.
  if (action === "auto" && paths.length && paths.every((p) => takeout.isTakeoutPart(p))) {
    if (mainWindow) mainWindow.webContents.send("cli:request", { type: "takeout", paths: paths.map((p) => path.resolve(String(p))) });
    return { added: [], skipped: [], takeout: true };
  }

  // Several archives dropped at once in Auto mode: offer the mass-extract
  // dialog (destination, nested archives, cleanup) instead of N loose jobs.
  if (action === "auto" && paths.length >= 3 && paths.every((p) => {
    const det = formats.detectArchive(p);
    return det && det.entryPoint;
  })) {
    if (mainWindow) mainWindow.webContents.send("cli:request", { type: "extract-all", paths: paths.map((p) => path.resolve(String(p))) });
    return { added: [], skipped: [], massExtract: true };
  }

  for (const raw of paths) {
    const p = path.resolve(String(raw));
    if (seen.has(p.toLowerCase())) continue;
    seen.add(p.toLowerCase());
    if (activeInputs().has(p.toLowerCase())) {
      skipped.push({ path: p, reason: "already in the queue" });
      continue;
    }
    let st;
    try {
      st = await fsp.stat(p);
    } catch {
      skipped.push({ path: p, reason: "not found" });
      continue;
    }
    const det = st.isDirectory() ? null : formats.detectArchive(p);
    const isEntry = det && det.entryPoint;

    if (action === "compress") {
      toCompress.push(p);
    } else if (action === "auto") {
      if (isEntry) added.push(queue.add({ kind: "extract", label: path.basename(p), inputs: [p], options }));
      else if (det && !det.entryPoint) skipped.push({ path: p, reason: "part of a split set (opened from its first volume)" });
      else toCompress.push(p);
    } else if (isEntry) {
      added.push(queue.add({ kind: action, label: path.basename(p), inputs: [p], options }));
    } else if (det && !det.entryPoint) {
      skipped.push({ path: p, reason: "part of a split set (opened from its first volume)" });
    } else {
      skipped.push({ path: p, reason: "not an archive" });
    }
  }

  if (toCompress.length) {
    const onePerItem = options.onePerItem ?? s.onePerItem;
    const groups = onePerItem ? toCompress.map((p) => [p]) : [toCompress];
    for (const g of groups) {
      const label = g.length === 1 ? path.basename(g[0]) : `${g.length} items from ${path.basename(path.dirname(g[0])) || g[0]}`;
      added.push(queue.add({ kind: "compress", label, inputs: g, options }));
    }
  }
  return { added, skipped };
}

// ── IPC ─────────────────────────────────────────────────────────

function registerIpc() {
  ipcMain.handle("app:info", () => ({
    version: app.getVersion(),
    engine: engineInfo,
    rar: rar ? rar.exe : null,
    targets: formats.availableTargets({ rar: !!rar }),
    levels: formats.LEVELS,
    splitSizes: formats.SPLIT_SIZES,
    isPackaged: app.isPackaged,
  }));
  ipcMain.handle("settings:get", () => store.get());
  ipcMain.handle("settings:set", (_e, patch) => {
    const next = store.set(patch || {});
    if (patch && patch.concurrency) queue.setConcurrency(next.concurrency);
    return next;
  });

  ipcMain.handle("jobs:list", () => queue.listSafe());
  ipcMain.handle("jobs:addPaths", (_e, req) => addPaths(req || {}));
  ipcMain.handle("jobs:cancel", (_e, id) => queue.cancel(id));
  ipcMain.handle("jobs:retry", (_e, { id, patch }) => queue.retry(id, patch || {}));
  ipcMain.handle("jobs:remove", (_e, id) => queue.remove(id));
  ipcMain.handle("jobs:clearFinished", () => queue.clearFinished());
  ipcMain.handle("jobs:scanFolder", (_e, dir) => scan.scanFolder(dir));

  // Takeout: accepts part files and/or folders (folders are scanned one level
  // deep, which is where a browser download leaves them).
  ipcMain.handle("takeout:scan", async (_e, inputs) => {
    const files = [];
    for (const raw of inputs || []) {
      const p = path.resolve(String(raw));
      let st;
      try {
        st = await fsp.stat(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        for (const n of await fsp.readdir(p)) if (takeout.isTakeoutPart(n)) files.push(path.join(p, n));
      } else if (takeout.isTakeoutPart(p)) files.push(p);
    }
    const sizes = new Map();
    for (const f of files) sizes.set(f, (await fsp.stat(f)).size);
    return takeout.groupTakeout(files, (f) => sizes.get(f) || 0);
  });
  // Smart compress: analyze dropped inputs, then queue a pack job with the chosen plan.
  ipcMain.handle("pack:analyze", async (_e, { paths, password }) => {
    const a = await analyze.analyze((paths || []).map((p) => path.resolve(String(p))), { password: !!password, maxEntries: 500000 });
    return { ...a, chunkSizes: chunker.CHUNK_SIZES };
  });
  ipcMain.handle("pack:start", (_e, { paths, options }) => {
    const inputs = (paths || []).map((p) => path.resolve(String(p)));
    if (!inputs.length) return { added: [] };
    const label = inputs.length === 1 ? path.basename(inputs[0]) : `${inputs.length} items from ${path.basename(path.dirname(inputs[0])) || inputs[0]}`;
    return { added: [queue.add({ kind: "pack", label, inputs, options: { ...options, appVersion: app.getVersion() } })] };
  });
  ipcMain.handle("verify:manifest", async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: "Choose a manifest, or an archive that carries one",
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "Manifests and archives", extensions: ["txt", "7z", "zip", "rar", "tar", "gz", "xz", "bz2", "001"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (r.canceled) return { added: [] };
    return { added: r.filePaths.map((p) => queue.add({ kind: "verify-manifest", label: path.basename(p), inputs: [p], options: {} })) };
  });
  // Mass extract: scan inputs (files or folders) and start a sequential group.
  ipcMain.handle("massExtract:scan", (_e, paths) => scan.collectArchives(paths || []));
  ipcMain.handle("massExtract:start", (_e, { paths = [], options = {} }) => groups.start(paths, options));
  ipcMain.handle("groups:list", () => groups.list());
  ipcMain.handle("groups:cancel", (_e, id) => groups.cancel(id));
  ipcMain.handle("groups:remove", (_e, id) => groups.remove(id));
  ipcMain.handle("takeout:defaultDest", (_e, partPath) => path.join(path.dirname(path.resolve(partPath)), "Takeout-merged"));
  ipcMain.handle("takeout:start", (_e, { exports = [], options = {} }) => {
    const added = [];
    for (const ex of exports) {
      const parts = ex.parts.map((p) => (typeof p === "string" ? p : p.path));
      if (!parts.length) continue;
      const dest = options.dest || path.join(path.dirname(parts[0]), "Takeout-merged");
      added.push(
        queue.add({
          kind: "takeout",
          label: `Takeout ${ex.date || ex.stamp || ""} (${parts.length} part${parts.length === 1 ? "" : "s"})`,
          inputs: parts,
          options: { ...options, dest: exports.length > 1 ? path.join(dest, ex.stamp || ex.id) : dest },
        })
      );
    }
    return { added };
  });

  ipcMain.handle("dialog:chooseFiles", async () => {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ["openFile", "multiSelections"] });
    return r.canceled ? [] : r.filePaths;
  });
  ipcMain.handle("dialog:chooseFolder", async (_e, title) => {
    const r = await dialog.showOpenDialog(mainWindow, { title: title || "Choose folder", properties: ["openDirectory", "multiSelections"] });
    return r.canceled ? [] : r.filePaths;
  });
  ipcMain.handle("dialog:chooseArchives", async () => {
    const exts = shellIntegration.archiveExtensions().map((e) => e.slice(1));
    const r = await dialog.showOpenDialog(mainWindow, {
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "Archives", extensions: exts },
        { name: "All files", extensions: ["*"] },
      ],
    });
    return r.canceled ? [] : r.filePaths;
  });

  ipcMain.handle("shell:showInFolder", (_e, p) => {
    if (p && fs.existsSync(p)) shell.showItemInFolder(p);
  });
  ipcMain.handle("shell:openPath", (_e, p) => (p && fs.existsSync(p) ? shell.openPath(p) : "missing"));
  ipcMain.handle("shell:openExternal", (_e, url) => {
    if (/^https:\/\//.test(String(url))) shell.openExternal(url);
  });

  ipcMain.handle("contextMenu:get", () => shellIntegration.isRegistered());
  ipcMain.handle("contextMenu:set", async (_e, enabled) => {
    if (enabled) await shellIntegration.register(process.execPath);
    else await shellIntegration.unregister();
    store.set({ contextMenu: !!enabled });
    return shellIntegration.isRegistered();
  });

  ipcMain.handle("update:installNow", () => updater.installNow());
}

// ── lifecycle ───────────────────────────────────────────────────

app.whenReady().then(() => {
  store = new Store(app.getPath("userData"));
  initEngine();
  initQueue();
  registerIpc();
  createWindow();
  updater.start({
    enabled: store.get().autoUpdate,
    onStatus: (s) => mainWindow && mainWindow.webContents.send("update:status", s),
  });
  const cli = parseCli(process.argv.slice(app.isPackaged ? 1 : 2));
  if (cli.length) mainWindow.webContents.once("did-finish-load", () => handleCli(cli));
  const shotIdx = process.argv.indexOf("--screenshot");
  if (!app.isPackaged && shotIdx > 0 && process.argv[shotIdx + 1]) {
    mainWindow.setSize(1100, 720);
    mainWindow.webContents.once("did-finish-load", () => setTimeout(() => runScreenshots(path.resolve(process.argv[shotIdx + 1])).catch((e) => { console.error(e); app.quit(); }), 600));
  }
});

// ── long-job protection: close confirmation, tray, sleep blocker ──

let tray = null;
let quitting = false;
let blockerId = null;

/** Inputs of jobs that are still pending, for duplicate detection. */
function activeInputs() {
  const set = new Set();
  if (!queue) return set;
  for (const j of queue.list()) {
    if (j.state === "queued" || j.state === "running" || j.state === "needs-password") for (const p of j.inputs) set.add(path.resolve(p).toLowerCase());
  }
  return set;
}

/** Called on every queue change: keep the PC awake while busy, keep the tray current. */
function onQueueActivity() {
  const busy = queue.running > 0 || queue.pending > 0;
  const want = wantAwake({ running: queue.running, pending: queue.pending, preventSleep: store.get().preventSleep });
  if (want && blockerId == null) blockerId = powerSaveBlocker.start("prevent-app-suspension");
  if (!want && blockerId != null) {
    if (powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId);
    blockerId = null;
  }
  if (tray) tray.setToolTip(trayTooltip());
  if (mainWindow) mainWindow.webContents.send("app:activity", { busy, awake: blockerId != null });
}

function trayTooltip() {
  const r = queue ? queue.running : 0;
  const p = queue ? queue.pending : 0;
  return r || p ? `Unpacker V2 — ${r} running, ${p} queued` : "Unpacker V2 — idle";
}

function showTray() {
  if (tray) return;
  const icon = nativeImage.createFromPath(path.join(__dirname, "..", "..", "assets", "tray.png"));
  tray = new Tray(icon);
  tray.setToolTip(trayTooltip());
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Unpacker V2", click: showWindow },
      { label: "Cancel all jobs", click: () => queue && queue.list().forEach((j) => queue.cancel(j.id)) },
      { type: "separator" },
      { label: "Quit", click: quitNow },
    ])
  );
  tray.on("click", showWindow);
}

function hideTray() {
  if (tray) tray.destroy();
  tray = null;
}

function showWindow() {
  if (!mainWindow) createWindow();
  else {
    mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
  hideTray();
}

function quitNow() {
  quitting = true;
  if (queue) for (const j of queue.list()) if (j.state === "running" || j.state === "queued") queue.cancel(j.id);
  // Give the runners a beat to remove partial outputs before the process exits.
  setTimeout(() => app.quit(), 400);
}

async function handleClose(event) {
  if (quitting) return;
  const busy = queue && (queue.running > 0 || queue.pending > 0);
  const decision = closeDecision({ busy, closeToTray: store.get().closeToTray });
  if (decision === "quit") return; // default: window closes, app quits below
  event.preventDefault();
  if (decision === "hide") {
    showTray();
    mainWindow.hide();
    return;
  }
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: "question",
    title: "Jobs are still running",
    message: `${queue.running} job${queue.running === 1 ? " is" : "s are"} running and ${queue.pending} waiting.`,
    detail: "Keep them running in the background and Unpacker V2 stays in the tray until they finish. Cancelling removes any half-written archives.",
    buttons: ["Keep running in the background", "Cancel jobs and quit", "Stay"],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });
  if (response === 0) {
    showTray();
    mainWindow.hide();
  } else if (response === 1) {
    quitNow();
  }
}

// ── screenshot mode (docs) ──────────────────────────────────────
//   electron . --dev --screenshot <outDir>
// Builds sample files in temp, runs real jobs, opens each dialog with that
// sample data and saves PNGs. Never runs in a packaged build.

async function runScreenshots(outDir) {
  const os = require("node:os");
  const crypto = require("node:crypto");
  const { execFileSync } = require("node:child_process");
  fs.mkdirSync(outDir, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "unp-shots-"));
  const album = path.join(work, "Holiday 2026");
  fs.mkdirSync(path.join(album, "Day 1"), { recursive: true });
  fs.mkdirSync(path.join(album, "Day 2"), { recursive: true });
  for (let i = 1; i <= 6; i += 1) fs.writeFileSync(path.join(album, `Day ${i <= 3 ? 1 : 2}`, `IMG_${1000 + i}.jpg`), crypto.randomBytes(900_000));
  fs.writeFileSync(path.join(album, "Day 2", "clip.mp4"), crypto.randomBytes(4_000_000));
  fs.writeFileSync(path.join(album, "notes.txt"), "Trip notes\n".repeat(400));
  const docs = path.join(work, "Documents");
  fs.mkdirSync(docs);
  for (let i = 1; i <= 40; i += 1) fs.writeFileSync(path.join(docs, `report-${String(i).padStart(2, "0")}.txt`), `Quarterly report ${i}\n`.repeat(300));
  const dl = path.join(work, "Downloads");
  fs.mkdirSync(dl);
  const exe = engineInfo.path;
  execFileSync(exe, ["a", "-tzip", path.join(dl, "vacation-photos.zip"), "Holiday 2026"], { cwd: work, windowsHide: true });
  execFileSync(exe, ["a", "-t7z", path.join(dl, "project-files.7z"), "Documents"], { cwd: work, windowsHide: true });
  execFileSync(exe, ["a", "-ttar", path.join(work, "site.tar"), "Documents"], { cwd: work, windowsHide: true });
  execFileSync(exe, ["a", "-tgzip", path.join(dl, "site-backup.tar.gz"), path.join(work, "site.tar")], { cwd: work, windowsHide: true });
  const tk = path.join(work, "Takeout downloads");
  fs.mkdirSync(path.join(work, "tkstage", "Takeout", "Google Photos", "Trip"), { recursive: true });
  fs.writeFileSync(path.join(work, "tkstage", "Takeout", "Google Photos", "Trip", "IMG_1.jpg"), crypto.randomBytes(300_000));
  fs.mkdirSync(tk);
  for (const n of ["001", "002", "003", "005"]) execFileSync(exe, ["a", "-tzip", path.join(tk, `takeout-20260912T140102Z-${n}.zip`), "Takeout"], { cwd: path.join(work, "tkstage"), windowsHide: true });

  const shot = async (name) => {
    await new Promise((r) => setTimeout(r, 900));
    const img = await mainWindow.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, `${name}.png`), img.toPNG());
  };
  const open = (which, paths) => mainWindow.webContents.send("shot:open", { which, paths });
  const settle = () => new Promise((res) => {
    const check = () => (queue.running || queue.pending ? setTimeout(check, 150) : res());
    check();
  });

  // real jobs for the queue view
  queue.add({ kind: "extract", label: "vacation-photos.zip", inputs: [path.join(dl, "vacation-photos.zip")], options: {} });
  queue.add({ kind: "convert", label: "project-files.7z", inputs: [path.join(dl, "project-files.7z")], options: { format: "zip", level: 5 } });
  queue.add({ kind: "test", label: "site-backup.tar.gz", inputs: [path.join(dl, "site-backup.tar.gz")], options: {} });
  await settle();
  queue.add({ kind: "pack", label: "Holiday 2026", inputs: [album], options: { format: "zip", level: 0, chunkSize: "", manifest: true, hash: true, appVersion: app.getVersion() } });
  await new Promise((r) => setTimeout(r, 400));
  await shot("01-queue");
  await settle();
  await shot("02-queue-done");
  open("pack", [album]);
  await shot("03-smart-compress");
  open("takeout", [tk]);
  await shot("04-takeout");
  open("massExtract", [dl]);
  await shot("05-mass-extract");
  open("convert", [path.join(dl, "vacation-photos.zip"), path.join(dl, "project-files.7z"), path.join(dl, "site-backup.tar.gz")]);
  await shot("06-mass-convert");
  open("settings", []);
  await shot("07-settings");
  fs.rmSync(work, { recursive: true, force: true });
  console.log(`screenshots written to ${outDir}`);
  app.quit();
}

app.on("window-all-closed", () => {
  // Reached only when the window really closed (idle, or user chose to quit).
  if (tray) return; // hidden to tray: keep running
  if (queue) for (const j of queue.list()) if (j.state === "running") queue.cancel(j.id);
  app.quit();
});

app.on("before-quit", () => {
  quitting = true;
});

