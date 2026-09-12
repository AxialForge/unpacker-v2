// Bin-pack files into independent archives that each stay under a size limit.
// Pure; tested.
//
// Strategy: keep top-level folders together when they fit (so "2019 Trip" is
// one archive, not scattered across three), first-fit-decreasing on those
// groups, then split any group that is itself over the limit file by file.
// A single file larger than the limit can't be chunked; it's reported as
// `oversized` and the runner packs it alone as a volume set.
//
// Limits are compared against RAW size. Compressed output is never larger
// than raw in practice (Store adds ~0.1% headers, which the small margin covers).

const SAFETY = 0.995; // leave room for archive headers

const CHUNK_SIZES = [
  { id: "", label: "No limit (one archive)", bytes: 0 },
  { id: "1g", label: "1 GB", bytes: 1 * 1000 ** 3 },
  { id: "2g", label: "2 GB", bytes: 2 * 1000 ** 3 },
  { id: "4g", label: "4 GB (FAT32 safe)", bytes: 4000 * 1024 ** 2 },
  { id: "10g", label: "10 GB", bytes: 10 * 1000 ** 3 },
  { id: "20g", label: "20 GB", bytes: 20 * 1000 ** 3 },
  { id: "50g", label: "50 GB", bytes: 50 * 1000 ** 3 },
];

function chunkBytes(id) {
  const c = CHUNK_SIZES.find((x) => x.id === id);
  return c ? c.bytes : 0;
}

/** Top-level segment of a relative path, "" for files at the root. */
function groupKey(rel) {
  const i = String(rel).search(/[\\/]/);
  return i < 0 ? "" : rel.slice(0, i);
}

/**
 * @param {Array<{rel:string,size:number}>} files
 * @param {number} limit bytes; 0 = no limit
 * @returns {{ chunks: Array<{index:number, files:Array, bytes:number}>, oversized: Array }}
 */
function planChunks(files, limit) {
  if (!limit) return { chunks: [{ index: 1, files: [...files], bytes: files.reduce((n, f) => n + f.size, 0) }], oversized: [] };
  const cap = Math.floor(limit * SAFETY);
  const oversized = files.filter((f) => f.size > cap);
  const rest = files.filter((f) => f.size <= cap);

  // Build a folder tree, then take the DEEPEST folders that fit under the cap
  // as indivisible units. A folder that doesn't fit is opened up into its
  // subfolders and loose files, recursively. So "Album/2019 Trip" travels as
  // one unit even when "Album" itself is far over the limit.
  const tree = { key: "", files: [], dirs: new Map(), bytes: 0 };
  for (const f of rest) {
    const segs = String(f.rel).split(/[\\/]/);
    let node = tree;
    node.bytes += f.size;
    for (const seg of segs.slice(0, -1)) {
      if (!node.dirs.has(seg)) node.dirs.set(seg, { key: node.key ? `${node.key}/${seg}` : seg, files: [], dirs: new Map(), bytes: 0 });
      node = node.dirs.get(seg);
      node.bytes += f.size;
    }
    node.files.push(f);
  }
  const collect = (node) => {
    const out = [];
    for (const f of node.files) out.push(f);
    for (const d of node.dirs.values()) out.push(...collect(d));
    return out;
  };
  const units = [];
  const unitize = (node) => {
    if (node.bytes <= cap && (node.key || node.dirs.size === 0)) {
      units.push({ key: node.key, files: collect(node), bytes: node.bytes });
      return;
    }
    for (const f of node.files) units.push({ key: node.key, files: [f], bytes: f.size });
    for (const d of node.dirs.values()) unitize(d);
  };
  unitize(tree);
  units.sort((a, b) => b.bytes - a.bytes || a.key.localeCompare(b.key));

  // first-fit decreasing
  const bins = [];
  for (const u of units) {
    let placed = false;
    for (const b of bins) {
      if (b.bytes + u.bytes <= cap) {
        b.files.push(...u.files);
        b.bytes += u.bytes;
        placed = true;
        break;
      }
    }
    if (!placed) bins.push({ files: [...u.files], bytes: u.bytes });
  }
  // stable, readable order inside each chunk
  for (const b of bins) b.files.sort((a, c) => a.rel.localeCompare(c.rel));
  return { chunks: bins.map((b, i) => ({ index: i + 1, files: b.files, bytes: b.bytes })), oversized };
}

/** "01of07" style labels, width grows with the count. */
function chunkLabel(index, count) {
  const w = Math.max(2, String(count).length);
  return `${String(index).padStart(w, "0")}of${String(count).padStart(w, "0")}`;
}

module.exports = { CHUNK_SIZES, chunkBytes, planChunks, chunkLabel, groupKey, SAFETY };
