// Google Takeout support.
//
// Takeout hands you a run of INDEPENDENT archives, not a split set:
//   takeout-20260912T140102Z-001.zip, -002.zip, ... (or .tgz)
// Every part has the same "Takeout/" root and the intent is always to merge
// them into one tree. This module groups parts into exports (pure, tested) and
// holds the small post-processing helpers the takeout job uses.

const fs = require("node:fs");
const path = require("node:path");

const PART_RX = /^takeout-(\d{8}T\d{6}Z)-(\d{3})\.(zip|tgz|tar\.gz)$/i;

/** { stamp, index, format } for a Takeout part file name, else null. */
function parseTakeoutName(filePath) {
  const m = PART_RX.exec(path.basename(String(filePath || "")));
  if (!m) return null;
  return { stamp: m[1], index: parseInt(m[2], 10), format: m[3].toLowerCase() === "zip" ? "zip" : "tgz" };
}

const isTakeoutPart = (p) => parseTakeoutName(p) != null;

/**
 * Group part paths into exports keyed by their timestamp.
 * @param {string[]} paths
 * @param {(p:string)=>number} [sizeOf]  optional byte size lookup
 * @returns {Array<{ id, stamp, date, format, parts:[{path,index,size}], missing:number[], totalBytes }>}
 */
function groupTakeout(paths, sizeOf = () => 0) {
  const byStamp = new Map();
  for (const p of paths || []) {
    const info = parseTakeoutName(p);
    if (!info) continue;
    const key = `${info.stamp}-${info.format}`;
    if (!byStamp.has(key)) byStamp.set(key, { id: key, stamp: info.stamp, date: stampToDate(info.stamp), format: info.format, parts: [], missing: [], totalBytes: 0 });
    const g = byStamp.get(key);
    if (g.parts.some((x) => x.index === info.index)) continue; // same part twice (e.g. copy in a subfolder)
    const size = sizeOf(p) || 0;
    g.parts.push({ path: p, index: info.index, size });
    g.totalBytes += size;
  }
  const out = [];
  for (const g of byStamp.values()) {
    g.parts.sort((a, b) => a.index - b.index);
    const last = g.parts[g.parts.length - 1].index;
    for (let i = 1; i <= last; i += 1) if (!g.parts.some((p) => p.index === i)) g.missing.push(i);
    out.push(g);
  }
  return out.sort((a, b) => (a.stamp < b.stamp ? 1 : -1));
}

/** "20260912T140102Z" -> "2026-09-12 14:01 UTC" */
function stampToDate(stamp) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(stamp);
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]} UTC` : stamp;
}

/**
 * Move the contents of <dest>/Takeout up into <dest> and remove the wrapper.
 * Same-volume renames, so it's instant even for terabytes. Existing targets are
 * merged directory-by-directory; existing files are left alone.
 */
function flattenRoot(dest, rootName = "Takeout") {
  const root = path.join(dest, rootName);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return { moved: 0, skipped: 0 };
  const stats = { moved: 0, skipped: 0 };
  const mergeUp = (from, to) => {
    for (const name of fs.readdirSync(from)) {
      const src = path.join(from, name);
      const dst = path.join(to, name);
      const srcIsDir = fs.statSync(src).isDirectory();
      if (!fs.existsSync(dst)) {
        fs.renameSync(src, dst);
        stats.moved += 1;
      } else if (srcIsDir && fs.statSync(dst).isDirectory()) {
        mergeUp(src, dst);
      } else {
        stats.skipped += 1;
      }
    }
    try {
      fs.rmdirSync(from);
    } catch {
      /* not empty: something was skipped */
    }
  };
  mergeUp(root, dest);
  return stats;
}

/**
 * Google Photos writes a JSON sidecar next to every photo/video (and a
 * metadata.json per album). Some people want them out of the way. This moves
 * every .json under any "Google Photos" folder into a sibling "_json" folder,
 * keeping the album structure so they can be put back or used later.
 */
function tidyPhotoSidecars(dest) {
  let moved = 0;
  const walk = (dir, inPhotos) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "_json") continue;
        walk(p, inPhotos || /^google photos$/i.test(e.name));
      } else if (inPhotos && /\.json$/i.test(e.name)) {
        const target = path.join(dir, "_json");
        fs.mkdirSync(target, { recursive: true });
        fs.renameSync(p, path.join(target, e.name));
        moved += 1;
      }
    }
  };
  walk(dest, false);
  return { moved };
}

// ── resume state ────────────────────────────────────────────────
const STATE_FILE = ".unpacker-takeout.json";

function readState(dest) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dest, STATE_FILE), "utf8"));
  } catch {
    return { done: {} };
  }
}

function writeState(dest, state) {
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, STATE_FILE), JSON.stringify(state, null, 2));
}

/** A part counts as done if the same file (name, size, mtime) was extracted before. */
function partIsDone(state, part, st) {
  const rec = state.done[path.basename(part.path)];
  return !!rec && rec.size === st.size && rec.mtimeMs === st.mtimeMs;
}

function clearState(dest) {
  fs.rmSync(path.join(dest, STATE_FILE), { force: true });
}

module.exports = { PART_RX, parseTakeoutName, isTakeoutPart, groupTakeout, stampToDate, flattenRoot, tidyPhotoSidecars, readState, writeState, partIsDone, clearState, STATE_FILE };
