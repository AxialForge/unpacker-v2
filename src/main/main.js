// Electron main process: window, engine wiring, the job queue, IPC, and the
// command-line entry points used by the Explorer context menu.

const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const { Store } = require("./store");
const formats = require("./engine/formats");
const sevenzip = require("./engine/sevenzip");
const rarEngine = require("./engine/rar");
const { JobQueue } = require("./jobs/queue");
const { Runner } = require("./jobs/runner");
const shellIntegration = require("./shell-integration");
const updater = require("./updater");

const DEV = process.argv.includes("--dev");

// ── single instance + CLI ───────────────────────────────────────
// Explorer launches one process per selected item. The first instance wins the
// lock; later ones forward their argv here and exit. Compress requests that
// arrive within a short window are merged into ONE archive, which is what a
// multi-select "Add to archive" should mean.

const { parseCli } = require("./cli");

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
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
  });
  queue = new JobQueue((job, ctx) => {
    if (!engine) throw Object.assign(new Error(engineInfo.error), { kind: "fatal" });
    return runner.run(job, ctx);
  }, { concurrency: store.get().concurrency });
  queue.on("change", (job) => mainWindow && mainWindow.webContents.send("jobs:change", job));
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

  for (const raw of paths) {
    const p = path.resolve(String(raw));
    if (seen.has(p.toLowerCase())) continue;
    seen.add(p.toLowerCase());
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

/** Recursively list archive entry points under a folder (for mass convert). */
async function scanFolder(dir, signalDepth = 0) {
  const found = [];
  const walk = async (d, depth) => {
    let entries = [];
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (depth < 64) await walk(p, depth + 1);
      } else {
        const det = formats.detectArchive(p);
        if (det && det.entryPoint) found.push(p);
      }
      if (found.length > 20000) return;
    }
  };
  await walk(dir, signalDepth);
  return found;
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

  ipcMain.handle("jobs:list", () => queue.list());
  ipcMain.handle("jobs:addPaths", (_e, req) => addPaths(req || {}));
  ipcMain.handle("jobs:cancel", (_e, id) => queue.cancel(id));
  ipcMain.handle("jobs:retry", (_e, { id, patch }) => queue.retry(id, patch || {}));
  ipcMain.handle("jobs:remove", (_e, id) => queue.remove(id));
  ipcMain.handle("jobs:clearFinished", () => queue.clearFinished());
  ipcMain.handle("jobs:scanFolder", (_e, dir) => scanFolder(dir));

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
});

app.on("window-all-closed", () => {
  // Let running jobs finish? No: closing the window is the user's cancel.
  if (queue) for (const j of queue.list()) if (j.state === "running") queue.cancel(j.id);
  app.quit();
});
