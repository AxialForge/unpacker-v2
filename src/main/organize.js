// Turn a merged Google Takeout tree into clean per-service libraries.
//
//   <root>/Takeout/Google Photos/<album or "Photos from YYYY">/IMG.jpg
//                               + IMG.jpg.supplemental-metadata.json   -> Library/Photos/2019/07/IMG.jpg
//   <root>/Takeout/Drive/...                                            -> Library/Drive/...
//   <root>/Takeout/Mail/*.mbox                                          -> Library/Mail/
//   <root>/Takeout/<anything else>/...                                  -> Library/<Service>/...
//
// `root` may be the folder that holds "Takeout/", the "Takeout" folder itself,
// or a folder with several per-part extractions each holding a "Takeout/"
// (what a browser leaves when parts were unpacked one by one). All are found.
//
// Photos get, by option: file dates from the JSON, EXIF DateTimeOriginal for
// JPEGs, Year/Month folders, and duplicate removal by SHA-256 (Takeout repeats
// a photo in every album it belongs to). Album membership survives in
// Library/Photos/Albums.txt. Files are MOVED (renamed) when the library is on
// the same volume, copied otherwise. Nothing is deleted outright: duplicates
// and unwanted sidecars go through `trash` (the Recycle Bin in the app).
//
// Electron-free; exercised by node tests and the scratch e2e.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { hashFile } = require("./manifest");
const exif = require("./exif");
const safety = require("./safety");

const MEDIA_EXT = new Set([".jpg", ".jpeg", ".heic", ".heif", ".png", ".gif", ".webp", ".avif", ".bmp", ".tif", ".tiff", ".dng", ".cr2", ".cr3", ".nef", ".arw", ".raf", ".orf", ".mp4", ".mov", ".m4v", ".mkv", ".avi", ".webm", ".3gp", ".mts", ".m2ts", ".mpg", ".mpeg", ".wmv"]);
const YEAR_FOLDER = /^Photos from (\d{4})$/i;

// ── discovery ─────────────────────────────────────────────────────

/** Every "Takeout" folder under root (depth ≤ 2), or root itself when it is one. */
function findTakeoutRoots(root) {
  const out = [];
  const isTakeout = (p) => path.basename(p).toLowerCase() === "takeout" || fs.existsSync(path.join(p, "Google Photos")) || fs.existsSync(path.join(p, "Drive")) || fs.existsSync(path.join(p, "Mail"));
  if (isTakeout(root) && !fs.existsSync(path.join(root, "Takeout"))) return [root];
  const walk = (d, depth) => {
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = path.join(d, e.name);
      if (e.name.toLowerCase() === "takeout") out.push(p);
      else if (depth < 2 && !/^(library|_json)$/i.test(e.name)) walk(p, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

/** Services present across all Takeout roots: name -> { dirs:[...], files, bytes }. */
function discoverServices(roots) {
  const services = new Map();
  for (const r of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(r, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const name = e.name;
      if (!services.has(name)) services.set(name, { name, dirs: [], files: 0, bytes: 0 });
      const s = services.get(name);
      s.dirs.push(path.join(r, name));
      const st = folderStats(path.join(r, name));
      s.files += st.files;
      s.bytes += st.bytes;
    }
  }
  return [...services.values()].sort((a, b) => b.bytes - a.bytes);
}

function folderStats(dir, cap = 400000) {
  let files = 0;
  let bytes = 0;
  const walk = (d) => {
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files > cap) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        files += 1;
        try {
          bytes += fs.statSync(p).size;
        } catch {
          /* vanished */
        }
      }
    }
  };
  walk(dir);
  return { files, bytes };
}

// ── sidecar matching (pure, tested) ──────────────────────────────

