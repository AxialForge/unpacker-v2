// The optional export log: two plain files at the top of a finished mass job
// that say what is there, without rearranging anything.
//
//   What's in here.txt   a summary a person can read in half a minute
//   Contents.csv         every file: folder, name, size, date, kind, source
//
// The folder structure is left exactly as the archives (or the organiser)
// produced it; this module only reads and describes. Electron-free.
// (Planned for later, by request: an index.html overview next to the text log.)

const fs = require("node:fs");
const path = require("node:path");
const { fmtBytes } = require("./safety");

const SUMMARY = "What's in here.txt";
const CONTENTS = "Contents.csv";

const KINDS = {
  Photos: [".jpg", ".jpeg", ".heic", ".heif", ".png", ".gif", ".webp", ".avif", ".bmp", ".tif", ".tiff", ".dng", ".cr2", ".cr3", ".nef", ".arw", ".raf", ".orf", ".svg"],
  Videos: [".mp4", ".mov", ".m4v", ".mkv", ".avi", ".webm", ".3gp", ".mts", ".m2ts", ".mpg", ".mpeg", ".wmv"],
  Audio: [".mp3", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".wma", ".wav", ".aiff"],
  Documents: [".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods", ".odp", ".txt", ".md", ".rtf", ".csv", ".tsv", ".html", ".htm", ".json", ".xml", ".eml", ".mbox", ".vcf", ".ics", ".epub"],
  Archives: [".zip", ".7z", ".rar", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".zst", ".cab", ".iso", ".wim", ".001"],
};
const EXT_KIND = new Map();
for (const [k, exts] of Object.entries(KINDS)) for (const e of exts) EXT_KIND.set(e, k);
const KIND_ORDER = ["Photos", "Videos", "Audio", "Documents", "Archives", "Other"];

const kindOf = (name) => EXT_KIND.get(path.extname(String(name)).toLowerCase()) || "Other";

function walk(root, onFile, limit, skipDirs = new Set()) {
  let n = 0;
  const go = (d) => {
    if (skipDirs.has(d.toLowerCase())) return;
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (n >= limit) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) go(p);
      else if (e.isFile()) {
        let st;
        try {
          st = fs.statSync(p);
        } catch {
          continue;
        }
        n += 1;
        onFile(p, st);
      }
    }
  };
  go(root);
  return n;
}

