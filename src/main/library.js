// The Library page's data side: a read-only view of a folder tree (a Takeout
// or Snapchat library, or any folder). Nothing here writes. The renderer only
// ever sees paths RELATIVE to a root it opened; the root itself is held here
// under a short id, and every request is resolved back inside that root. The
// media protocol (unp://<id>/<rel>) uses the same resolver, so the renderer
// can never read a file outside a folder the user opened.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const KINDS = {
  photo: ["jpg", "jpeg", "png", "gif", "webp", "bmp", "heic", "heif", "avif", "tif", "tiff", "svg"],
  video: ["mp4", "mov", "m4v", "webm", "mkv", "avi", "3gp", "mpg", "mpeg", "wmv"],
  audio: ["mp3", "m4a", "aac", "wav", "flac", "ogg", "opus", "wma", "amr"],
  text: ["txt", "md", "log", "json", "html", "htm", "xml", "vcf", "ics", "srt", "vtt", "ini", "yml", "yaml"],
  table: ["csv", "tsv"],
  document: ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "rtf", "epub"],
  archive: ["zip", "7z", "rar", "tar", "gz", "tgz", "xz", "bz2", "zst"],
};
const KIND_OF = {};
for (const [k, exts] of Object.entries(KINDS)) for (const e of exts) KIND_OF[e] = k;

// Files the browser can show inline (the rest open in their own app).
const INLINE_PHOTO = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif", "svg"]);
const INLINE_VIDEO = new Set(["mp4", "m4v", "webm", "mov"]);
const INLINE_AUDIO = new Set(["mp3", "m4a", "aac", "wav", "flac", "ogg", "opus"]);

const MAX_TEXT = 2 * 1024 * 1024;
const SUMMARY_FILES = ["What's in here.txt", "Snapchat library report.txt", "Takeout report.txt", "README.txt", "Albums.txt"];

const extOf = (name) => {
  const m = /\.([A-Za-z0-9]+)$/.exec(name);
  return m ? m[1].toLowerCase() : "";
};
const kindOf = (name) => KIND_OF[extOf(name)] || "other";

// How a file can be shown: inline (photo/video/audio/text/table) or not.
const viewOf = (name) => {
  const e = extOf(name);
  if (INLINE_PHOTO.has(e)) return "photo";
  if (INLINE_VIDEO.has(e)) return "video";
  if (INLINE_AUDIO.has(e)) return "audio";
  const k = kindOf(name);
  if (k === "text" || k === "table") return k;
  return "none";
};

// What kind of library a root is, from the folders it contains.
function detectKind(root) {
  const has = (n) => fs.existsSync(path.join(root, n));
  if (has("Snapchat library report.txt") || (has("Memories") && has("Account data"))) return "snapchat";
  if (has("Photos") && (has("Takeout report.txt") || has("Drive") || has("Mail") || has("YouTube"))) return "takeout";
  if (has("Takeout")) return "takeout-raw";
  return "folder";
}

class Library {
  constructor() {
    this.roots = new Map(); // id -> absolute root
  }

  // Open a folder; returns its id and a description. Re-opening the same
  // folder returns the same id.
  open(dir) {
    const root = path.resolve(dir);
    let st;
    try {
      st = fs.statSync(root);
    } catch {
      return { error: "That folder does not exist." };
    }
    if (!st.isDirectory()) return { error: "That is a file; drop or choose a folder." };
    let id = [...this.roots.entries()].find(([, r]) => r === root)?.[0];
    if (!id) {
      id = crypto.randomBytes(6).toString("hex");
      this.roots.set(id, root);
    }
    return { id, root, name: path.basename(root) || root, kind: detectKind(root), summary: this.summaryOf(root) };
  }

  close(id) {
    this.roots.delete(id);
  }

  // Resolve a relative path inside a root, or null if it escapes or is unknown.
  resolve(id, rel) {
    const root = this.roots.get(id);
    if (!root) return null;
    const clean = String(rel || "").replace(/^[/\\]+/, "");
    const abs = path.resolve(root, clean);
    if (abs !== root && !abs.startsWith(root + path.sep)) return null;
    return abs;
  }

