// The optional export log: two plain files at the top of a finished mass job
// that say what is there, without rearranging anything.
//
//   What's in here.txt   a summary a person can read in half a minute
//   What's in here.html  the same, as a page: folder table, every file with
//                        a search box and kind filter; self-contained, no
//                        scripts or styles fetched from anywhere
//   Contents.csv         every file: folder, name, size, date, kind, source
//
// The folder structure is left exactly as the archives (or the organiser)
// produced it; this module only reads and describes. Electron-free.

const fs = require("node:fs");
const path = require("node:path");
const { fmtBytes } = require("./safety");

const SUMMARY = "What's in here.txt";
const OVERVIEW = "What's in here.html";
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

const { csvCell } = require("./safety");

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
        if (base === SUMMARY || base === CONTENTS || base === OVERVIEW) return;
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
  L.push(`"${OVERVIEW}" shows the same in a browser, with a search box.`);
  const summaryPath = path.join(dir, SUMMARY);
  fs.writeFileSync(summaryPath, `${L.join("\r\n")}\r\n`, "utf8");

  const rows = [["folder", "file", "size (bytes)", "modified", "kind", "came from"]];
  for (const f of files) rows.push([path.dirname(f.rel) === "." ? "" : path.dirname(f.rel), path.basename(f.rel), f.size, f.mtime.toISOString().replace(/\.\d{3}Z$/, "Z"), f.kind, f.source]);
  const contentsPath = path.join(dir, CONTENTS);
  fs.writeFileSync(contentsPath, `﻿${rows.map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`, "utf8");
  const overviewPath = path.join(dir, OVERVIEW);
  fs.writeFileSync(overviewPath, overviewHtml({ title: a.title || "Export", now, totals, groups, truncated, sources, notes: a.notes || [], files }), "utf8");
  return { summary: summaryPath, overview: overviewPath, contents: contentsPath, files: totals.files, bytes: totals.bytes };
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A self-contained page: summary, folder table, searchable file list. */
function overviewHtml(v) {
  const data = v.files.map((f) => [path.dirname(f.rel) === "." ? "" : path.dirname(f.rel).replace(/\\/g, "/"), path.basename(f.rel), f.size, f.mtime.toISOString().slice(0, 10), f.kind, f.source]);
  const json = JSON.stringify(data).replace(/<\//g, "<\\/");
  const kindCells = (k) => KIND_ORDER.map((n) => `<td class="n">${k[n] ? k[n].toLocaleString("en-US") : ""}</td>`).join("");
  const folderRows = v.groups.map((g) => `<tr><td>${esc(g.name)}</td><td class="n">${g.files.toLocaleString("en-US")}</td><td class="n">${esc(fmtBytes(g.bytes))}</td>${kindCells(g.kinds)}<td>${g.oldest ? `${day(g.oldest)}${day(g.newest) !== day(g.oldest) ? ` to ${day(g.newest)}` : ""}` : ""}</td></tr>`).join("\n");
  const good = v.sources.filter((s) => s.state === "done");
  const bad = v.sources.filter((s) => s.state !== "done");
  const sourcesHtml = v.sources.length
    ? `<h2>Where it came from</h2><p>${good.length} of ${v.sources.length} archives were extracted.</p><ul>${good.map((s) => `<li>${esc(s.name)}</li>`).join("")}</ul>${bad.length ? `<h3>Needs attention</h3><ul class="bad">${bad.map((s) => `<li>${esc(s.name)}: ${esc(s.state)}${s.error ? ` (${esc(s.error)})` : ""}</li>`).join("")}</ul>` : ""}`
    : "";
  const notesHtml = v.notes.length ? `<h2>Notes</h2><ul>${v.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(v.title)}</title>
<style>
:root{--bg:#fff;--fg:#1b1f26;--muted:#5d6675;--line:#d6dbe5;--bg2:#f4f6fa;--accent:#2f6fd6}
@media(prefers-color-scheme:dark){:root{--bg:#14171c;--fg:#e6e9ef;--muted:#8b93a3;--line:#2e3442;--bg2:#1b1f26;--accent:#4f8cff}}
body{margin:0;padding:20px 24px 60px;background:var(--bg);color:var(--fg);font:14px/1.45 "Segoe UI",system-ui,sans-serif;max-width:1200px}
h1{margin:0 0 4px;font-size:22px}h2{margin:26px 0 8px;font-size:16px}h3{margin:14px 0 6px;font-size:14px}
.muted{color:var(--muted)}table{border-collapse:collapse;width:100%;font-size:13px}th,td{border-bottom:1px solid var(--line);padding:4px 8px;text-align:left;vertical-align:top}th{background:var(--bg2);position:sticky;top:0}
td.n,th.n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}.bad{color:#c0392b}
.bar{display:flex;gap:10px;align-items:center;margin:8px 0 10px;flex-wrap:wrap}input,select{font:inherit;padding:5px 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}input{min-width:260px}
.more{padding:10px 8px}
</style></head><body>
<h1>${esc(v.title)}</h1>
<p class="muted">Made by Unpacker V2 on ${v.now.toISOString().slice(0, 10)}. Folders are exactly as they were inside the archives; nothing was rearranged.${v.truncated ? " The list was cut short: there are more files than this page records." : ""}</p>
<p>This folder holds <b>${v.totals.files.toLocaleString("en-US")} files</b>, <b>${esc(fmtBytes(v.totals.bytes))}</b> in total: ${esc(kindsLine(v.totals.kinds))}.</p>
<h2>What is in each folder</h2>
<table><thead><tr><th>Folder</th><th class="n">Files</th><th class="n">Size</th>${KIND_ORDER.map((k) => `<th class="n">${k}</th>`).join("")}<th>Dated</th></tr></thead>
<tbody>${folderRows || '<tr><td colspan="10">(no files)</td></tr>'}</tbody></table>
${sourcesHtml}${notesHtml}
<h2>Every file</h2>
<div class="bar"><input id="q" type="search" placeholder="Find by name or folder…"><select id="k"><option value="">All kinds</option>${KIND_ORDER.map((k) => `<option>${k}</option>`).join("")}</select><span id="count" class="muted"></span></div>
<table><thead><tr><th>Folder</th><th>File</th><th class="n">Size</th><th>Modified</th><th>Kind</th><th>Came from</th></tr></thead><tbody id="rows"></tbody></table>
<script id="data" type="application/json">${json}</script>
<script>
(function(){
var D=JSON.parse(document.getElementById("data").textContent),q=document.getElementById("q"),k=document.getElementById("k"),rows=document.getElementById("rows"),count=document.getElementById("count"),LIMIT=2000;
function fmt(n){var u=["B","KB","MB","GB","TB"],i=0;while(n>=1024&&i<u.length-1){n/=1024;i++}return (i?n.toFixed(1):n)+" "+u[i]}
function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;")}
function render(){var t=q.value.trim().toLowerCase(),kk=k.value,out=[],n=0;
for(var i=0;i<D.length;i++){var r=D[i];if(kk&&r[4]!==kk)continue;if(t&&(r[0]+"/"+r[1]).toLowerCase().indexOf(t)<0)continue;n++;if(out.length<LIMIT)out.push("<tr><td>"+esc(r[0])+"</td><td>"+esc(r[1])+"</td><td class=n>"+fmt(r[2])+"</td><td>"+r[3]+"</td><td>"+r[4]+"</td><td>"+esc(r[5])+"</td></tr>")}
if(n>LIMIT)out.push('<tr><td colspan=6 class="more muted">… '+(n-LIMIT).toLocaleString()+" more; narrow the search or open Contents.csv.</td></tr>");
rows.innerHTML=out.join("");count.textContent=n.toLocaleString()+" of "+D.length.toLocaleString()+" files"}
q.addEventListener("input",render);k.addEventListener("change",render);render();
})();
</script>
</body></html>
`;
}

module.exports = { write, inventory, summarise, kindOf, SUMMARY, OVERVIEW, CONTENTS, KIND_ORDER };
