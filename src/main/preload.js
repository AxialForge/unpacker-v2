// The only bridge between the renderer and the main process. Nothing else is
// exposed; the renderer has no Node access.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

const on = (channel, cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld("unpacker", {
  appInfo: () => ipcRenderer.invoke("app:info"),
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    set: (patch) => ipcRenderer.invoke("settings:set", patch),
  },
  jobs: {
    list: () => ipcRenderer.invoke("jobs:list"),
    addPaths: (req) => ipcRenderer.invoke("jobs:addPaths", req),
    cancel: (id) => ipcRenderer.invoke("jobs:cancel", id),
    retry: (id, patch) => ipcRenderer.invoke("jobs:retry", { id, patch }),
    remove: (id) => ipcRenderer.invoke("jobs:remove", id),
    clearFinished: () => ipcRenderer.invoke("jobs:clearFinished"),
    scanFolder: (dir) => ipcRenderer.invoke("jobs:scanFolder", dir),
    onChange: (cb) => on("jobs:change", cb),
    onRemoved: (cb) => on("jobs:removed", cb),
  },
  pack: {
    analyze: (paths, password) => ipcRenderer.invoke("pack:analyze", { paths, password }),
    start: (paths, options) => ipcRenderer.invoke("pack:start", { paths, options }),
    verifyManifest: () => ipcRenderer.invoke("verify:manifest"),
  },
  takeout: {
    // scan(paths|folders) -> exports grouped by timestamp with sizes and gaps
    scan: (paths) => ipcRenderer.invoke("takeout:scan", paths),
    // start({ exports:[{parts:[paths]}], options }) -> one job per export
    start: (req) => ipcRenderer.invoke("takeout:start", req),
    defaultDest: (partPath) => ipcRenderer.invoke("takeout:defaultDest", partPath),
  },
  dialog: {
    chooseFiles: () => ipcRenderer.invoke("dialog:chooseFiles"),
    chooseFolder: (title) => ipcRenderer.invoke("dialog:chooseFolder", title),
    chooseArchives: () => ipcRenderer.invoke("dialog:chooseArchives"),
  },
  shell: {
    showInFolder: (p) => ipcRenderer.invoke("shell:showInFolder", p),
    openPath: (p) => ipcRenderer.invoke("shell:openPath", p),
    openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),
  },
  contextMenu: {
    get: () => ipcRenderer.invoke("contextMenu:get"),
    set: (enabled) => ipcRenderer.invoke("contextMenu:set", enabled),
  },
  update: {
    installNow: () => ipcRenderer.invoke("update:installNow"),
    onStatus: (cb) => on("update:status", cb),
  },
  // Drag-and-drop: the renderer hands us File objects, we hand back real paths.
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
  // { busy, awake }: whether jobs are running and the sleep blocker is held.
  onActivity: (cb) => on("app:activity", cb),
  // Explorer verbs that need a decision (extract-to, convert) arrive here.
  onCliRequest: (cb) => on("cli:request", cb),
});