const csvCell = (c) => (/[",\r\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : String(c));

/**
 * Collect the inventory (pure apart from reading the disk).
 * @param {string} dir          where the log will live; paths are shown relative to it
 * @param {Array<{path:string, source?:string}>} roots  folders to describe
 * @param {object} o { limit, skip:Set<lowercased absolute file paths>, skipDirs:Set<lowercased absolute folder paths> }
 */
function inventory(dir, roots, o = {}) {
  const limit = o.limit || 500000;
  const skip = o.skip || new Set();
  const seen = new Set();
  const files = [];
  // a root that sits inside another listed root would be counted twice
  const sorted = [...roots].map((r) => ({ ...r, path: path.resolve(r.path) })).sort((a, b) => a.path.length - b.path.length);
  const kept = [];
  for (const r of sorted) {
    const inside = kept.find((k) => r.path.toLowerCase() === k.path.toLowerCase() || r.path.toLowerCase().startsWith(`${k.path.toLowerCase()}${path.sep}`));
    if (inside) {
      if (inside.path.toLowerCase() === r.path.toLowerCase() && inside.source !== r.source) inside.source = "several archives";
      continue;
    }
    kept.push(r);
  }
  let truncated = false;
  for (const r of kept) {
    const count = walk(
      r.path,
      (p, st) => {
        const key = p.toLowerCase();
        if (seen.has(key) || skip.has(key)) return;
        const base = path.basename(p);
        if (base === SUMMARY || base === CONTENTS) return;
        seen.add(key);
        const rel = path.relative(dir, p);
        files.push({ rel: rel.startsWith("..") ? p : rel, size: st.size, mtime: st.mtime, kind: kindOf(base), source: r.source || "" });
      },
      limit - files.length,
      o.skipDirs || new Set()
    );
    if (count >= limit - files.length && files.length >= limit) truncated = true;
  }
  return { files, truncated };
}

/** Group files by their first folder (relative to the log's folder). */
function summarise(files) {
  const groups = new Map();
  const totals = { files: 0, bytes: 0, kinds: Object.fromEntries(KIND_ORDER.map((k) => [k, 0])) };
  for (const f of files) {
    const seg = f.rel.split(/[\\/]/);
    const top = path.isAbsolute(f.rel) ? path.dirname(f.rel) : seg.length > 1 ? seg[0] : "(files at the top)";
    if (!groups.has(top)) groups.set(top, { name: top, files: 0, bytes: 0, kinds: Object.fromEntries(KIND_ORDER.map((k) => [k, 0])), oldest: null, newest: null });
    const g = groups.get(top);
    g.files += 1;
    g.bytes += f.size;
    g.kinds[f.kind] += 1;
    if (!g.oldest || f.mtime < g.oldest) g.oldest = f.mtime;
    if (!g.newest || f.mtime > g.newest) g.newest = f.mtime;
    totals.files += 1;
    totals.bytes += f.size;
    totals.kinds[f.kind] += 1;
  }
  return { groups: [...groups.values()].sort((a, b) => a.name.localeCompare(b.name)), totals };
}

const kindsLine = (kinds) => KIND_ORDER.filter((k) => kinds[k]).map((k) => `${kinds[k].toLocaleString("en-US")} ${k.toLowerCase()}`).join(", ") || "nothing";
const day = (d) => (d ? d.toISOString().slice(0, 10) : "");

/**
 * Write the two log files into `dir`.
 * @param {object} a
 *   dir, title, roots:[{path, source}], sources:[{name, state, output, error}],
 *   notes:[text], skip:Set, now:Date
 * @returns {{ summary:string, contents:string, files:number, bytes:number }}
 */
function write(a) {
  const dir = path.resolve(a.dir);
  fs.mkdirSync(dir, { recursive: true });
  const { files, truncated } = inventory(dir, a.roots || [{ path: dir }], { skip: a.skip, skipDirs: new Set((a.skipDirs || []).map((p) => path.resolve(p).toLowerCase())), limit: a.limit });
  const { groups, totals } = summarise(files);
  const now = a.now || new Date();
  const L = [];
  L.push(a.title || "Export");
  L.push("=".repeat((a.title || "Export").length));
  L.push("");
  L.push(`Made by Unpacker V2 on ${now.toISOString().slice(0, 10)}.`);
  L.push(`This folder holds ${totals.files.toLocaleString("en-US")} files, ${fmtBytes(totals.bytes)} in total: ${kindsLine(totals.kinds)}.`);
  L.push("Folders are exactly as they were inside the archives; nothing was rearranged.");
  if (truncated) L.push("The list was cut short: there are more files than this log records.");
  L.push("");
  L.push("What is in each folder");
  L.push("----------------------");
  const w = Math.min(48, Math.max(12, ...groups.map((g) => g.name.length)));
  for (const g of groups) {
    L.push(`${g.name.padEnd(w)}  ${String(g.files.toLocaleString("en-US")).padStart(8)} files  ${fmtBytes(g.bytes).padStart(8)}  ${kindsLine(g.kinds)}`);
    if (g.oldest) L.push(`${" ".repeat(w)}  dated ${day(g.oldest)}${day(g.newest) !== day(g.oldest) ? ` to ${day(g.newest)}` : ""}`);
  }
  if (!groups.length) L.push("(no files)");
  const sources = a.sources || [];
  if (sources.length) {
    const good = sources.filter((s) => s.state === "done");
    const bad = sources.filter((s) => s.state !== "done");
    L.push("");
    L.push("Where it came from");
    L.push("------------------");
    L.push(`${good.length} of ${sources.length} archives were extracted.`);
    for (const s of good) L.push(`  ${s.name}${s.output ? `  ->  ${path.relative(dir, s.output) || "."}` : ""}`);
    if (bad.length) {
      L.push("");
      L.push("Needs attention");
      L.push("---------------");
      for (const s of bad) L.push(`  ${s.name}: ${s.state}${s.error ? ` (${s.error})` : ""}`);
    }
  }
  if (a.notes && a.notes.length) {
    L.push("");
    L.push("Notes");
    L.push("-----");
    for (const n of a.notes) L.push(`  ${n}`);
  }
  L.push("");
  L.push(`Every file is listed in "${CONTENTS}" (open it in Excel): folder, name, size, date, kind and the archive it came from.`);
  const summaryPath = path.join(dir, SUMMARY);
  fs.writeFileSync(summaryPath, `${L.join("\r\n")}\r\n`, "utf8");

  const rows = [["folder", "file", "size (bytes)", "modified", "kind", "came from"]];
  for (const f of files) rows.push([path.dirname(f.rel) === "." ? "" : path.dirname(f.rel), path.basename(f.rel), f.size, f.mtime.toISOString().replace(/\.\d{3}Z$/, "Z"), f.kind, f.source]);
  const contentsPath = path.join(dir, CONTENTS);
  fs.writeFileSync(contentsPath, `﻿${rows.map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`, "utf8");
  return { summary: summaryPath, contents: contentsPath, files: totals.files, bytes: totals.bytes };
}

module.exports = { write, inventory, summarise, kindOf, SUMMARY, CONTENTS, KIND_ORDER };