/**
 * Which JSON in `jsonNames` (names in the same folder) describes `mediaName`?
 * Google's rules, in the order they win:
 *   IMG.jpg            -> IMG.jpg.supplemental-metadata.json | IMG.jpg.json
 *   IMG(1).jpg         -> IMG.jpg.supplemental-metadata(1).json | IMG.jpg(1).json
 *   IMG-edited.jpg     -> the original's sidecar
 *   very long names    -> the sidecar name is truncated; longest-prefix match
 */
function matchSidecar(mediaName, jsonNames) {
  const set = new Set(jsonNames);
  const tryNames = (base) => {
    for (const c of [`${base}.supplemental-metadata.json`, `${base}.supplemental-meta.json`, `${base}.json`]) if (set.has(c)) return c;
    return null;
  };
  let name = mediaName;
  let hit = tryNames(name);
  if (hit) return hit;
  // numbered duplicate: IMG(1).jpg  ->  IMG.jpg.supplemental-metadata(1).json
  const num = /^(.*)\((\d+)\)(\.[^.]+)$/.exec(name);
  if (num) {
    const base = `${num[1]}${num[3]}`;
    for (const c of [`${base}.supplemental-metadata(${num[2]}).json`, `${base}.supplemental-meta(${num[2]}).json`, `${base}(${num[2]}).json`, `${num[1]}${num[3]}(${num[2]}).json`]) if (set.has(c)) return c;
  }
  // edited copies share the original's sidecar
  const edited = /^(.*)-(edited|bearbeitet|modifié|editado)(\.[^.]+)$/i.exec(name);
  if (edited) {
    name = `${edited[1]}${edited[3]}`;
    hit = tryNames(name);
    if (hit) return hit;
  }
  // truncated sidecar names: pick the longest json stem that prefixes the media name
  let best = null;
  for (const j of jsonNames) {
    const stem = j.replace(/\.json$/i, "").replace(/\.supplemental-metadata?(\(\d+\))?$/i, "").replace(/\(\d+\)$/, "");
    if (stem.length >= 20 && name.toLowerCase().startsWith(stem.toLowerCase()) && (!best || stem.length > best.stem.length)) best = { j, stem };
  }
  return best ? best.j : null;
}

/** Taken time from a sidecar object, as a Date, or null. */
function takenDate(meta) {
  const ts = meta && ((meta.photoTakenTime && meta.photoTakenTime.timestamp) || (meta.creationTime && meta.creationTime.timestamp));
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : null;
}

/** "2019/07" for a Date. */
function yearMonth(d) {
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// ── moving files ─────────────────────────────────────────────────

async function moveFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const target = safety.uniquePath(dst, (p) => fs.existsSync(p));
  try {
    await fsp.rename(src, target);
  } catch (err) {
    if (err.code !== "EXDEV") throw err;
    await fsp.copyFile(src, target);
    await fsp.unlink(src);
  }
  return target;
}

/** Merge folder `from` into `to` (rename what can be renamed, recurse into existing dirs). */
async function mergeDir(from, to, stats) {
  fs.mkdirSync(to, { recursive: true });
  const tick = (name) => {
    if (stats.onFile) stats.onFile(stats.files, name);
  };
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, e.name);
    const d = path.join(to, e.name);
    if (stats.abort) stats.abort();
    if (e.isDirectory()) {
      if (fs.existsSync(d)) await mergeDir(s, d, stats);
      else {
        try {
          await fsp.rename(s, d);
          stats.files += countFiles(d);
          tick(e.name);
        } catch (err) {
          if (err.code !== "EXDEV") throw err;
          await mergeDir(s, d, stats);
        }
      }
    } else {
      await moveFile(s, d);
      stats.files += 1;
      tick(e.name);
    }
  }
  try {
    fs.rmdirSync(from);
  } catch {
    /* leftovers */
  }
}

function countFiles(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? countFiles(path.join(dir, e.name)) : 1;
  return n;
}

// ── the job ──────────────────────────────────────────────────────

