const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const s = require("../src/main/safety");

test("unsafeEntries catches traversal, rooted and drive paths", () => {
  const bad = s.unsafeEntries(["ok/a.txt", "../evil.txt", "C:\\Windows\\x", "/etc/passwd", "\\\\server\\share", "sub/../../up", "dots..in.name/fine"]);
  assert.deepEqual(bad, ["../evil.txt", "C:\\Windows\\x", "/etc/passwd", "\\\\server\\share", "sub/../../up"]);
  assert.deepEqual(s.unsafeEntries([]), []);
});

test("bombRisk needs both a huge ratio and a large size", () => {
  assert.equal(s.bombRisk({ packed: 1000, size: 50000 }), false); // 50:1, small
  assert.equal(s.bombRisk({ packed: 5 * 1024 ** 2, size: 2 * 1024 ** 3 }), false); // 400:1
  assert.equal(s.bombRisk({ packed: 1024 ** 2, size: 4 * 1024 ** 3 }), true); // 4096:1 and 4 GB
  assert.equal(s.bombRisk({ packed: 0, size: 4 * 1024 ** 3 }), false);
});

test("longPath prefixes only long win32 paths", () => {
  const long = `C:\\${"a".repeat(300)}`;
  assert.equal(s.longPath(long, "win32"), `\\\\?\\${long}`);
  assert.equal(s.longPath("C:\\short", "win32"), "C:\\short");
  assert.equal(s.longPath(`\\\\?\\${long}`, "win32"), `\\\\?\\${long}`);
  assert.equal(s.longPath(`\\\\srv\\${"b".repeat(300)}`, "win32").startsWith("\\\\?\\UNC\\srv\\"), true);
  assert.equal(s.longPath(long, "linux"), long);
});

test("uniquePath appends (n) before the extension, compound aware", () => {
  const taken = new Set([path.join("d", "x.zip"), path.join("d", "x (2).zip"), path.join("d", "y.tar.gz")]);
  const exists = (p) => taken.has(p);
  assert.equal(s.uniquePath(path.join("d", "x.zip"), exists), path.join("d", "x (3).zip"));
  assert.equal(s.uniquePath(path.join("d", "new.zip"), exists), path.join("d", "new.zip"));
  assert.equal(s.uniquePath(path.join("d", "y.tar.gz"), exists, { ext: ".tar.gz" }), path.join("d", "y (2).tar.gz"));
});

test("safeFileName strips reserved characters", () => {
  assert.equal(s.safeFileName('a<b>:c"d/e\\f|g?h*i'), "a_b__c_d_e_f_g_h_i");
  assert.equal(s.safeFileName("trailing. "), "trailing");
  assert.equal(s.safeFileName(""), "archive");
});

test("fmtBytes", () => {
  assert.equal(s.fmtBytes(0), "0 B");
  assert.equal(s.fmtBytes(1536), "1.5 KB");
  assert.equal(s.fmtBytes(5 * 1024 ** 3), "5.0 GB");
  assert.equal(s.fmtBytes(null), "-");
});
