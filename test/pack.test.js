const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const analyze = require("../src/main/analyze");
const chunker = require("../src/main/chunker");
const manifest = require("../src/main/manifest");

const GB = 1000 ** 3;

test("classify buckets by extension and bytes", () => {
  const c = analyze.classify([
    { rel: "a.jpg", size: 900 },
    { rel: "b.MP4", size: 50 },
    { rel: "c.txt", size: 40 },
    { rel: "d.zip", size: 5 },
    { rel: "e.xyz", size: 5 },
  ]);
  assert.equal(c.total, 1000);
  assert.equal(c.bytes.media, 950);
  assert.equal(c.bytes.text, 40);
  assert.equal(c.bytes.packed, 5);
  assert.equal(c.bytes.other, 5);
  assert.equal(c.counts.media, 2);
  assert.equal(analyze.bucketOf("x.HEIC"), "media");
  assert.equal(analyze.bucketOf("noext"), "other");
});

test("suggest: media -> store; text -> 7z solid; password flips zip to 7z", () => {
  const media = analyze.suggest({ bytes: { media: 950, packed: 0, text: 50, office: 0, image: 0, other: 0 }, total: 1000, files: 10 }, 0.99);
  assert.equal(media.kind, "store");
  assert.equal(media.format, "zip");
  assert.equal(media.level, 0);
  const mediaPw = analyze.suggest({ bytes: { media: 950, packed: 0, text: 50, office: 0, image: 0, other: 0 }, total: 1000, files: 10 }, 0.99, { password: true });
  assert.equal(mediaPw.format, "7z");

  const text = analyze.suggest({ bytes: { media: 0, packed: 0, text: 800, office: 100, image: 0, other: 100 }, total: 1000, files: 300 }, 0.3);
  assert.equal(text.kind, "text");
  assert.equal(text.format, "7z");
  assert.equal(text.solidCap, "256m");
  assert.ok(text.estSavedPct > 50);

  const many = analyze.suggest({ bytes: { media: 0, packed: 0, text: 100, office: 0, image: 0, other: 900 }, total: 20000 * 1000, files: 20000 }, 0.7);
  assert.equal(many.kind, "many");

  const img = analyze.suggest({ bytes: { media: 0, packed: 0, text: 0, office: 0, image: 10 * GB, other: 0 }, total: 10 * GB, files: 2 }, 0.8);
  assert.equal(img.kind, "image");
  assert.equal(img.level, 3);

  const mixed = analyze.suggest({ bytes: { media: 300, packed: 0, text: 300, office: 200, image: 0, other: 200 }, total: 1000, files: 50 }, 0.7);
  assert.equal(mixed.kind, "mixed");
});

test("commonRoot finds the shared parent, null across drives", () => {
  assert.equal(analyze.commonRoot(["C:\\a\\b\\x.txt", "C:\\a\\b\\c\\y.txt"]), "C:\\a\\b");
  assert.equal(analyze.commonRoot(["C:\\a\\x", "C:\\A\\y"]), "C:\\a");
  assert.equal(analyze.commonRoot(["C:\\x", "D:\\y"]), null);
  assert.equal(analyze.commonRoot(["C:\\x"]), "C:\\");
});

