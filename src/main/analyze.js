// "Smart compress": look at what the user dropped and suggest a format/level.
//
// Two signals: what the files ARE (extension buckets, by bytes) and how well a
// sample of the biggest files actually deflates (a real ratio in well under a
// second). The suggestion is advice; the UI always lets the user override.
//
// classify() and suggest() are pure and tested; probe() and analyze() touch fs.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const zlib = require("node:zlib");

const BUCKETS = {
  media: [".jpg", ".jpeg", ".heic", ".heif", ".png", ".gif", ".webp", ".avif", ".mp4", ".mov", ".mkv", ".avi", ".m4v", ".webm", ".mts", ".m2ts", ".mp3", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".wma", ".cr2", ".cr3", ".nef", ".arw", ".dng", ".raf", ".orf"],
  packed: [".zip", ".7z", ".rar", ".gz", ".tgz", ".bz2", ".xz", ".zst", ".cab", ".msi", ".exe", ".apk", ".jar", ".docx", ".xlsx", ".pptx", ".odt", ".ods", ".odp", ".epub", ".pdf", ".iso", ".dmg", ".wim"],
  text: [".txt", ".md", ".csv", ".tsv", ".json", ".xml", ".html", ".htm", ".css", ".js", ".ts", ".py", ".c", ".h", ".cpp", ".cs", ".java", ".go", ".rs", ".sql", ".log", ".ini", ".cfg", ".yml", ".yaml", ".toml", ".eml", ".mbox", ".rtf", ".tex", ".svg", ".ps1", ".bat", ".sh"],
  office: [".doc", ".xls", ".ppt", ".psd", ".ai", ".indd", ".dwg", ".dxf", ".step", ".stp", ".stl", ".obj", ".fbx", ".blend", ".f3d", ".sldprt", ".sldasm", ".ipt", ".iam", ".bmp", ".tif", ".tiff", ".wav", ".aiff"],
  image: [".vhd", ".vhdx", ".vmdk", ".vdi", ".qcow2", ".img", ".bin", ".raw", ".pst", ".ost", ".db", ".sqlite", ".mdb", ".accdb", ".bak"],
};
const EXT_BUCKET = new Map();
for (const [b, exts] of Object.entries(BUCKETS)) for (const e of exts) EXT_BUCKET.set(e, b);

function bucketOf(name) {
  return EXT_BUCKET.get(path.extname(String(name)).toLowerCase()) || "other";
}

/** Bytes and counts per bucket for a list of { path|rel, size }. */
function classify(files) {
  const bytes = { media: 0, packed: 0, text: 0, office: 0, image: 0, other: 0 };
  const counts = { media: 0, packed: 0, text: 0, office: 0, image: 0, other: 0 };
  let total = 0;
  for (const f of files) {
    const b = bucketOf(f.rel || f.path);
    bytes[b] += f.size;
    counts[b] += 1;
    total += f.size;
  }
  return { bytes, counts, total, files: files.length };
}

/**
 * Deflate a sample of the largest files at level 1 and report ratio (out/in).
 * Reads at most `budget` bytes in total, spread over up to 12 files, taking a
 * slice from the middle of each (file heads are often atypical).
 */
async function probe(files, { budget = 24 * 1024 * 1024 } = {}) {
  const sorted = [...files].filter((f) => f.size > 0).sort((a, b) => b.size - a.size).slice(0, 12);
  if (!sorted.length) return { ratio: 1, sampled: 0 };
  const per = Math.max(64 * 1024, Math.floor(budget / sorted.length));
  let inBytes = 0;
  let outBytes = 0;
  for (const f of sorted) {
    const len = Math.min(per, f.size);
    const start = Math.max(0, Math.floor((f.size - len) / 2));
    let fh;
    try {
      fh = await fsp.open(f.path, "r");
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, start);
      const out = zlib.deflateRawSync(buf.subarray(0, bytesRead), { level: 1 });
      inBytes += bytesRead;
      outBytes += out.length;
    } catch {
      /* unreadable: skip */
    } finally {
      if (fh) await fh.close();
    }
  }
  return { ratio: inBytes ? outBytes / inBytes : 1, sampled: inBytes };
}

/**
 * Turn classification + probe into a recommendation.
 * @returns {{ format, level, solidCap, reason, estSavedPct, kind }}
 */
