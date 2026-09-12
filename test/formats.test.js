const test = require("node:test");
const assert = require("node:assert/strict");
const { detectArchive, isArchive, availableTargets, TARGETS } = require("../src/main/engine/formats");

test("plain archives detect by extension", () => {
  assert.equal(detectArchive("C:\\x\\Photos.zip").type, "zip");
  assert.equal(detectArchive("a.7Z").type, "7z");
  assert.equal(detectArchive("a.rar").type, "rar");
  assert.equal(detectArchive("a.cab").type, "cab");
  assert.equal(detectArchive("a.iso").type, "iso");
  assert.equal(detectArchive("a.zip").baseName, "a");
  assert.equal(detectArchive("my.backup.tar").baseName, "my.backup");
});

test("compound tar formats win over the bare stream extension", () => {
  const d = detectArchive("site-2026.tar.gz");
  assert.equal(d.type, "gzip");
  assert.equal(d.inner, "tar");
  assert.equal(d.baseName, "site-2026");
  assert.equal(detectArchive("x.tgz").inner, "tar");
  assert.equal(detectArchive("x.tar.xz").type, "xz");
  assert.equal(detectArchive("x.tar.zst").type, "zstd");
  assert.equal(detectArchive("plain.gz").inner, undefined);
});

test("split sets open only from their first volume", () => {
  const first = detectArchive("big.7z.001");
  assert.equal(first.entryPoint, true);
  assert.equal(first.split, true);
  assert.equal(first.type, "7z");
  assert.equal(first.baseName, "big");
  assert.equal(detectArchive("big.7z.002").entryPoint, false);
  assert.equal(detectArchive("big.7z.017").entryPoint, false);
  assert.equal(detectArchive("set.part1.rar").entryPoint, true);
  assert.equal(detectArchive("set.part01.rar").baseName, "set");
  assert.equal(detectArchive("set.part2.rar").entryPoint, false);
  assert.equal(detectArchive("set.part10.rar").entryPoint, false);
  assert.equal(detectArchive("old.r00").entryPoint, false);
  assert.equal(detectArchive("wz.z01").entryPoint, false);
  assert.equal(detectArchive("wz.zip").entryPoint, true);
});

test("non-archives return null", () => {
  assert.equal(detectArchive("photo.jpg"), null);
  assert.equal(detectArchive("README"), null);
  assert.equal(detectArchive(""), null);
  assert.equal(isArchive("notes.txt"), false);
  assert.equal(isArchive("notes.zip"), true);
});

test("RAR is only a target when WinRAR is present", () => {
  assert.ok(!availableTargets({ rar: false }).some((t) => t.id === "rar"));
  assert.ok(availableTargets({ rar: true }).some((t) => t.id === "rar"));
  assert.equal(TARGETS.zip.encrypt, true);
  assert.equal(TARGETS.tar.encrypt, false);
  assert.equal(TARGETS["tar.gz"].inner, "tar");
});
