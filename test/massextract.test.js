const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { JobQueue } = require("../src/main/jobs/queue");
const scan = require("../src/main/scan");
const { parseCli } = require("../src/main/cli");
const shellInt = require("../src/main/shell-integration");

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test("sequential groups run one at a time even with concurrency 3", async () => {
  let active = 0;
  let peak = 0;
  const q = new JobQueue(
    async () => {
      active += 1;
      peak = Math.max(peak, active);
      await tick(15);
      active -= 1;
      return {};
    },
    { concurrency: 3 }
  );
  for (let i = 0; i < 4; i += 1) q.add({ kind: "test", label: `g${i}`, inputs: [], groupId: "G", sequential: true });
  q.add({ kind: "test", label: "loose", inputs: [] }); // not in the group: may run alongside
  assert.equal(q.list().filter((j) => j.state === "running" && j.groupId === "G").length, 1);
  assert.equal(q.running, 2, "one from the group plus the loose job");
  while (q.list().some((j) => j.state !== "done")) await tick();
  assert.ok(peak <= 2);
  assert.equal(q.group("G").length, 4);
});

test("non-sequential groups use the global concurrency", async () => {
  const q = new JobQueue(async () => tick(10), { concurrency: 3 });
  for (let i = 0; i < 3; i += 1) q.add({ kind: "test", label: `p${i}`, inputs: [], groupId: "P", sequential: false });
  assert.equal(q.running, 3);
  while (q.list().some((j) => j.state !== "done")) await tick();
});

test("scanFolder and collectArchives find entry points and summarise", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "unp-scan-"));
  try {
    fs.mkdirSync(path.join(d, "sub", "deep"), { recursive: true });
    for (const n of ["a.zip", "b.rar", "sub/c.7z", "sub/deep/d.tar.gz", "sub/split.7z.001", "sub/split.7z.002", "notes.txt"]) fs.writeFileSync(path.join(d, n), "x".repeat(10));
    const found = await scan.scanFolder(d);
    assert.deepEqual(found.map((p) => path.relative(d, p)).sort(), ["a.zip", "b.rar", path.join("sub", "c.7z"), path.join("sub", "deep", "d.tar.gz"), path.join("sub", "split.7z.001")]);
    const shallow = await scan.scanFolder(d, { maxDepth: 0 });
    assert.deepEqual(shallow.map((p) => path.basename(p)).sort(), ["a.zip", "b.rar"]);
    const r = await scan.collectArchives([d, path.join(d, "a.zip"), path.join(d, "notes.txt")]);
    assert.equal(r.items.length, 5, "folder scan + explicit file deduped, non-archive ignored");
    assert.equal(r.totalBytes, 50);
    assert.equal(r.byType.zip, 1);
    assert.equal(r.byType["tar.gz"], 1);
    assert.equal(r.byType["7z"], 2);
    const skipped = await scan.scanFolder(d, { skip: new Set([path.join(d, "a.zip").toLowerCase()]) });
    assert.ok(!skipped.some((p) => p.endsWith("a.zip")));
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test("--extract-all is a CLI flag and a Directory verb", () => {
  assert.deepEqual(parseCli(["--extract-all", "C:\\dl"]), [{ flag: "--extract-all", paths: ["C:\\dl"] }]);
  const ops = shellInt.plan("X.exe");
  assert.ok(ops.some((o) => o.key.endsWith("\\Directory\\shell\\UnpackerV2.ExtractAll") && o.flag === "--extract-all"));
});
