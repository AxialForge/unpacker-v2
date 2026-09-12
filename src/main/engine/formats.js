// Archive format knowledge. Pure module: no Electron, no fs, fully unit-tested.
//
// Two questions are answered here:
//   detectArchive(path) — is this file an archive we can open, and how?
//   TARGETS             — which formats can we create, with which knobs?
//
// 7-Zip's own type names (-t switch) are used throughout. "Compound" formats
// (tar.gz, tar.xz, ...) are two 7-Zip passes: an outer stream compressor around
// an inner tar. 7-Zip cannot do them in one step, so the engine runs two.

const path = require("node:path");

// ext (lower-case, with dot) -> 7-Zip type. Extraction only unless also in TARGETS.
const SINGLE = {
  ".7z": "7z",
  ".zip": "zip",
  ".zipx": "zip",
  ".jar": "zip",
  ".war": "zip",
  ".ear": "zip",
  ".apk": "zip",
  ".ipa": "zip",
  ".xpi": "zip",
  ".nupkg": "zip",
  ".epub": "zip",
  ".rar": "rar",
  ".tar": "tar",
  ".gz": "gzip",
  ".bz2": "bzip2",
  ".xz": "xz",
  ".zst": "zstd",
  ".lz": "lzip",
  ".lzma": "lzma",
  ".z": "z",
  ".cab": "cab",
  ".iso": "iso",
  ".wim": "wim",
  ".esd": "wim",
  ".swm": "wim",
  ".arj": "arj",
  ".lzh": "lzh",
  ".lha": "lzh",
  ".cpio": "cpio",
  ".rpm": "rpm",
  ".deb": "deb",
  ".dmg": "dmg",
  ".vhd": "vhd",
  ".vhdx": "vhdx",
  ".msi": "msi",
  ".chm": "chm",
  ".squashfs": "squashfs",
  ".cramfs": "cramfs",
  ".img": "auto",
  ".001": "split", // 7-Zip multi-volume: archive.7z.001, archive.zip.001, ...
};

// name suffix -> { outer, inner }. Checked before SINGLE so "x.tar.gz" wins over ".gz".
const COMPOUND = {
  ".tar.gz": { outer: "gzip", inner: "tar" },
  ".tgz": { outer: "gzip", inner: "tar" },
  ".tar.bz2": { outer: "bzip2", inner: "tar" },
  ".tbz2": { outer: "bzip2", inner: "tar" },
  ".tbz": { outer: "bzip2", inner: "tar" },
  ".tar.xz": { outer: "xz", inner: "tar" },
  ".txz": { outer: "xz", inner: "tar" },
  ".tar.zst": { outer: "zstd", inner: "tar" },
  ".tzst": { outer: "zstd", inner: "tar" },
  ".tar.lz": { outer: "lzip", inner: "tar" },
  ".tar.lzma": { outer: "lzma", inner: "tar" },
  ".tlz": { outer: "lzma", inner: "tar" },
  ".tar.z": { outer: "z", inner: "tar" },
};

// Volumes that are NOT the entry point of a split set. Dropping a whole set of
// parts must open the set once, from its first volume, not once per part.
const CONTINUATION = [
  /\.(?:00[2-9]|0[1-9]\d|[1-9]\d\d)$/i, // .002 ... .999 (7-Zip -v volumes)
  /\.part(?:0*[2-9]|0*[1-9]\d+)\.rar$/i, // .part2.rar, .part02.rar, .part10.rar
  /\.r\d\d$/i, // old-style .r00 .r01 (entry point is .rar)
  /\.z\d\d$/i, // WinZip split .z01 .z02 (entry point is .zip)
];

/**
 * Classify a file by name. Returns null for non-archives.
 * @returns {{ type:string, inner?:string, ext:string, entryPoint:boolean, split:boolean, baseName:string } | null}
 */
