// Find archives under folders (or accept files directly) and summarise them.
// Shared by mass convert, mass extract and nested extraction.

const fsp = require("node:fs/promises");
const path = require("node:path");
const { detectArchive } = require("./engine/formats");

/**
 * Recursively list archive entry points under `dir`.
 * @param {string} dir
 * @param {{ maxDepth?: number, limit?: number, skip?: Set<string> }} o  skip: lower-cased absolute paths to ignore
 */
async function scanFolder(dir, o = {}) {
  const maxDepth = o.maxDepth == null ? 64 : o.maxDepth;
  const limit = o.limit || 20000;
  const found = [];
  const walk = async (d, depth) => {
    let entries = [];
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (found.length >= limit) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth) await walk(p, depth + 1);
      } else if (!e.isSymbolicLink()) {
        const det = detectArchive(p);
        if (det && det.entryPoint && !(o.skip && o.skip.has(p.toLowerCase()))) found.push(p);
      }
    }
  };
  await walk(path.resolve(dir), 0);
  return found;
}

/**
 * Accept a mix of files and folders; return archive entry points (deduped)
 * plus a summary: total bytes and counts by detected type.
 */
async function collectArchives(inputs, o = {}) {
  const files = [];
  const seen = new Set();
  for (const raw of inputs || []) {
    const p = path.resolve(String(raw));
    let st;
    try {
      st = await fsp.stat(p);
    } catch {
      continue;
    }
    const list = st.isDirectory() ? await scanFolder(p, o) : detectArchive(p) && detectArchive(p).entryPoint ? [p] : [];
    for (const f of list) {
      const k = f.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      files.push(f);
    }
  }
  const byType = {};
  let totalBytes = 0;
  const items = [];
  for (const f of files) {
    let size = 0;
    try {
      size = (await fsp.stat(f)).size;
    } catch {
      /* vanished */
    }
    const det = detectArchive(f);
    const type = det ? (det.inner ? `${det.inner}.${det.type === "gzip" ? "gz" : det.type}` : det.type) : "?";
    byType[type] = (byType[type] || 0) + 1;
    totalBytes += size;
    items.push({ path: f, size, type });
  }
  return { items, totalBytes, byType };
}

module.exports = { scanFolder, collectArchives };