function suggest({ bytes, total, files }, probeRatio, { password = false } = {}) {
  const pct = (b) => (total ? Math.round((b / total) * 100) : 0);
  const media = pct(bytes.media + bytes.packed);
  const text = pct(bytes.text);
  const compressible = probeRatio < 0.9;
  const strong = probeRatio < 0.5;
  const avgSize = files ? total / files : 0;

  // Already-compressed content: don't waste hours for nothing.
  if (media >= 85 || (!compressible && total > 256 * 1024 * 1024)) {
    return {
      kind: "store",
      format: password ? "7z" : "zip",
      level: 0,
      solidCap: null,
      reason: `${media}% of the data is photos, video, audio or already-packed files. Compression gains almost nothing here, so Store mode packs at disk speed.${password ? " 7z is used because a ZIP can't hide file names." : ""}`,
      estSavedPct: Math.max(0, Math.round((1 - probeRatio) * 100)),
    };
  }
  // Mostly text/mail/code: LZMA2 solid does very well.
  if (text >= 60 || strong) {
    return {
      kind: "text",
      format: "7z",
      level: text >= 60 ? 7 : 5,
      solidCap: "256m",
      reason: `${text}% text-like content and a sample compressed to ${Math.round(probeRatio * 100)}% of its size. 7z (LZMA2, solid) will be several times smaller than ZIP. Solid blocks are capped at 256 MB so a damaged block can't take the whole archive with it.`,
      estSavedPct: Math.round((1 - probeRatio * 0.55) * 100),
    };
  }
  // Big disk images / databases: fast level, all threads.
  if (pct(bytes.image) >= 50 || avgSize > 2 * 1024 ** 3) {
    return {
      kind: "image",
      format: "7z",
      level: 3,
      solidCap: "1g",
      reason: `Large files (disk images, databases, backups). 7z at Fast keeps all cores busy and still finds the empty space and repeated blocks inside them.`,
      estSavedPct: Math.round((1 - probeRatio * 0.85) * 100),
    };
  }
  // Thousands of tiny files: ZIP overhead dominates.
  if (files > 5000 && avgSize < 64 * 1024) {
    return {
      kind: "many",
      format: "7z",
      level: 5,
      solidCap: "64m",
      reason: `${files.toLocaleString()} small files. ZIP stores each one separately and wastes space on headers; a solid 7z packs them together.`,
      estSavedPct: Math.round((1 - probeRatio * 0.7) * 100),
    };
  }
  return {
    kind: "mixed",
    format: "7z",
    level: 5,
    solidCap: "256m",
    reason: `Mixed content; a sample compressed to ${Math.round(probeRatio * 100)}% of its size. 7z at Normal is the balanced choice, with solid blocks capped at 256 MB.`,
    estSavedPct: Math.round((1 - probeRatio * 0.8) * 100),
  };
}

/**
 * Enumerate inputs into { path, rel, size, mtimeMs } with `rel` relative to the
 * common root (the parent of the dropped items). Folders are walked fully.
 */
async function enumerate(inputs, { signal, maxEntries = 2_000_000 } = {}) {
  const abs = inputs.map((p) => path.resolve(p));
  const root = commonRoot(abs);
  const files = [];
  let entries = 0;
  let base = root; // per-item fallback when inputs sit on different drives
  const walk = async (p) => {
    if (signal && signal.aborted) throw Object.assign(new Error("Cancelled"), { kind: "cancelled" });
    if (entries > maxEntries) throw Object.assign(new Error(`More than ${maxEntries.toLocaleString()} entries; split the job.`), { kind: "fatal" });
    let st;
    try {
      st = await fsp.lstat(p);
    } catch {
      return;
    }
    entries += 1;
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      let names = [];
      try {
        names = await fsp.readdir(p);
      } catch {
        return;
      }
      for (const n of names) await walk(path.join(p, n));
    } else {
      files.push({ path: p, rel: path.relative(base, p), size: st.size, mtimeMs: st.mtimeMs });
    }
  };
  for (const p of abs) {
    base = root || path.dirname(p);
    await walk(p);
  }
  return { root, files };
}

/** Deepest folder containing every input, or null when they're on different drives. */
function commonRoot(absPaths) {
  if (!absPaths.length) return null;
  const parts = absPaths.map((p) => path.dirname(p).split(path.sep));
  const first = parts[0];
  let n = first.length;
  for (const other of parts.slice(1)) {
    let i = 0;
    while (i < n && i < other.length && first[i].toLowerCase() === other[i].toLowerCase()) i += 1;
    n = i;
  }
  if (n === 0) return null;
  const root = first.slice(0, n).join(path.sep);
  return root.endsWith(":") ? `${root}${path.sep}` : root;
}

async function analyze(inputs, opts = {}) {
  const { root, files } = await enumerate(inputs, opts);
  const cls = classify(files);
  const pr = await probe(files);
  return { root, files: cls.files, total: cls.total, bytes: cls.bytes, counts: cls.counts, probeRatio: pr.ratio, sampled: pr.sampled, suggestion: suggest(cls, pr.ratio, { password: !!opts.password }) };
}

module.exports = { BUCKETS, bucketOf, classify, probe, suggest, enumerate, commonRoot, analyze };
