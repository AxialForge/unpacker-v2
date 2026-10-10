const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const lib = require("../src/main/library");

test("kindOf / viewOf classify by extension", () => {
  assert.equal(lib.kindOf("a.JPG"), "photo");
  assert.equal(lib.viewOf("a.heic"), "none", "HEIC is a photo but not shown inline");
  assert.equal(lib.viewOf("x.csv"), "table");
  assert.equal(lib.kindOf("noext"), "other");
});

test("Library resolves only inside an opened root and lists, reads, searches", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "unp-lib-"));
  try {
    fs.mkdirSync(path.join(root, "Memories", "2024"), { recursive: true });
    fs.mkdirSync(path.join(root, "Account data"));
    fs.writeFileSync(path.join(root, "Snapchat library report.txt"), "report");
    fs.writeFileSync(path.join(root, "Memories", "index.csv"), 'a,b\r\n1,"x,y"\r\n');
    fs.writeFileSync(path.join(root, "Memories", "2024", "pic.jpg"), "jpg");
    const L = new lib.Library();
    const o = L.open(root);
    assert.equal(o.kind, "snapchat");
    assert.equal(o.summary.name, "Snapchat library report.txt");
    assert.equal(L.open(root).id, o.id, "same folder, same id");
    assert.equal(L.resolve(o.id, "../x"), null);
    assert.equal(L.resolve(o.id, "Memories/2024/pic.jpg"), path.join(root, "Memories", "2024", "pic.jpg"));
    assert.equal(L.resolve("nope", ""), null);
    const l = await L.list(o.id, "Memories");
    assert.deepEqual(l.dirs.map((d) => [d.name, d.count]), [["2024", 1]]);
    assert.equal(l.files[0].view, "table");
    const r = await L.read(o.id, "Memories/index.csv");
    assert.deepEqual(lib.parseCsv(r.text).rows, [["a", "b"], ["1", "x,y"]]);
    const s = await L.search(o.id, "PIC");
    assert.deepEqual(s.hits.map((h) => h.rel), ["Memories/2024/pic.jpg"]);
    assert.ok((await L.list(o.id, "..")).error);
    assert.ok(L.open(path.join(root, "Memories", "index.csv")).error);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Library resolve works for a drive root and refuses a junction that leads outside", async () => {
  const L = new lib.Library();
  const drive = path.parse(process.cwd()).root; // e.g. C:\\
  const o = L.open(drive);
  assert.ok(!o.error);
  assert.equal(L.resolve(o.id, "Windows"), path.join(drive, "Windows"));
  assert.equal(L.resolve(o.id, ".."), drive, "cannot climb above a drive root");
  if (process.platform === "win32") {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "unp-lib-link-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "unp-lib-outside-"));
    try {
      fs.writeFileSync(path.join(outside, "secret.txt"), "x");
      fs.symlinkSync(outside, path.join(root, "jump"), "junction");
      const r = L.open(root);
      assert.equal(L.resolve(r.id, "jump/secret.txt"), null, "a junction out of the folder is not followed");
      const l = await L.list(r.id, "jump");
      assert.ok(l.error, "listing through the junction is refused too");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  }
});
