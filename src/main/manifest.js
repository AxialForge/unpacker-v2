// Archive manifests: a readable text file beside (and inside) every archive
// that says what went in, where, and optionally its SHA-256.
//
// Naming links everything through an 8-character ID:
//   Photos-2026_K7M3Q9XZ-01of03.7z
//   Photos-2026_K7M3Q9XZ.manifest.txt
//
// Format (tab-separated, UTF-8, one file per line after the header):
//   # Unpacker V2 manifest
//   id: K7M3Q9XZ
//   name: Photos-2026
//   created: 2026-09-12T14:01:02Z
//   ...
//   #chunk	path	size	modified	sha256
//   01of03	2019 Trip/IMG_1.jpg	4123456	2019-07-01T10:00:00Z	ab12...

const crypto = require("node:crypto");
const fs = require("node:fs");

// No 0/O or 1/I: the ID gets read aloud and typed.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function makeId(len = 8) {
  const bytes = crypto.randomBytes(len);
  let s = "";
  for (let i = 0; i < len; i += 1) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s;
}

const isId = (s) => /^[A-HJ-NP-Z2-9]{5,10}$/.test(String(s || ""));

/** Streaming SHA-256 of a file. */
function hashFile(file, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    const s = fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024 });
    const abort = () => s.destroy(Object.assign(new Error("Cancelled"), { kind: "cancelled" }));
    if (signal) signal.addEventListener("abort", abort, { once: true });
    s.on("data", (d) => h.update(d));
    s.on("error", (e) => {
      if (signal) signal.removeEventListener("abort", abort);
      reject(e);
    });
    s.on("end", () => {
      if (signal) signal.removeEventListener("abort", abort);
      resolve(h.digest("hex"));
    });
  });
}

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * @param {object} m { id, name, created, tool, format, chunkLimit, chunks:[{label, file, bytes}], files:[{chunk, rel, size, mtimeMs, sha256?}], hashed }
 */
function renderManifest(m) {
  const lines = [
    "# Unpacker V2 manifest",
    `id: ${m.id}`,
    `name: ${m.name}`,
    `created: ${m.created}`,
    `tool: ${m.tool || "Unpacker V2"}`,
    `format: ${m.format}`,
    `chunk-limit: ${m.chunkLimit || "none"}`,
    `chunks: ${m.chunks.length}`,
    `files: ${m.files.length}`,
    `bytes: ${m.files.reduce((n, f) => n + f.size, 0)}`,
    `hashed: ${m.hashed ? "sha256" : "no"}`,
    "",
    "# archives",
  ];
  for (const c of m.chunks) lines.push(`${c.label}\t${c.file}\t${c.bytes}${c.volumes ? "\tvolumes" : ""}`);
  lines.push("", `#chunk\tpath\tsize\tmodified${m.hashed ? "\tsha256" : ""}`);
  for (const f of m.files) {
    const rel = String(f.rel).replace(/\\/g, "/");
    lines.push(`${f.chunk}\t${rel}\t${f.size}\t${iso(f.mtimeMs)}${m.hashed ? `\t${f.sha256 || ""}` : ""}`);
  }
  return `${lines.join("\n")}\n`;
}

function parseManifest(text) {
  const m = { id: "", name: "", created: "", format: "", chunkLimit: "", hashed: false, chunks: [], files: [] };
  let section = "head";
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line) continue;
    if (line === "# archives") {
      section = "chunks";
      continue;
    }
    if (line.startsWith("#chunk\t")) {
      section = "files";
      continue;
    }
    if (line.startsWith("#")) continue;
    if (section === "head") {
      const i = line.indexOf(": ");
      if (i < 0) continue;
      const k = line.slice(0, i);
      const v = line.slice(i + 2);
      if (k === "id") m.id = v;
      else if (k === "name") m.name = v;
      else if (k === "created") m.created = v;
      else if (k === "format") m.format = v;
      else if (k === "chunk-limit") m.chunkLimit = v;
      else if (k === "hashed") m.hashed = v !== "no";
    } else if (section === "chunks") {
      const [label, file, bytes, flag] = line.split("\t");
      m.chunks.push({ label, file, bytes: Number(bytes || 0), volumes: flag === "volumes" });
    } else {
      const [chunk, rel, size, modified, sha256] = line.split("\t");
      m.files.push({ chunk, rel, size: Number(size || 0), modified, sha256: sha256 || "" });
    }
  }
  return m;
}

module.exports = { makeId, isId, hashFile, renderManifest, parseManifest, ALPHABET };