const DEFAULTS = {
  library: "", // "" -> <root>/Library
  photos: { enabled: true, dates: true, exif: true, exifOverwrite: false, yearMonth: true, dedupe: true, sidecars: "json" }, // sidecars: keep | json | remove
  services: { enabled: true, skip: [] }, // move every other service; skip by name
};

/**
 * @param {string} root
 * @param {object} options see DEFAULTS
 * @param {object} ctx { stage, progress, warn, signal }
 * @param {object} deps { trash }
 */
async function run(root, options = {}, ctx, deps = {}) {
  const o = { ...DEFAULTS, ...options, photos: { ...DEFAULTS.photos, ...(options.photos || {}) }, services: { ...DEFAULTS.services, ...(options.services || {}) } };
  const trash = deps.trash || (async (p) => fsp.rm(p, { force: true }));
  const abort = () => {
    if (ctx.signal && ctx.signal.aborted) throw Object.assign(new Error("Cancelled"), { kind: "cancelled" });
  };
  const roots = findTakeoutRoots(root);
  if (!roots.length) throw Object.assign(new Error("No Takeout folder found there. Extract the parts first, or point at the folder that holds Takeout/."), { kind: "notfound" });
  const library = path.resolve(o.library || path.join(roots.length === 1 && path.basename(roots[0]).toLowerCase() === "takeout" ? path.dirname(roots[0]) : root, "Library"));
  fs.mkdirSync(library, { recursive: true });
  const report = { library, roots, photos: { media: 0, moved: 0, dated: 0, exifWritten: 0, exifSkipped: 0, duplicates: 0, noSidecar: 0, orphanSidecars: 0, sidecarsMoved: 0, sidecarsRemoved: 0, albums: 0 }, services: [] };
  const lines = [];

  // ── Google Photos ──
  const photoDirs = roots.map((r) => path.join(r, "Google Photos")).filter((p) => fs.existsSync(p));
  if (o.photos.enabled && photoDirs.length) {
    ctx.stage("Photos: finding albums");
    const albums = []; // { name, dir, isYear }
    for (const pd of photoDirs) {
      for (const e of fs.readdirSync(pd, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name === "_json") continue;
        albums.push({ name: e.name, dir: path.join(pd, e.name), isYear: YEAR_FOLDER.test(e.name) });
      }
    }
    // Year folders first: their copy is the one we keep when deduping.
    albums.sort((a, b) => Number(b.isYear) - Number(a.isYear) || a.name.localeCompare(b.name));
    const items = [];
    ctx.stage(`Photos: scanning ${albums.length} folder${albums.length === 1 ? "" : "s"}`);
    let scanned = 0;
    for (const a of albums) {
      abort();
      scanned += 1;
      ctx.progress({ percent: (scanned / albums.length) * 5, file: a.name });
      const names = fs.readdirSync(a.dir);
      const jsons = names.filter((n) => /\.json$/i.test(n));
      const used = new Set();
      for (const n of names) {
        if (!MEDIA_EXT.has(path.extname(n).toLowerCase())) continue;
        const sidecar = matchSidecar(n, jsons);
        if (sidecar) used.add(sidecar);
        items.push({ album: a, name: n, file: path.join(a.dir, n), sidecar: sidecar ? path.join(a.dir, sidecar) : null });
      }
      for (const j of jsons) {
        if (used.has(j) || /^metadata\.json$/i.test(j)) continue;
        report.photos.orphanSidecars += 1;
        if (o.photos.sidecars === "json") {
          await moveFile(path.join(a.dir, j), path.join(library, "Photos", "_json", a.name, j));
          report.photos.sidecarsMoved += 1;
        }
      }
    }
    report.photos.media = items.length;
    const photosOut = path.join(library, "Photos");
    const albumIndex = new Map(); // album name -> [library-relative paths]
    const seenHash = new Map(); // sha256 -> library path
    const sidecarsUsed = new Map(); // sidecar path -> album name (one sidecar can serve several files)
    let done = 0;
    for (const it of items) {
      abort();
      done += 1;
      if (done === 1 || done % 250 === 0) ctx.stage(`Photos: placing ${done.toLocaleString()} of ${items.length.toLocaleString()}${o.photos.dedupe ? " (hashing for duplicates)" : ""}`);
      ctx.progress({ percent: 5 + (done / items.length) * 75, file: it.name });
      let meta = null;
      if (it.sidecar) {
        try {
          meta = JSON.parse(fs.readFileSync(it.sidecar, "utf8"));
        } catch {
          meta = null;
        }
      } else report.photos.noSidecar += 1;
      const when = takenDate(meta);

      // duplicates across albums
      if (o.photos.dedupe) {
        const h = await hashFile(it.file, { signal: ctx.signal });
        const first = seenHash.get(h);
        if (first) {
          report.photos.duplicates += 1;
          if (!albumIndex.has(it.album.name)) albumIndex.set(it.album.name, []);
          albumIndex.get(it.album.name).push(path.relative(library, first).replace(/\\/g, "/"));
          await trash(it.file);
          if (it.sidecar) sidecarsUsed.set(it.sidecar, it.album.name);
          continue;
        }
        seenHash.set(h, null); // filled after move
        it.hash = h;
      }

      // EXIF (before the move; write to a temp file then rename over)
      if (o.photos.exif && when && /\.jpe?g$/i.test(it.name)) {
        try {
          const st = fs.statSync(it.file);
          if (st.size <= 200 * 1024 ** 2) {
            const buf = fs.readFileSync(it.file);
            const had = exif.getDateTaken(buf);
            if (!had || o.photos.exifOverwrite) {
              const r = exif.setDateTaken(buf, when);
              if (r.written) {
                const tmp = `${it.file}.unpacker-tmp`;
                fs.writeFileSync(tmp, r.buf);
                fs.renameSync(tmp, it.file);
                report.photos.exifWritten += 1;
              } else report.photos.exifSkipped += 1;
            }
          } else report.photos.exifSkipped += 1;
        } catch (err) {
          report.photos.exifSkipped += 1;
          lines.push(`exif failed: ${it.file}: ${err.message}`);
        }
      }

      // destination
      let rel;
      if (o.photos.yearMonth && when) rel = path.join(yearMonth(when).replace("/", path.sep), it.name);
      else if (o.photos.yearMonth) rel = path.join("Undated", it.name);
      else rel = path.join(it.album.name, it.name);
      const target = await moveFile(it.file, path.join(photosOut, rel));
      report.photos.moved += 1;
      if (it.hash) seenHash.set(it.hash, target);
      const libRel = path.relative(library, target).replace(/\\/g, "/");
      if (!it.album.isYear) {
        if (!albumIndex.has(it.album.name)) albumIndex.set(it.album.name, []);
        albumIndex.get(it.album.name).push(libRel);
      }

      // file dates
      if (o.photos.dates && when) {
        try {
          fs.utimesSync(target, when, when);
          report.photos.dated += 1;
        } catch {
          /* read-only? */
        }
      }
      if (it.sidecar) sidecarsUsed.set(it.sidecar, it.album.name);
    }
    ctx.stage(`Photos: filing ${sidecarsUsed.size.toLocaleString()} JSON sidecars`);
    let sc0 = 0;
    for (const [sc, album] of sidecarsUsed) {
      sc0 += 1;
      if (sc0 % 50 === 0) {
        abort();
        ctx.progress({ percent: 80 + (sc0 / sidecarsUsed.size) * 5, file: path.basename(sc) });
      }
      if (fs.existsSync(sc)) await disposeSidecar(sc, album, o, library, report, trash);
    }
    ctx.progress({ percent: 85 });
    // album index
    if (albumIndex.size) {
      const out = [];
      for (const [name, files] of [...albumIndex.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        out.push(`[${name}]`, ...files.sort(), "");
      }
      fs.writeFileSync(path.join(photosOut, "Albums.txt"), `${out.join("\n")}\n`, "utf8");
      report.photos.albums = albumIndex.size;
    }
    // sweep now-empty album folders
    for (const a of albums) removeEmptyDirs(a.dir);
    for (const pd of photoDirs) removeEmptyDirs(pd);
  }

  // ── every other service ──
  if (o.services.enabled) {
    const skip = new Set((o.services.skip || []).map((s) => s.toLowerCase()));
    const seen = new Set();
    let serviceIdx = 0;
    let serviceCount = 0;
    for (const r of roots) for (const e of fs.readdirSync(r, { withFileTypes: true })) if (e.isDirectory() && !/^google photos$/i.test(e.name) && !skip.has(e.name.toLowerCase())) serviceCount += 1;
    for (const r of roots) {
      for (const e of fs.readdirSync(r, { withFileTypes: true })) {
        abort();
        if (!e.isDirectory() || /^google photos$/i.test(e.name) || skip.has(e.name.toLowerCase())) continue;
        const from = path.join(r, e.name);
        const to = path.join(library, e.name);
        const expected = folderStats(from).files || 1;
        ctx.stage(`${e.name}: moving ${expected.toLocaleString()} files`);
        const base = 85 + (serviceIdx / Math.max(1, serviceCount)) * 15;
        const span = 15 / Math.max(1, serviceCount);
        serviceIdx += 1;
        const stats = { files: 0, abort, onFile: (n, name) => ctx.progress({ percent: base + (Math.min(n, expected) / expected) * span, file: name }) };
        await mergeDir(from, to, stats);
        const entry = report.services.find((s) => s.name === e.name) || { name: e.name, files: 0 };
        if (!seen.has(e.name)) {
          report.services.push(entry);
          seen.add(e.name);
        }
        entry.files += stats.files;
      }
    }
  }
  for (const r of roots) removeEmptyDirs(r);

  // ── report ──
  ctx.progress({ percent: 100 });
  const p = report.photos;
  const out = [
    "Unpacker V2 - Google Takeout organize",
    new Date().toISOString(),
    `library: ${library}`,
    `sources: ${roots.join(" | ")}`,
    "",
    `Google Photos: ${p.media} media files, ${p.moved} placed, ${p.duplicates} duplicates removed, ${p.dated} dated from JSON, ${p.exifWritten} EXIF dates written, ${p.exifSkipped} EXIF skipped, ${p.noSidecar} without a sidecar, ${p.orphanSidecars} sidecars without media, ${p.albums} albums listed in Photos/Albums.txt`,
    ...report.services.map((s) => `${s.name}: ${s.files} files moved`),
    "",
    ...lines,
  ];
  const reportPath = path.join(library, "Takeout-organize-report.txt");
  fs.writeFileSync(reportPath, `${out.join("\n")}\n`, "utf8");
  return { output: library, summary: report, report: reportPath };
}

async function disposeSidecar(sidecar, album, o, library, report, trash) {
  if (o.photos.sidecars === "json") {
    await moveFile(sidecar, path.join(library, "Photos", "_json", album, path.basename(sidecar)));
    report.photos.sidecarsMoved += 1;
  } else if (o.photos.sidecars === "remove") {
    await trash(sidecar);
    report.photos.sidecarsRemoved += 1;
  }
}

function removeEmptyDirs(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  let empty = true;
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!removeEmptyDirs(path.join(dir, e.name))) empty = false;
    } else if (!/^(metadata\.json|archive_browser\.html|\.unpacker-takeout\.json)$/i.test(e.name)) empty = false;
  }
  if (empty) {
    try {
      for (const e of entries) if (!e.isDirectory()) fs.rmSync(path.join(dir, e.name), { force: true });
      fs.rmdirSync(dir);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

module.exports = { run, findTakeoutRoots, discoverServices, matchSidecar, takenDate, yearMonth, DEFAULTS, MEDIA_EXT };
