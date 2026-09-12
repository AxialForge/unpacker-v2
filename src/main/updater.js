// Silent auto-update from GitHub Releases. No installer wizard, no prompts.
//
// This is the DEFAULT updater for AxialForge Electron apps: on launch (and on an
// optional interval) it checks the repo's Releases, downloads a newer build in
// the background, and installs it silently the next time the app quits. The user
// is never interrupted and never sees the NSIS wizard.
//
//   check on launch  ->  autoDownload in background  ->  install on next quit
//
// Requires, and is inseparable from, three build-time facts (see INTEGRATION.md):
//   1. electron-builder.yml `publish: { provider: github, owner: AxialForge }`
//      — bakes the update feed URL into the app AND generates `latest.yml`.
//   2. NSIS `oneClick: true` + `allowToChangeInstallationDirectory: false`
//      — a one-click installer has no wizard, so the silent update has none either.
//   3. The release actually contains `latest.yml` and the installer's `.blockmap`.
//      WITHOUT `latest.yml` IN THE RELEASE, THIS CODE SILENTLY FINDS NOTHING —
//      it is the single most common way an Electron updater "does nothing." The
//      template's node-electron-release.yml uploads them; don't drop them.
//
// NOTE ON THE OFFLINE TRADE-OFF. A silent background update touches the network
// without asking. For most apps that's the expected, invisible-maintenance
// behaviour. For an app whose selling point is "fully offline / no telemetry"
// (e.g. jdot-utilities), a background version-check is indistinguishable from
// telemetry to a privacy-minded user — those apps want the MANUAL updater
// instead, not this one. Pick deliberately.
//
// Security chain, unsigned: HTTPS to GitHub (transport) + the SHA-512 in
// latest.yml verified against the download (integrity). Code-sign the build to
// add Authenticode publisher verification (authenticity) before anything runs.

// electron-updater reads app.getVersion() at import, so it can only be required
// inside Electron. It is loaded lazily in configure() — never at module scope —
// so the pure comparator below stays usable (and testable) in plain node, and a
// `node --test` suite doesn't need an Electron runtime.
let autoUpdater = null;

// ── version comparison ─────────────────────────────────────────
// electron-updater compares versions itself; this small, tested comparator lets
// the app state a clear "up to date / vX is newer", and lets us refuse an
// "update-available" whose offered version isn't actually higher — a cheap guard
// against a misconfigured or rolled-back feed serving an older build.

/** Parse "1.2.3", "v1.2.3", "1.2.3-beta.4" into { nums:[1,2,3], pre:"beta.4" }. */
function parseVersion(v) {
  const cleaned = String(v == null ? "" : v).trim().replace(/^v/i, "");
  const [core, ...preParts] = cleaned.split("-");
  const nums = core.split(".").map((n) => {
    const x = parseInt(n, 10);
    return Number.isFinite(x) ? x : 0;
  });
  while (nums.length < 3) nums.push(0);
  return { nums: nums.slice(0, 3), pre: preParts.join("-") };
}

/**
 * Compare two semantic versions. Returns 1 if a > b, -1 if a < b, 0 if equal.
 * A pre-release (1.0.0-beta) is LOWER than its release (1.0.0), per semver.
 */
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    if (pa.nums[i] > pb.nums[i]) return 1;
    if (pa.nums[i] < pb.nums[i]) return -1;
  }
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && !pb.pre) return -1;
  if (pa.pre === pb.pre) return 0;
  return pa.pre > pb.pre ? 1 : -1; // lexical is good enough for our tags
}

/** Is `candidate` strictly newer than `current`? */
const isNewer = (candidate, current) => compareVersions(candidate, current) > 0;

// ── on/off policy ──────────────────────────────────────────────
/**
 * Decide whether auto-update is allowed to run. `NO_AUTO_UPDATE` in the
 * environment is an ENFORCED kill-switch — for locked-down or managed machines,
 * air-gapped deployments, or CI — that no user setting can override. Kept pure
 * and exported so it can be enforced (not just used to hide UI) and tested
 * without Electron.
 */
