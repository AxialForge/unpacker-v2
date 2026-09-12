// Guards that keep a hostile or broken archive from hurting the machine.
// Pure functions; unit-tested.

const path = require("node:path");

/**
 * Entry paths that would escape the extraction folder. 7-Zip itself strips
 * absolute paths and ".." on extract, but we refuse such archives up front so
 * the user sees WHY instead of a silently rearranged tree.
 */
function unsafeEntries(entryPaths) {
  const bad = [];
  for (const raw of entryPaths || []) {
    const p = String(raw).replace(/\\/g, "/");
    if (
      /^[a-zA-Z]:/.test(p) || // C:...
      p.startsWith("/") || // rooted (also covers // UNC)
      p.split("/").some((seg) => seg === "..")
    ) {
      bad.push(raw);
    }
  }
  return bad;
}

/**
 * Zip-bomb heuristic. Legit archives of text can reach 100:1; a crafted bomb
 * is 1000:1 and up while also being big. Both conditions must hold.
 */
function bombRisk({ packed, size }) {
  if (!packed || !size) return false;
  const ratio = size / packed;
  return ratio > 1000 && size > 1024 ** 3;
}

/** Win32 long-path prefix for Node fs calls near MAX_PATH. 7-Zip handles its own. */
function longPath(p, platform = process.platform) {
  if (platform !== "win32") return p;
  if (!p || p.startsWith("\\\\?\\")) return p;
  if (p.length < 240) return p;
  if (p.startsWith("\\\\")) return `\\\\?\\UNC\\${p.slice(2)}`;
  return `\\\\?\\${p}`;
}

/**
 * First path that doesn't exist: "x.zip", "x (2).zip", "x (3).zip"...
 * `exists` is injected so it can be tested without a filesystem. Handles the
 * double extension of compound formats ("x.tar.gz" -> "x (2).tar.gz").
 */
function uniquePath(target, exists, { ext } = {}) {
  if (!exists(target)) return target;
  const dir = path.dirname(target);
  const base = path.basename(target);
  const suffix = ext && base.toLowerCase().endsWith(ext.toLowerCase()) ? base.slice(-ext.length) : path.extname(base);
  const stem = base.slice(0, base.length - suffix.length);
  for (let i = 2; i < 10000; i += 1) {
    const candidate = path.join(dir, `${stem} (${i})${suffix}`);
    if (!exists(candidate)) return candidate;
  }
  throw new Error(`Could not find a free name for ${target}`);
}

/** Strip characters Windows refuses in file names. */
function safeFileName(name) {
  // eslint-disable-next-line no-control-regex
  const cleaned = String(name || "")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/[. ]+$/, "")
    .trim();
  return cleaned || "archive";
}

function fmtBytes(n) {
  if (n == null || !Number.isFinite(n)) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

module.exports = { unsafeEntries, bombRisk, longPath, uniquePath, safeFileName, fmtBytes };