test("enumerate gives root-relative paths and walks folders", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "unp-enum-"));
  try {
    fs.mkdirSync(path.join(d, "A", "sub"), { recursive: true });
    fs.writeFileSync(path.join(d, "A", "sub", "f.txt"), "hello");
    fs.writeFileSync(path.join(d, "top.bin"), "xx");
    const r = await analyze.enumerate([path.join(d, "A"), path.join(d, "top.bin")]);
    assert.equal(r.root, d);
    assert.deepEqual(r.files.map((f) => f.rel).sort(), [path.join("A", "sub", "f.txt"), "top.bin"]);
    assert.equal(r.files.find((f) => f.rel === "top.bin").size, 2);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test("planChunks keeps folders together, splits big ones, flags oversized", () => {
  const files = [
    { rel: "2019/a.jpg", size: 3 * GB },
    { rel: "2019/b.jpg", size: 0.5 * GB },
    { rel: "2020/c.jpg", size: 2 * GB },
    { rel: "2021/d.mp4", size: 3 * GB },
    { rel: "2021/e.mp4", size: 2.5 * GB },
    { rel: "huge.iso", size: 9 * GB },
    { rel: "root.txt", size: 1 },
  ];
  const { chunks, oversized } = chunker.planChunks(files, 4 * GB);
  assert.deepEqual(oversized.map((f) => f.rel), ["huge.iso"]);
  for (const c of chunks) assert.ok(c.bytes <= 4 * GB * chunker.SAFETY, `chunk ${c.index} under limit`);
  const chunkOf = (rel) => chunks.find((c) => c.files.some((f) => f.rel === rel)).index;
  assert.equal(chunkOf("2019/a.jpg"), chunkOf("2019/b.jpg"), "2019 stays together (3.5 GB fits)");
  assert.notEqual(chunkOf("2021/d.mp4"), chunkOf("2021/e.mp4"), "2021 (5.5 GB) had to split");
  const all = chunks.flatMap((c) => c.files.map((f) => f.rel)).sort();
  assert.deepEqual(all, files.filter((f) => f.rel !== "huge.iso").map((f) => f.rel).sort(), "every file placed exactly once");
  assert.equal(chunker.planChunks(files, 0).chunks.length, 1, "no limit = one chunk");
  assert.equal(chunker.chunkLabel(3, 12), "03of12");
  assert.equal(chunker.chunkLabel(1, 100), "001of100");
  assert.equal(chunker.chunkBytes("4g"), 4000 * 1024 ** 2);
  assert.equal(chunker.chunkBytes("nope"), 0);
});

test("manifest ids and round-trip", () => {
  const id = manifest.makeId();
  assert.equal(id.length, 8);
  assert.ok(manifest.isId(id));
  assert.ok(!/[0O1I]/.test(id));
  assert.equal(manifest.isId("abc"), false);

  const text = manifest.renderManifest({
    id: "K7M3Q9XZ",
    name: "Photos",
    created: "2026-09-12T14:01:02Z",
    format: "7z",
    chunkLimit: "4g (chunks)",
    chunks: [
      { label: "01of02", file: "Photos_K7M3Q9XZ-01of02.7z", bytes: 10 },
      { label: "02of02", file: "Photos_K7M3Q9XZ-02of02.7z.001", bytes: 20, volumes: true },
    ],
    files: [
      { chunk: "01of02", rel: "2019 Trip\\IMG_1.jpg", size: 10, mtimeMs: Date.UTC(2019, 6, 1, 10), sha256: "ab" },
      { chunk: "02of02", rel: "big.iso", size: 20, mtimeMs: 0, sha256: "cd" },
    ],
    hashed: true,
  });
  assert.match(text, /^# Unpacker V2 manifest\nid: K7M3Q9XZ\n/);
  assert.match(text, /\n01of02\t2019 Trip\/IMG_1.jpg\t10\t2019-07-01T10:00:00Z\tab\n/, "backslashes normalised, ISO dates");
  const m = manifest.parseManifest(text);
  assert.equal(m.id, "K7M3Q9XZ");
  assert.equal(m.hashed, true);
  assert.equal(m.chunks.length, 2);
  assert.equal(m.chunks[1].volumes, true);
  assert.deepEqual(m.files.map((f) => f.rel), ["2019 Trip/IMG_1.jpg", "big.iso"]);
  assert.equal(m.files[1].sha256, "cd");
  const noHash = manifest.parseManifest(manifest.renderManifest({ id: "AB", name: "n", created: "", format: "zip", chunks: [{ label: "01of01", file: "n.zip", bytes: 1 }], files: [{ chunk: "01of01", rel: "a", size: 1, mtimeMs: 0 }], hashed: false }));
  assert.equal(noHash.hashed, false);
  assert.equal(noHash.files[0].sha256, "");
});

test("hashFile streams sha256", async () => {
  const f = path.join(os.tmpdir(), `unp-hash-${process.pid}.bin`);
  fs.writeFileSync(f, "abc");
  try {
    assert.equal(await manifest.hashFile(f), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  } finally {
    fs.rmSync(f);
  }
});
