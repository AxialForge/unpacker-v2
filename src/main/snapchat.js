// Snapchat "My Data" export support.
//
// What Snapchat hands over (observed on a real Memories export, October 2026):
//
//   mydata~<number>.zip                      one or more parts
//     index.html, html/*.html                browsable copies
//     json/memories_history.json             { "Saved Media": [ { "Date": "YYYY-MM-DD HH:MM:SS UTC",
//                                               "Media Type": "Image"|"Video",
//                                               "Location": "Latitude, Longitude: <lat>, <lon>", ... } ] }
//     memories/<YYYY-MM-DD>_<uuid>-main.jpg|mp4      the photo or video
//     memories/<YYYY-MM-DD>_<uuid>-overlay.png       caption / sticker layer, same uuid
//
// The JSON has NO file id. The link between a file and its record is the
// file's timestamp inside the zip, which equals the record's Date to the
// second (958 of 958 on the sample). 7-Zip restores that timestamp on
// extraction, so after extracting we match on (modified time, type).
// The photos carry no EXIF at all, so date and position are written here.
//
// A full account export adds more json/*.json sections (chat, friends, …).
// Those are not interpreted yet: they are moved, untouched, into the library's
// "Account data" folder and listed in the report.
//
// parse/match helpers are pure and tested; organize() touches the disk.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const exif = require("./exif");
const safety = require("./safety");

// mydata~1790635398407.zip, mydata~1790635398407-2.zip, and a browser's " (1)" copy
const PART_RX = /^mydata~(\d+)(?:-(\d+))?(?: \((\d+)\))?\.zip$/i;
const MEDIA_RX = /^(\d{4}-\d{2}-\d{2})_([0-9A-Fa-f-]{36})-(main|overlay)\.(\w+)$/;

function parsePartName(p) {
  const m = PART_RX.exec(path.basename(String(p || "")));
  if (!m) return null;
  return { id: m[1], index: m[2] ? parseInt(m[2], 10) : 1, copy: m[3] ? parseInt(m[3], 10) : 0 };
}
const isSnapchatPart = (p) => parsePartName(p) != null;

/** Group part paths into exports by their id. */
function groupExports(paths, sizeOf = () => 0) {
  const by = new Map();
  for (const p of paths || []) {
    const info = parsePartName(p);
    if (!info) continue;
    if (!by.has(info.id)) by.set(info.id, { id: info.id, parts: [], duplicates: [], missing: [], totalBytes: 0 });
    const g = by.get(info.id);
    const size = sizeOf(p) || 0;
    const existing = g.parts.find((x) => x.index === info.index);
    if (existing) {
      if (existing.copy > info.copy) {
        g.duplicates.push({ path: existing.path, index: info.index });
        g.totalBytes += size - existing.size;
        Object.assign(existing, { path: p, size, copy: info.copy });
      } else g.duplicates.push({ path: p, index: info.index });
      continue;
    }
    g.parts.push({ path: p, index: info.index, size, copy: info.copy });
    g.totalBytes += size;
  }
  const out = [...by.values()];
  for (const g of out) {
    g.parts.sort((a, b) => a.index - b.index);
    const last = g.parts[g.parts.length - 1].index;
    for (let i = 1; i <= last; i += 1) if (!g.parts.some((p) => p.index === i)) g.missing.push(i);
  }
  return out.sort((a, b) => (a.id < b.id ? 1 : -1));
}

/** "Latitude, Longitude: 41.4, -82.6" -> { lat, lon } or null (0,0 means "none"). */
function parseLocation(s) {
  const m = /(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\s*$/.exec(String(s || ""));
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

/** "2024-07-01 15:30:45 UTC" -> epoch seconds, or null. */
function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) UTC$/.exec(String(s || ""));
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000;
}

/** Records from memories_history.json -> [{ time, type:"jpg"|"mp4", gps }]. */
function parseHistory(json) {
  const list = (json && json["Saved Media"]) || [];
  const out = [];
  for (const e of list) {
    const time = parseDate(e.Date);
    if (time == null) continue;
    out.push({ time, type: /video/i.test(e["Media Type"]) ? "mp4" : "jpg", gps: parseLocation(e.Location), date: e.Date });
  }
  return out;
}

/**
 * Pair files with records on (time to the second, type).
 * files: [{ name, time (epoch seconds), type }]. Each record is used once,
 * except that a multi-snap (several files Snapchat saved under ONE record,
 * all in the same second) shares that record: the time and place are the
 * same for every frame. Real exports had 28 such files among 964.
 * @returns {{ pairs: Map<name, record>, unmatchedFiles: string[], unusedRecords: record[], shared: number }}
 */
