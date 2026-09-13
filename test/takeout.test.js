const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const tk = require("../src/main/takeout");

test("parseTakeoutName recognises Google's part names only", () => {
  assert.deepEqual(tk.parseTakeoutName("C:\\dl\\takeout-20260912T140102Z-001.zip"), { stamp: "20260912T140102Z", set: 0, index: 1, copy: 0, format: "zip" });
  assert.deepEqual(tk.parseTakeoutName("TAKEOUT-20260912T140102Z-012.TGZ"), { stamp: "20260912T140102Z", set: 0, index: 12, copy: 0, format: "tgz" });
  assert.equal(tk.parseTakeoutName("takeout-20260912T140102Z-001.tar.gz").format, "tgz");
  // real multi-set exports carry "-<set>-" and browsers add " (1)" on a re-download
  assert.deepEqual(tk.parseTakeoutName("takeout-20260912T132526Z-2-028 (1).zip"), { stamp: "20260912T132526Z", set: 2, index: 28, copy: 1, format: "zip" });
  assert.equal(tk.parseTakeoutName("photos.zip"), null);
  assert.equal(tk.parseTakeoutName("takeout-2026-001.zip"), null);
  assert.equal(tk.isTakeoutPart("takeout-20260912T140102Z-003.zip"), true);
});

test("groupTakeout separates sets and folds re-downloads into duplicates", () => {
  const paths = ["d/takeout-20260912T132526Z-1-001.zip", "d/takeout-20260912T132526Z-2-001.zip", "d/takeout-20260912T132526Z-2-002 (1).zip", "d/takeout-20260912T132526Z-2-002.zip"];
  const g = tk.groupTakeout(paths, (p) => (p.includes("(1)") ? 5 : 10));
  assert.equal(g.length, 2);
  assert.deepEqual(g.map((x) => x.set), [1, 2]);
  const set2 = g[1];
  assert.deepEqual(set2.parts.map((p) => `${p.index}:${p.copy}`), ["1:0", "2:0"], "the un-suffixed download wins");
  assert.equal(set2.duplicates.length, 1);
  assert.equal(set2.duplicates[0].sameSize, false, "different size flagged");
  assert.equal(set2.totalBytes, 20);
});

test("groupTakeout groups by timestamp, sorts parts, reports gaps and sizes", () => {
  const paths = [
    "d/takeout-20260912T140102Z-003.zip",
    "d/takeout-20260912T140102Z-001.zip",
    "d/takeout-20260901T090000Z-001.tgz",
    "d/sub/takeout-20260912T140102Z-001.zip", // duplicate copy, ignored
    "d/random.zip",
  ];
  const sizes = { "d/takeout-20260912T140102Z-003.zip": 30, "d/takeout-20260912T140102Z-001.zip": 10, "d/takeout-20260901T090000Z-001.tgz": 5 };
  const g = tk.groupTakeout(paths, (p) => sizes[p] || 0);
  assert.equal(g.length, 2);
  assert.equal(g[0].stamp, "20260912T140102Z", "newest export first");
  assert.deepEqual(g[0].parts.map((p) => p.index), [1, 3]);
  assert.deepEqual(g[0].missing, [2]);
  assert.equal(g[0].totalBytes, 40);
  assert.equal(g[0].date, "2026-09-12 14:01 UTC");
  assert.equal(g[1].format, "tgz");
  assert.deepEqual(g[1].missing, []);
  assert.deepEqual(tk.groupTakeout([]), []);
});

test("flattenRoot moves Takeout/* up, merges folders, keeps existing files", () => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "unp-tk-"));
  try {
    fs.mkdirSync(path.join(dest, "Takeout", "Google Photos", "Album"), { recursive: true });
    fs.writeFileSync(path.join(dest, "Takeout", "Google Photos", "Album", "a.jpg"), "a");
    fs.writeFileSync(path.join(dest, "Takeout", "archive_browser.html"), "x");
    fs.mkdirSync(path.join(dest, "Google Photos", "Other"), { recursive: true });
    fs.writeFileSync(path.join(dest, "archive_browser.html"), "existing");
    const r = tk.flattenRoot(dest);
    assert.equal(fs.existsSync(path.join(dest, "Google Photos", "Album", "a.jpg")), true);
    assert.equal(fs.existsSync(path.join(dest, "Google Photos", "Other")), true);
    assert.equal(fs.readFileSync(path.join(dest, "archive_browser.html"), "utf8"), "existing", "existing file untouched");
    assert.equal(r.skipped, 1);
    assert.equal(fs.existsSync(path.join(dest, "Takeout", "archive_browser.html")), true, "skipped file stays in the wrapper");
    assert.deepEqual(tk.flattenRoot(path.join(dest, "nowhere")), { moved: 0, skipped: 0 });
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

test("tidyPhotoSidecars only touches JSON under Google Photos", () => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "unp-tk-"));
  try {
    fs.mkdirSync(path.join(dest, "Takeout", "Google Photos", "Trip"), { recursive: true });
    fs.mkdirSync(path.join(dest, "Takeout", "Drive"), { recursive: true });
    fs.writeFileSync(path.join(dest, "Takeout", "Google Photos", "Trip", "IMG_1.jpg"), "");
    fs.writeFileSync(path.join(dest, "Takeout", "Google Photos", "Trip", "IMG_1.jpg.json"), "{}");
    fs.writeFileSync(path.join(dest, "Takeout", "Google Photos", "Trip", "metadata.json"), "{}");
    fs.writeFileSync(path.join(dest, "Takeout", "Drive", "notes.json"), "{}");
    const r = tk.tidyPhotoSidecars(dest);
    assert.equal(r.moved, 2);
    assert.equal(fs.existsSync(path.join(dest, "Takeout", "Google Photos", "Trip", "_json", "IMG_1.jpg.json")), true);
    assert.equal(fs.existsSync(path.join(dest, "Takeout", "Google Photos", "Trip", "IMG_1.jpg")), true);
    assert.equal(fs.existsSync(path.join(dest, "Takeout", "Drive", "notes.json")), true, "Drive JSON untouched");
    assert.equal(tk.tidyPhotoSidecars(dest).moved, 0, "idempotent");
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

test("resume state round-trips and matches on size + mtime", () => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "unp-tk-"));
  try {
    assert.deepEqual(tk.readState(dest), { done: {} });
    const state = { done: { "takeout-x-001.zip": { size: 10, mtimeMs: 5 } } };
    tk.writeState(dest, state);
    assert.deepEqual(tk.readState(dest), state);
    assert.equal(tk.partIsDone(state, { path: "a/takeout-x-001.zip" }, { size: 10, mtimeMs: 5 }), true);
    assert.equal(tk.partIsDone(state, { path: "a/takeout-x-001.zip" }, { size: 11, mtimeMs: 5 }), false, "re-downloaded part is not done");
    assert.equal(tk.partIsDone(state, { path: "a/takeout-x-002.zip" }, { size: 10, mtimeMs: 5 }), false);
    tk.clearState(dest);
    assert.equal(fs.existsSync(path.join(dest, tk.STATE_FILE)), false);
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
  }
});