  summaryOf(dir) {
    for (const n of SUMMARY_FILES) {
      const p = path.join(dir, n);
      try {
        const st = fs.statSync(p);
        if (st.isFile() && st.size <= 256 * 1024) return { name: n, text: fs.readFileSync(p, "utf8") };
      } catch {
        /* next */
      }
    }
    return null;
  }

  // One folder's contents, dirs first. Each dir carries a cheap count of its
  // direct children so the grid can show "412 items".
  async list(id, rel) {
    const abs = this.resolve(id, rel);
    if (!abs) return { error: "Not inside an open library." };
    let ents;
    try {
      ents = await fsp.readdir(abs, { withFileTypes: true });
    } catch (e) {
      return { error: `Cannot read that folder: ${e.message}` };
    }
    const dirs = [];
    const files = [];
    for (const e of ents) {
      const p = path.join(abs, e.name);
      const r = path.relative(this.roots.get(id), p).split(path.sep).join("/");
      if (e.isDirectory()) {
        let count = 0;
        try {
          count = (await fsp.readdir(p)).length;
        } catch {
          /* unreadable */
        }
        dirs.push({ name: e.name, rel: r, count });
      } else if (e.isFile()) {
        let st = null;
        try {
          st = await fsp.stat(p);
        } catch {
          continue;
        }
        files.push({ name: e.name, rel: r, size: st.size, mtime: st.mtimeMs, kind: kindOf(e.name), view: viewOf(e.name), ext: extOf(e.name) });
      }
    }
    const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
    dirs.sort((a, b) => coll.compare(a.name, b.name));
    files.sort((a, b) => coll.compare(a.name, b.name));
    const kinds = {};
    let bytes = 0;
    for (const f of files) {
      kinds[f.kind] = (kinds[f.kind] || 0) + 1;
      bytes += f.size;
    }
    return { rel: String(rel || ""), dirs, files, kinds, bytes, summary: this.summaryOf(abs) };
  }

  // A text file (capped). Tables come back as rows for the first N lines.
  async read(id, rel, { maxBytes = MAX_TEXT } = {}) {
    const abs = this.resolve(id, rel);
    if (!abs) return { error: "Not inside an open library." };
    let st;
    try {
      st = await fsp.stat(abs);
    } catch (e) {
      return { error: e.message };
    }
    const fh = await fsp.open(abs, "r");
    try {
      const n = Math.min(st.size, maxBytes);
      const buf = Buffer.alloc(n);
      await fh.read(buf, 0, n, 0);
      let text = buf.toString("utf8");
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      return { text, truncated: st.size > maxBytes, size: st.size, view: viewOf(path.basename(abs)) };
    } finally {
      await fh.close();
    }
  }

  // Find files by name under a root (case-insensitive substring), capped.
  async search(id, query, { limit = 500 } = {}) {
    const root = this.roots.get(id);
    if (!root) return { error: "Not inside an open library." };
    const q = String(query || "").trim().toLowerCase();
    if (!q) return { hits: [], more: false };
    const hits = [];
    let more = false;
    const walk = async (dir) => {
      if (more) return;
      let ents;
      try {
        ents = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of ents) {
        if (more) return;
        const p = path.join(dir, e.name);
        if (e.name.toLowerCase().includes(q)) {
          if (hits.length >= limit) {
            more = true;
            return;
          }
          const rel = path.relative(root, p).split(path.sep).join("/");
          if (e.isDirectory()) hits.push({ name: e.name, rel, dir: true });
          else {
            let size = 0;
            try {
              size = (await fsp.stat(p)).size;
            } catch {
              /* skip */
            }
            hits.push({ name: e.name, rel, size, kind: kindOf(e.name), view: viewOf(e.name), ext: extOf(e.name) });
          }
        }
        if (e.isDirectory()) await walk(p);
      }
    };
    await walk(root);
    return { hits, more };
  }
}

// Parse CSV text into rows (quoted fields, CRLF), capped at maxRows.
function parseCsv(text, maxRows = 2000) {
  const rows = [];
  let row = [];
  let field = "";
  let inQ = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      if (rows.length >= maxRows) return { rows, more: true };
    } else field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return { rows, more: false };
}

module.exports = { Library, kindOf, viewOf, extOf, detectKind, parseCsv, KINDS, MAX_TEXT };