function matchRecords(files, records) {
  const pool = new Map();
  const used = new Map(); // key -> records already handed out, for multi-snaps
  for (const r of records) {
    const k = `${r.time}|${r.type}`;
    if (!pool.has(k)) pool.set(k, []);
    pool.get(k).push(r);
  }
  const pairs = new Map();
  const unmatchedFiles = [];
  let shared = 0;
  for (const f of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    let rec = null;
    for (const d of [0, 1, -1, 2, -2]) {
      const k = `${f.time + d}|${f.type}`;
      const q = pool.get(k);
      if (q && q.length) {
        rec = q.shift();
        if (!used.has(k)) used.set(k, []);
        used.get(k).push(rec);
        break;
      }
    }
    if (!rec) {
      // same second, same type, record already taken: a frame of a multi-snap
      const u = used.get(`${f.time}|${f.type}`);
      if (u && u.length) {
        rec = u[0];
        shared += 1;
      }
    }
    if (rec) pairs.set(f.name, rec);
    else unmatchedFiles.push(f.name);
  }
  return { pairs, unmatchedFiles, unusedRecords: [...pool.values()].flat().sort((a, b) => a.time - b.time), shared };
}

/** "2024-07-01_153045" from epoch seconds (UTC). */
function stamp(t) {
  const d = new Date(t * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}_${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/** Is this folder an extracted Snapchat export? */
function isExportFolder(dir) {
  return fs.existsSync(path.join(dir, "json")) && (fs.existsSync(path.join(dir, "memories")) || fs.existsSync(path.join(dir, "chat_media")) || fs.existsSync(path.join(dir, "index.html")));
}

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

const DEFAULTS = {
  library: "", // "" -> <stage>/Snapchat Library
  yearMonth: true, // Memories/YYYY/MM, else one flat Memories folder
  rename: true, // 2024-07-01_153045.jpg instead of <date>_<uuid>-main.jpg
  dates: true, // file modified time = taken time
  exif: true, // write DateTimeOriginal into JPEGs
  gps: true, // write the position into JPEGs
  overlays: "beside", // "beside" | "folder" | "leave"
  burn: false, // also write <stem>_with overlay.jpg: the overlay composited onto the photo (needs deps.composite)
};

/**
 * Turn an extracted export folder into a library.
 * @param {string} stage folder holding json/, memories/, html/, index.html
 */
/**
 * @param {object} deps { composite(photoPath, overlayPath) -> Promise<Buffer jpeg> } (optional; the
 *   Electron main process provides one that draws both pictures on a canvas)
 */
async function organize(stage, options = {}, ctx, deps = {}) {
  const o = { ...DEFAULTS, ...options };
  const abort = () => {
    if (ctx.signal && ctx.signal.aborted) throw Object.assign(new Error("Cancelled"), { kind: "cancelled" });
  };
  if (!isExportFolder(stage)) throw Object.assign(new Error("That folder is not a Snapchat export (no json/memories_history.json and no memories folder)."), { kind: "notfound" });
  const library = path.resolve(o.library || path.join(stage, "Snapchat Library"));
  const memOut = path.join(library, "Memories");
  fs.mkdirSync(memOut, { recursive: true });
  const rep = { library, media: 0, photos: 0, videos: 0, matched: 0, unmatched: 0, dated: 0, exifWritten: 0, gpsWritten: 0, withLocation: 0, overlays: 0, orphanOverlays: 0, burned: 0, missingRecords: 0, otherSections: [] };

  // records
  ctx.stage("Snapchat: reading the memories list");
  let records = [];
  const account = require("./snapchat-account");
  const copies = account.loadSection(stage, "memories_history", (m) => ctx.warn(`${m}; dates fall back to the file names.`));
  if (copies.length) {
    const seen = new Set();
    for (const r of copies.flatMap(parseHistory)) {
      const k = `${r.time}|${r.type}|${r.gps ? r.gps.lat + "," + r.gps.lon : ""}`;
      if (!seen.has(k)) {
        seen.add(k);
        records.push(r);
      }
    }
  } else ctx.warn("No json/memories_history.json in this export; dates fall back to the file names and no positions are available.");

  // files
  const memDir = path.join(stage, "memories");
  const mains = [];
  const overlays = new Map(); // uuid -> path
  if (fs.existsSync(memDir)) {
    for (const name of fs.readdirSync(memDir)) {
      const m = MEDIA_RX.exec(name);
      if (!m) continue;
      const full = path.join(memDir, name);
      if (m[3] === "overlay") overlays.set(m[2].toLowerCase(), full);
      else {
        const ext = m[4].toLowerCase();
        mains.push({ name, full, day: m[1], uuid: m[2].toLowerCase(), ext, type: ext === "mp4" || ext === "mov" ? "mp4" : "jpg", time: Math.round(fs.statSync(full).mtimeMs / 1000) });
      }
    }
  }
  rep.media = mains.length;
  const { pairs, unmatchedFiles, unusedRecords, shared } = matchRecords(mains, records);
  rep.matched = pairs.size;
  rep.sharedRecords = shared;
  rep.unmatched = unmatchedFiles.length;
  rep.missingRecords = unusedRecords.length;

  const index = [["file", "taken (UTC)", "type", "latitude", "longitude", "overlay", "matched to the memories list"]];
  let done = 0;
  for (const f of mains.sort((a, b) => a.time - b.time)) {
    abort();
    done += 1;
    if (done === 1 || done % 100 === 0) ctx.stage(`Snapchat: placing ${done.toLocaleString()} of ${mains.length.toLocaleString()}`);
    ctx.progress({ percent: (done / Math.max(1, mains.length)) * 90, file: f.name });
    const rec = pairs.get(f.name) || null;
    // no record: trust the day in the file name, noon UTC, unless the file time already falls on that day
    const sameDay = new Date(f.time * 1000).toISOString().slice(0, 10) === f.day;
    const time = rec ? rec.time : sameDay ? f.time : Date.UTC(+f.day.slice(0, 4), +f.day.slice(5, 7) - 1, +f.day.slice(8, 10), 12) / 1000;
    const when = new Date(time * 1000);
    const gps = rec && rec.gps ? rec.gps : null;
    if (gps) rep.withLocation += 1;
    if (f.type === "jpg") rep.photos += 1;
    else rep.videos += 1;

    if (f.type === "jpg" && /\.jpe?g$/i.test(f.name) && (o.exif || (o.gps && gps))) {
      try {
        const buf = fs.readFileSync(f.full);
        if (!exif.getDateTaken(buf)) {
          const r = exif.setDateTaken(buf, when, { gps: o.gps ? gps : null });
          if (r.written) {
            const tmp = `${f.full}.unpacker-tmp`;
            fs.writeFileSync(tmp, r.buf);
            fs.renameSync(tmp, f.full);
            rep.exifWritten += 1;
            if (r.gps) rep.gpsWritten += 1;
          }
        }
      } catch (err) {
        ctx.warn(`EXIF not written for ${f.name}: ${err.message}`);
      }
    }

    const stem = o.rename ? stamp(time) : f.name.replace(/\.[^.]+$/, "");
    const folder = o.yearMonth ? path.join(memOut, String(when.getUTCFullYear()), String(when.getUTCMonth() + 1).padStart(2, "0")) : memOut;
    const target = await moveFile(f.full, path.join(folder, `${stem}.${f.ext}`));
    if (o.dates) {
      try {
        fs.utimesSync(target, when, when);
        rep.dated += 1;
      } catch {
        /* read-only */
      }
    }
    let overlayRel = "";
    const ov = overlays.get(f.uuid);
    if (ov) {
      overlays.delete(f.uuid);
      rep.overlays += 1;
      const tStem = path.basename(target).replace(/\.[^.]+$/, "");
      let ovPath = ov;
      if (o.overlays !== "leave") {
        const ovDir = o.overlays === "folder" ? path.join(memOut, "Overlays", path.relative(memOut, path.dirname(target))) : path.dirname(target);
        ovPath = await moveFile(ov, path.join(ovDir, `${tStem}_overlay.png`));
        try {
          fs.utimesSync(ovPath, when, when);
        } catch {
          /* fine */
        }
        overlayRel = path.relative(library, ovPath).replace(/\\/g, "/");
      }
      // A finished picture with the caption or sticker on it, beside the
      // untouched original. Photos only; a video needs a video encoder.
      if (o.burn && f.type === "jpg" && deps.composite) {
        try {
          let buf = await deps.composite(target, ovPath);
          if (o.exif) {
            const r = exif.setDateTaken(buf, when, { gps: o.gps ? gps : null });
            if (r.written) buf = r.buf;
          }
          const burned = path.join(path.dirname(target), `${tStem}_with overlay.jpg`);
          fs.writeFileSync(burned, buf);
          if (o.dates) fs.utimesSync(burned, when, when);
          rep.burned += 1;
        } catch (err) {
          ctx.warn(`Overlay not burned into ${path.basename(target)}: ${err.message}`);
        }
      }
    }
    index.push([path.relative(library, target).replace(/\\/g, "/"), when.toISOString().replace(/\.\d{3}Z$/, "Z"), f.type === "jpg" ? "photo" : "video", gps ? String(gps.lat) : "", gps ? String(gps.lon) : "", overlayRel, rec ? "yes" : "no"]);
  }

  // overlays whose photo or video is not here
  rep.orphanOverlays = overlays.size;
  if (o.overlays !== "leave") for (const [, p] of overlays) await moveFile(p, path.join(memOut, "Overlays", "Without a photo", path.basename(p)));

  // everything else in the export: kept, untouched, in one place
  ctx.stage("Snapchat: filing the rest of the export");
  ctx.progress({ percent: 93 });
  const dataOut = path.join(library, "Account data");
  if (fs.existsSync(path.join(memDir, "memories.html"))) await moveFile(path.join(memDir, "memories.html"), path.join(dataOut, "memories.html"));
  rep.account = await account.organizeAccount(stage, library, ctx, { moveFile });
  rep.otherSections = rep.account.sections;
  try {
    fs.rmdirSync(memDir);
  } catch {
    /* something was left on purpose (overlays: leave) */
  }

  // index + missing list + report
  const csv = (rows) => `${rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(",")).join("\r\n")}\r\n`;
  fs.writeFileSync(path.join(memOut, "Memories index.csv"), `﻿${csv(index)}`, "utf8");
  if (unusedRecords.length) {
    fs.writeFileSync(
      path.join(memOut, "Missing memories.csv"),
      `﻿${csv([["taken (UTC)", "type", "latitude", "longitude"], ...unusedRecords.map((r) => [new Date(r.time * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"), r.type === "jpg" ? "photo" : "video", r.gps ? String(r.gps.lat) : "", r.gps ? String(r.gps.lon) : ""])])}`,
      "utf8"
    );
    ctx.warn(`${unusedRecords.length} memories are listed by Snapchat but their files are not in this export (see "Missing memories.csv"). The export is probably split into more parts; download them and run again.`);
  }
  const lines = [
    "Unpacker V2 - Snapchat library",
    new Date().toISOString(),
    `library: ${library}`,
    "",
    `Memories: ${rep.media} files (${rep.photos} photos, ${rep.videos} videos)`,
    `  matched to Snapchat's list: ${rep.matched} (${rep.sharedRecords} frames of multi-snaps share a record); not matched: ${rep.unmatched}`,
    `  with a position: ${rep.withLocation}; dates set: ${rep.dated}; EXIF dates written: ${rep.exifWritten}; EXIF positions written: ${rep.gpsWritten}`,
    `  overlays: ${rep.overlays} paired, ${rep.orphanOverlays} without a photo (${o.overlays})${o.burn ? `; ${rep.burned} photos written with the overlay burned in` : ""}`,
    `  listed by Snapchat but not in this export: ${rep.missingRecords}`,
    `Chats: ${rep.account.conversations} conversations, ${rep.account.messages.toLocaleString("en-US")} messages, ${rep.account.chatMedia} pictures and videos (${rep.account.chatMediaLinked} placed with their conversation)`,
    `Snaps logged: ${rep.account.snaps}; friend lists: ${rep.account.friendsLists}; story records: ${rep.account.stories}; location points: ${rep.account.locations}`,
    `Account data sections (readable text + originals): ${rep.otherSections.length ? rep.otherSections.join(", ") : "none"}`,
    "",
    "Times are Coordinated Universal Time, as Snapchat records them.",
  ];
  const reportPath = path.join(library, "Snapchat library report.txt");
  fs.writeFileSync(reportPath, `${lines.join("\r\n")}\r\n`, "utf8");
  if (o.exportLog) {
    ctx.stage("Writing the export log");
    require("./exportlog").write({
      dir: library,
      title: "Snapchat library",
      roots: [{ path: library, source: "Snapchat My Data" }],
      notes: [`${rep.media} memories: ${rep.photos} photos and ${rep.videos} videos; ${rep.withLocation} with a place.`, rep.missingRecords ? `${rep.missingRecords} memories are listed by Snapchat but were not in the export (see "Memories/Missing memories.csv").` : "Every memory Snapchat lists is here.", 'Details are in "Snapchat library report.txt".'],
      skip: new Set([reportPath.toLowerCase()]),
    });
  }
  ctx.progress({ percent: 100 });
  return { output: library, summary: rep, report: reportPath };
}

module.exports = { PART_RX, MEDIA_RX, parsePartName, isSnapchatPart, groupExports, parseLocation, parseDate, parseHistory, matchRecords, stamp, isExportFolder, organize, DEFAULTS };
