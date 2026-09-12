const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseCli } = require("../src/main/cli");
const rar = require("../src/main/engine/rar");
const shellInt = require("../src/main/shell-integration");
const { volumeSiblings } = require("../src/main/jobs/runner");

test("parseCli groups paths under their flag", () => {
  const r = parseCli(["--compress", "C:\\a", "C:\\b c", "--extract-here", "C:\\x.zip", "--dev"]);
  assert.deepEqual(r, [
    { flag: "--compress", paths: ["C:\\a", "C:\\b c"] },
    { flag: "--extract-here", paths: ["C:\\x.zip"] },
  ]);
  assert.deepEqual(parseCli(["--dev"]), []);
  assert.deepEqual(parseCli([]), []);
});

test("rar addArgs: header encryption, split, list file", () => {
  const a = rar.addArgs("o.rar", "l.txt", { level: 5, password: "pw", split: "700m" });
  assert.equal(a[0], "a");
  assert.ok(a.includes("-ep1") && a.includes("-r") && a.includes("-m5") && a.includes("-hppw") && a.includes("-v700m") && a.includes("-scul"));
  assert.equal(a.at(-1), "@l.txt");
  assert.equal(rar.classify(0).kind, "ok");
  assert.equal(rar.classify(255).kind, "cancelled");
  assert.equal(rar.classify(1).kind, "warning");
  assert.equal(rar.classify(6, "ERROR: Cannot create o.rar").message, "ERROR: Cannot create o.rar");
});

test("rar list file is UTF-16LE with BOM", () => {
  const f = path.join(os.tmpdir(), `unp-rar-list-${process.pid}.txt`);
  rar.writeListFile(f, ["C:\\ä\\ü.txt"]);
  const buf = fs.readFileSync(f);
  fs.rmSync(f);
  assert.deepEqual([...buf.subarray(0, 2)], [0xff, 0xfe]);
  assert.equal(buf.subarray(2).toString("utf16le"), "C:\\ä\\ü.txt\r\n");
});

test("shell-integration plan covers files, folders and archive types", () => {
  const ops = shellInt.plan("C:\\App\\Unpacker.exe");
  assert.ok(ops.some((o) => o.key.endsWith("\\*\\shell\\UnpackerV2.Add") && o.flag === "--compress"));
  assert.ok(ops.some((o) => o.key.endsWith("\\Directory\\shell\\UnpackerV2.Add")));
  assert.ok(ops.some((o) => o.key.includes("SystemFileAssociations\\.zip\\shell\\UnpackerV2.ExtractHere")));
  assert.ok(ops.some((o) => o.key.includes("SystemFileAssociations\\.rar\\shell\\UnpackerV2.Convert")));
  assert.ok(ops.some((o) => o.key.includes("SystemFileAssociations\\.gz\\")), "compound suffixes reduce to their last ext");
  assert.ok(!shellInt.archiveExtensions().includes(".msi"), "never hijack installers");
  assert.ok(ops.every((o) => o.exe === "C:\\App\\Unpacker.exe"));
});

test("volumeSiblings gathers every part of a split set", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unp-vol-"));
  try {
    for (const n of ["big.7z.001", "big.7z.002", "big.7z.003", "other.7z.001", "set.part1.rar", "set.part2.rar", "old.rar", "old.r00", "old.r01", "wz.zip", "wz.z01", "solo.zip"]) {
      fs.writeFileSync(path.join(dir, n), "x");
    }
    const names = (p) => volumeSiblings(path.join(dir, p)).map((x) => path.basename(x)).sort();
    assert.deepEqual(names("big.7z.001"), ["big.7z.001", "big.7z.002", "big.7z.003"]);
    assert.deepEqual(names("set.part1.rar"), ["set.part1.rar", "set.part2.rar"]);
    assert.deepEqual(names("old.rar"), ["old.r00", "old.r01", "old.rar"]);
    assert.deepEqual(names("wz.zip"), ["wz.z01", "wz.zip"]);
    assert.deepEqual(names("solo.zip"), ["solo.zip"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