function detectArchive(filePath) {
  const orig = path.basename(String(filePath || ""));
  const name = orig.toLowerCase(); // match case-insensitively, but slice baseName from `orig`
  if (!name) return null;

  for (const rx of CONTINUATION) {
    if (rx.test(name)) return { type: "volume", ext: name.slice(name.lastIndexOf(".")), entryPoint: false, split: true, baseName: name };
  }

  for (const [suffix, { outer, inner }] of Object.entries(COMPOUND)) {
    if (name.endsWith(suffix) && name.length > suffix.length) {
      return { type: outer, inner, ext: suffix, entryPoint: true, split: false, baseName: orig.slice(0, -suffix.length) };
    }
  }

  const ext = path.extname(name);
  if (!ext) return null;

  if (ext === ".001") {
    // "archive.7z.001" -> the real type is whatever precedes .001
    const innerName = orig.slice(0, -4);
    const innerDet = detectArchive(innerName);
    return {
      type: innerDet ? innerDet.type : "auto",
      inner: innerDet ? innerDet.inner : undefined,
      ext: ".001",
      entryPoint: true,
      split: true,
      baseName: innerDet ? innerDet.baseName : innerName,
    };
  }
  if (/\.part0*1\.rar$/i.test(name)) {
    return { type: "rar", ext: ".rar", entryPoint: true, split: true, baseName: name.replace(/\.part0*1\.rar$/i, "") };
  }

  const type = SINGLE[ext];
  if (!type) return null;
  return { type, ext, entryPoint: true, split: false, baseName: orig.slice(0, -ext.length) };
}

/** True when the path looks like an archive we can open (an entry point or a continuation volume). */
const isArchive = (p) => detectArchive(p) != null;

// ── creation targets ────────────────────────────────────────────
// id -> how to build it. `engine` is "7z" or "rar" (WinRAR, only when installed).
const TARGETS = {
  "7z": { id: "7z", label: "7z (best compression)", ext: ".7z", engine: "7z", type: "7z", encrypt: true, headerEncrypt: true, split: true, levels: true },
  zip: { id: "zip", label: "ZIP (most compatible, ZIP64)", ext: ".zip", engine: "7z", type: "zip", encrypt: true, headerEncrypt: false, split: true, levels: true },
  tar: { id: "tar", label: "tar (no compression)", ext: ".tar", engine: "7z", type: "tar", encrypt: false, headerEncrypt: false, split: false, levels: false },
  "tar.gz": { id: "tar.gz", label: "tar.gz", ext: ".tar.gz", engine: "7z", type: "gzip", inner: "tar", encrypt: false, headerEncrypt: false, split: false, levels: true },
  "tar.xz": { id: "tar.xz", label: "tar.xz", ext: ".tar.xz", engine: "7z", type: "xz", inner: "tar", encrypt: false, headerEncrypt: false, split: false, levels: true },
  "tar.bz2": { id: "tar.bz2", label: "tar.bz2", ext: ".tar.bz2", engine: "7z", type: "bzip2", inner: "tar", encrypt: false, headerEncrypt: false, split: false, levels: true },
  rar: { id: "rar", label: "RAR (needs installed WinRAR)", ext: ".rar", engine: "rar", type: "rar", encrypt: true, headerEncrypt: true, split: true, levels: true },
};

/** Targets available given engine presence. */
function availableTargets({ rar = false } = {}) {
  return Object.values(TARGETS).filter((t) => t.engine !== "rar" || rar);
}

// Level presets shown in the UI, mapped to 7-Zip -mx and WinRAR -m.
const LEVELS = [
  { id: 0, label: "Store (no compression)", mx: 0, rar: 0 },
  { id: 1, label: "Fastest", mx: 1, rar: 1 },
  { id: 3, label: "Fast", mx: 3, rar: 2 },
  { id: 5, label: "Normal", mx: 5, rar: 3 },
  { id: 7, label: "Maximum", mx: 7, rar: 4 },
  { id: 9, label: "Ultra (slow)", mx: 9, rar: 5 },
];

// Split-volume presets. 7-Zip and WinRAR both accept "<n>m" / "<n>g". The
// "4 GB" preset is 4000 MiB, deliberately under FAT32's 4 GiB-1 file limit.
const SPLIT_SIZES = [
  { id: "", label: "No split" },
  { id: "100m", label: "100 MB" },
  { id: "700m", label: "700 MB (CD)" },
  { id: "1000m", label: "1 GB" },
  { id: "2000m", label: "2 GB" },
  { id: "4000m", label: "4 GB (FAT32 safe)" },
  { id: "8000m", label: "8 GB" },
];

module.exports = { detectArchive, isArchive, TARGETS, availableTargets, LEVELS, SPLIT_SIZES, SINGLE, COMPOUND };
