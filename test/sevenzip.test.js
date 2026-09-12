const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const sz = require("../src/main/engine/sevenzip");

test("progress parser handles backspace redraws and split chunks", () => {
  const seen = [];
  const feed = sz.createProgressParser((p) => seen.push(p));
  feed("\r  0%");
  feed("\b\b\b\b 12% 3 - dir\\file one.txt");
  feed("\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b 4");
  feed("5% 9 - other.bin\r\n");
  feed("100%\r\n");
  assert.deepEqual(seen[0], { percent: 0, file: undefined });
  assert.deepEqual(seen[1], { percent: 12, file: "dir\\file one.txt" });
  assert.ok(seen.some((p) => p.percent === 45 && p.file === "other.bin"), "split number re-joined");
  assert.equal(seen.at(-1).percent, 100);
  // adding prints "+ name" (not "- name"); compress progress must still parse
  const adds = [];
  const feedAdd = sz.createProgressParser((p) => adds.push(p));
  feedAdd(" 37% 12 + Album\\IMG_1.jpg\b\b\b\b 38% U changed.txt\r\n");
  assert.deepEqual(adds[0], { percent: 37, file: "Album\\IMG_1.jpg" });
  assert.deepEqual(adds[1], { percent: 38, file: "changed.txt" });
});

test("progress parser ignores unrelated output", () => {
  const seen = [];
  const feed = sz.createProgressParser((p) => seen.push(p));
  feed("7-Zip 24.08 (x64)\nScanning the drive:\n3 files, 100% not a progress line\n");
  assert.equal(seen.length, 0);
});

test("classify maps 7-Zip outcomes", () => {
  assert.equal(sz.classify(0, "Everything is Ok").kind, "ok");
  assert.equal(sz.classify(2, "ERROR: Wrong password : a.txt").kind, "password");
  assert.equal(sz.classify(2, "Can not open encrypted archive. Wrong password?").kind, "password");
  assert.equal(sz.classify(2, "ERROR: Headers Error").kind, "corrupt");
  assert.equal(sz.classify(2, "Unexpected end of archive").kind, "corrupt");
  assert.equal(sz.classify(2, "Can not open the file as archive").kind, "unsupported");
  assert.equal(sz.classify(2, "ERROR: There is not enough space on the disk. : x").kind, "diskfull");
  assert.equal(sz.classify(1, "WARNING: The system cannot find the file specified.").kind, "warning");
  assert.equal(sz.classify(255, "").kind, "cancelled");
  assert.equal(sz.classify(null, "").kind, "cancelled");
  assert.equal(sz.classify(8, "").kind, "fatal");
});

const LIST = `
7-Zip 24.08 (x64) : Copyright (c) 1999-2024 Igor Pavlov : 2024-08-11

Scanning the drive for archives:
1 file, 1234 bytes (2 KiB)

Listing archive: x.zip

--
Path = x.zip
Type = zip
Physical Size = 1234

----------
Path = docs
Folder = +
Size = 0
Packed Size = 0
Modified = 2026-01-01 10:00:00
Attributes = D
Encrypted = -

Path = docs\\a.txt
Folder = -
Size = 500
Packed Size = 200
Modified = 2026-01-01 10:00:00
Attributes = A
Encrypted = +

Path = b.bin
Folder = -
Size = 1500
Packed Size = 900
Attributes = A
Encrypted = -
`;

test("parseList reads -slt output", () => {
  const r = sz.parseList(LIST.replace(/\n/g, "\r\n"));
  assert.equal(r.archive.Type, "zip");
  assert.equal(r.archive["Physical Size"], "1234");
  assert.equal(r.entries.length, 3);
  assert.equal(r.entries[0].isDir, true);
  assert.equal(r.entries[1].encrypted, true);
  assert.equal(r.totals.files, 2);
  assert.equal(r.totals.dirs, 1);
  assert.equal(r.totals.size, 2000);
  assert.equal(r.totals.packed, 1100);
  assert.equal(r.totals.encrypted, true);
});

test("singleRoot detects a lone top-level folder", () => {
  assert.equal(sz.singleRoot([{ path: "proj", isDir: true }, { path: "proj\\a.txt" }, { path: "proj\\src\\b.js" }]), "proj");
  assert.equal(sz.singleRoot([{ path: "a.txt" }, { path: "b.txt" }]), null);
  assert.equal(sz.singleRoot([{ path: "proj\\a" }, { path: "other\\b" }]), null);
  assert.equal(sz.singleRoot([{ path: "only.txt", isDir: false }]), null);
  assert.equal(sz.singleRoot([]), null);
});

test("argument builders", () => {
  const a = sz.addArgs("out.7z", "list.txt", { type: "7z", level: 9, password: "pw", split: "4000m" });
  assert.deepEqual(a.slice(0, 2), ["a", "-t7z"]);
  assert.ok(a.includes("-mx=9") && a.includes("-ppw") && a.includes("-mhe=on") && a.includes("-v4000m"));
  assert.equal(a.at(-1), "@list.txt");

  const z = sz.addArgs("out.zip", "l", { type: "zip", level: 5, password: "pw" });
  assert.ok(z.includes("-mem=AES256") && !z.includes("-mhe=on"));

  const t = sz.addArgs("out.tar", "l", { type: "tar" });
  assert.ok(!t.some((x) => x.startsWith("-mx")), "tar takes no level");

  const x = sz.extractArgs("a.zip", "C:\\out", { overwrite: "skip" });
  assert.deepEqual(x.slice(0, 4), ["x", "a.zip", "-oC:\\out", "-aos"]);
  assert.equal(x[4], `-p${sz.NO_PASSWORD}`);
  assert.equal(sz.extractArgs("a", "b", { password: "s3cret" })[4], "-ps3cret");
  assert.deepEqual(sz.listArgs("a.7z").slice(0, 3), ["l", "-slt", "a.7z"]);
  assert.equal(sz.testArgs("a.7z")[0], "t");
});

test("locate prefers the bundled engine, then the user's install", () => {
  const have = new Set([path.join("R", "7zip", "7z.exe"), "C:\\Program Files\\7-Zip\\7z.exe"]);
  const exists = (p) => have.has(p);
  assert.equal(sz.locate({ resourcesPath: "R", exists, env: {} }), path.join("R", "7zip", "7z.exe"));
  assert.equal(sz.locate({ resourcesPath: "nope", appPath: "nope", exists, env: { ProgramFiles: "C:\\Program Files" } }), "C:\\Program Files\\7-Zip\\7z.exe");
  assert.equal(sz.locate({ exists: () => false, env: {} }), null);
});