function updatesAllowed({ env = {}, enabled } = {}) {
  if (env.NO_AUTO_UPDATE) return { enabled: false, enforced: true };
  return { enabled: enabled !== false, enforced: false };
}

// ── the updater ────────────────────────────────────────────────

let wired = false;
let timer = null;
let emit = () => {};

/** Optional status sink so the app can show "update ready — restart to apply". */
function onStatus(cb) {
  emit = typeof cb === "function" ? cb : () => {};
}

function configure() {
  if (wired) return;
  ({ autoUpdater } = require("electron-updater")); // Electron-only; see note at top
  wired = true;

  autoUpdater.autoDownload = true; // fetch a newer build in the background
  autoUpdater.autoInstallOnAppQuit = true; // and install it silently on next quit
  autoUpdater.allowDowngrade = false;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on("checking-for-update", () => emit({ state: "checking" }));
  autoUpdater.on("update-available", (info) => emit({ state: "available", version: info?.version || null }));
  autoUpdater.on("update-not-available", (info) => emit({ state: "current", version: info?.version || null }));
  autoUpdater.on("download-progress", (p) =>
    emit({ state: "downloading", percent: Math.round(p?.percent || 0) })
  );
  // Staged. autoInstallOnAppQuit applies it silently on close; the app MAY use
  // this event to offer an optional "Restart now" that calls installNow().
  autoUpdater.on("update-downloaded", (info) => emit({ state: "ready", version: info?.version || null }));
  autoUpdater.on("error", (err) => emit({ state: "error", message: friendlyError(err) }));
}

// electron-updater's raw errors are developer-facing; translate the common ones.
function friendlyError(err) {
  const msg = (err && err.message ? err.message : String(err)) || "Update check failed.";
  if (/not packed|dev update config/i.test(msg)) return "Updates only run in the installed app.";
  if (/net::|ENOTFOUND|EAI_AGAIN|getaddrinfo|ETIMEDOUT|ECONNREFUSED/i.test(msg)) return "Couldn't reach GitHub.";
  if (/404|no published versions|latest\.yml/i.test(msg)) return "No update information in the latest release.";
  return msg.split("\n")[0].slice(0, 200);
}

/**
 * Wire up and start silent auto-update. Call ONCE, after app.whenReady().
 *
 *   const updater = require("./updater");
 *   app.whenReady().then(() => { createWindow(); updater.start(); });
 *
 * @param {object}   [opts]
 * @param {function} [opts.onStatus]   status sink (see onStatus)
 * @param {number}   [opts.intervalHours=6]  re-check cadence for long-running
 *                   apps; 0 disables the interval (launch-only check).
 * @param {boolean}  [opts.enabled]    pass a user setting; false disables.
 */
function start(opts = {}) {
  const { app } = require("electron");
  if (typeof opts.onStatus === "function") onStatus(opts.onStatus);

  const gate = updatesAllowed({ env: process.env, enabled: opts.enabled });
  if (!gate.enabled) return;

  // Unpacked/dev builds have no installer to replace; electron-updater no-ops
  // (checkForUpdates resolves but emits nothing). Skip cleanly — no error noise.
  if (!app.isPackaged) return;

  configure();
  if (!autoUpdater.isUpdaterActive()) return;

  const tick = () => autoUpdater.checkForUpdates().catch((err) => emit({ state: "error", message: friendlyError(err) }));
  tick();

  const hours = opts.intervalHours == null ? 6 : opts.intervalHours;
  if (hours > 0) {
    timer = setInterval(tick, hours * 60 * 60 * 1000);
    if (timer.unref) timer.unref(); // don't keep the process alive for the timer
  }
}

/** Optional: apply a staged update right now instead of waiting for quit. */
function installNow() {
  if (!wired) return { ok: false, error: "not-configured" };
  // isSilent:true → no wizard; isForceRunAfter:true → relaunch after install.
  setImmediate(() => autoUpdater.quitAndInstall(true, true));
  return { ok: true };
}

module.exports = {
  start,
  installNow,
  onStatus,
  // pure helpers, exported for tests / UI:
  compareVersions,
  isNewer,
  parseVersion,
  updatesAllowed,
};
