// Mass extract end-to-end: mixed folder (zip + 7z + tar.gz, one nested, one corrupt), three modes, nested, cleanup.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

const ROOT = "C:\\Project Folder\\Unpacker V2";
const sz = require(path.join(ROOT, "src/main/engine/sevenzip"));
const { Runner } = require(path.join(ROOT, "src/main/jobs/runner"));
const { JobQueue } = require(path.join(ROOT, "src/main/jobs/queue"));
const { GroupRegistry } = require(path.join(ROOT, "src/main/groups"));
const scan = require(path.join(ROOT, "src/main/scan"));

const exe = sz.locate({ appPath: ROOT });
const work = fs.mkdtempSync(path.join(os.tmpdir(), "unp-me-"));
const bin = path.join(work, "_bin");
fs.mkdirSync(bin);
const settings = { extractMode: "smart", overwrite: "rename", verify: true, tempDir: "", allowHighRatio: false, allowLinks: false };
const trash = async (p) => fs.renameSync(p, path.join(bin, `${Date.now()}-${path.basename(p)}`));
const q = new JobQueue((j, c) => runner.run(j, c), { concurrency: 3 });
const runner = new Runner({ sevenZip: new sz.SevenZip(exe), rar: null, settings: () => settings, trash, spawn: (spec) => { const j = q.add(spec); if (spec.groupId) groups.attach(spec.groupId, j.id); return j; } });
const groups = new GroupRegistry({ queue: q, trash });
const untilFinished = (id) => new Promise((res) => { const h = (g) => { if (g.id === id && g.finished) { groups.off("change", h); setTimeout(() => res(groups.summary(id)), 50); } }; groups.on("change", h); });
let fails = 0;
const ok = (c, m, x) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}${x ? `  -> ${x}` : ""}`); if (!c) fails += 1; };

// fixture builder: a folder of mixed archives
function makeFolder(name) {
  const d = path.join(work, name);
  const stage = path.join(work, `${name}-stage`);
  const mk = (rel, body) => { fs.mkdirSync(path.dirname(path.join(stage, rel)), { recursive: true }); fs.writeFileSync(path.join(stage, rel), body); };
  fs.mkdirSync(d, { recursive: true });
  mk("alpha/a.txt", "alpha");
  mk("beta/b.txt", "beta");
  mk("gamma/g.txt", "gamma");
  mk("shared.txt", "from-alpha");
  execFileSync(exe, ["a", "-tzip", path.join(d, "alpha.zip"), "alpha", "shared.txt"], { cwd: stage, windowsHide: true });
  execFileSync(exe, ["a", "-t7z", path.join(d, "beta.7z"), "beta"], { cwd: stage, windowsHide: true });
  execFileSync(exe, ["a", "-ttar", path.join(stage, "gamma.tar"), "gamma"], { cwd: stage, windowsHide: true });
  execFileSync(exe, ["a", "-tgzip", path.join(d, "gamma.tar.gz"), path.join(stage, "gamma.tar")], { cwd: stage, windowsHide: true });
  // nested: inner.zip inside outer.zip
  execFileSync(exe, ["a", "-tzip", path.join(stage, "inner.zip"), "beta"], { cwd: stage, windowsHide: true });
  fs.mkdirSync(path.join(stage, "outerdir"));
  fs.copyFileSync(path.join(stage, "inner.zip"), path.join(stage, "outerdir", "inner.zip"));
  execFileSync(exe, ["a", "-tzip", path.join(d, "outer.zip"), "outerdir"], { cwd: stage, windowsHide: true });
  fs.rmSync(stage, { recursive: true, force: true });
  return d;
}

(async () => {
  // 1. own-folder mode, nested keep, trash sources
  const d1 = makeFolder("f1");
  const r1 = await scan.collectArchives([d1]);
  ok(r1.items.length === 4 && r1.byType.zip === 2 && r1.byType["tar.gz"] === 1, "scan finds 4 archives with a type breakdown", JSON.stringify(r1.byType));
  let g = groups.start(r1.items.map((i) => i.path), { destMode: "own", nested: "keep", trashSources: true, sequential: true });
  let s = await untilFinished(g.groupId);
  ok(s.allOk && s.total === 5, "own mode: 4 archives + 1 nested all succeed", JSON.stringify(s));
  const has = (rel) => fs.existsSync(path.join(d1, rel));
  ok(has("alpha/alpha/a.txt") && has("alpha/shared.txt") && has("beta/beta/b.txt") && has("gamma/gamma/g.txt"), "each archive into its own folder next to it", fs.readdirSync(d1).join(", "));
  ok(has("outer/outerdir/inner.zip") && has("outer/outerdir/beta/b.txt"), "nested inner.zip extracted (kept; smart mode skips the extra wrapper)", fs.existsSync(path.join(d1, "outer", "outerdir")) ? fs.readdirSync(path.join(d1, "outer", "outerdir")).join(", ") : "-");
  ok(!has("alpha.zip") && !has("beta.7z") && !has("gamma.tar.gz") && !has("outer.zip") && fs.readdirSync(bin).length === 4, "sources binned after all succeeded", fs.readdirSync(bin).join(", "));
  ok(has("Mass-extract-report.txt") && /5 of 5 succeeded/.test(fs.readFileSync(path.join(d1, "Mass-extract-report.txt"), "utf8")), "report written");

  // 2. merge mode with skip policy, nested remove; a corrupt archive keeps sources
  const d2 = makeFolder("f2");
  fs.writeFileSync(path.join(d2, "broken.7z"), fs.readFileSync(path.join(d2, "beta.7z")).subarray(0, 60));
  const r2 = await scan.collectArchives([d2]);
  const merge = path.join(work, "merged");
  fs.rmSync(bin, { recursive: true, force: true });
  fs.mkdirSync(bin);
  g = groups.start(r2.items.map((i) => i.path), { destMode: "merge", mergeDir: merge, overwrite: "skip", nested: "remove", trashSources: true, sequential: true });
  s = await untilFinished(g.groupId);
  ok(s.finished && !s.allOk && s.failed === 1 && s.done === 5, "merge mode: one corrupt archive fails, the rest succeed", JSON.stringify(s));
  const hm = (rel) => fs.existsSync(path.join(merge, rel));
  ok(hm("alpha/a.txt") && hm("shared.txt") && hm("beta/b.txt") && hm("gamma/g.txt") && hm("outerdir/beta/b.txt"), "everything merged into one folder incl. nested contents", fs.readdirSync(merge).join(", "));
  ok(!hm("outerdir/inner.zip"), "nested archive removed after its extraction (nested=remove)");
  ok(fs.existsSync(path.join(d2, "alpha.zip")) && fs.readdirSync(bin).filter((n) => /alpha|beta\.7z|gamma|outer/.test(n)).length === 0, "sources kept because one archive failed", fs.readdirSync(bin).join(", "));
  ok(/sources kept/.test(fs.readFileSync(path.join(merge, "Mass-extract-report.txt"), "utf8")), "report explains why sources were kept");

  // 3. here mode, not sequential, no nested handling
  const d3 = makeFolder("f3");
  const r3 = await scan.collectArchives([d3]);
  g = groups.start(r3.items.map((i) => i.path), { destMode: "here", nested: "leave", sequential: false });
  s = await untilFinished(g.groupId);
  ok(s.allOk && s.total === 4, "here mode: 4 archives, nothing nested queued", JSON.stringify(s));
  ok(fs.existsSync(path.join(d3, "alpha", "a.txt")) && fs.existsSync(path.join(d3, "outerdir", "inner.zip")) && fs.existsSync(path.join(d3, "alpha.zip")), "contents next to archives, sources kept, nested left alone", fs.readdirSync(d3).join(", "));

  // 4. sequential order actually held: with concurrency 3 the group's jobs never overlapped
  const d4 = makeFolder("f4");
  const r4 = await scan.collectArchives([d4]);
  let overlap = false;
  q.on("change", (j) => { if (j.state === "running" && j.groupId === "seqcheck") { /* placeholder */ } });
  g = groups.start(r4.items.map((i) => i.path), { destMode: "own", sequential: true });
  const gid = g.groupId;
  const watch = () => { if (q.list().filter((j) => j.groupId === gid && j.state === "running").length > 1) overlap = true; };
  q.on("change", watch);
  s = await untilFinished(gid);
  q.off("change", watch);
  ok(!overlap && s.allOk, "sequential group never ran two archives at once");

  // 5. "archival" cleanup: sources move into "<parent name> - archival" inside the extracted folder
  const d5 = makeFolder("Photos 2019");
  const r5 = await scan.collectArchives([d5]);
  g = groups.start(r5.items.map((i) => i.path), { destMode: "own", nested: "leave", sourcesAfter: "archival", sequential: true });
  s = await untilFinished(g.groupId);
  const arch = path.join(d5, "Photos 2019 - archival");
  ok(s.allOk && s.archivalDir === arch && fs.existsSync(arch), "archival folder created next to the extracted folders", s.archivalDir);
  ok(["alpha.zip", "beta.7z", "gamma.tar.gz", "outer.zip"].every((n) => fs.existsSync(path.join(arch, n)) && !fs.existsSync(path.join(d5, n))), "all four sources moved into it", fs.readdirSync(arch).join(", "));
  ok(fs.existsSync(path.join(d5, "alpha", "alpha", "a.txt")), "extracted content untouched");
  ok(/moved 4 source file\(s\) into .*Photos 2019 - archival/.test(fs.readFileSync(path.join(d5, "Mass-extract-report.txt"), "utf8")), "report names the archival folder");
  // merge mode: archival folder lives inside the merge folder
  const d6 = makeFolder("Trip");
  const r6 = await scan.collectArchives([d6]);
  const merge6 = path.join(work, "merged6");
  g = groups.start(r6.items.map((i) => i.path), { destMode: "merge", mergeDir: merge6, nested: "leave", sourcesAfter: "archival", sequential: true });
  s = await untilFinished(g.groupId);
  ok(s.allOk && fs.existsSync(path.join(merge6, "Trip - archival", "alpha.zip")) && !fs.existsSync(path.join(d6, "alpha.zip")), "merge mode puts the archival folder inside the merge folder", s.archivalDir);

  console.log(`\n${fails ? `${fails} FAILURES` : "ALL PASSED"}  (${work})`);
  if (!fails) fs.rmSync(work, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
