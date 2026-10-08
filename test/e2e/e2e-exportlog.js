// Export log end-to-end: mass extract (own + merge + archival) with the real engine, and a Snapchat run.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const ROOT = "C:\\Project Folder\\Unpacker V2";
const sz = require(path.join(ROOT, "src/main/engine/sevenzip"));
const { Runner } = require(path.join(ROOT, "src/main/jobs/runner"));
const { JobQueue } = require(path.join(ROOT, "src/main/jobs/queue"));
const { GroupRegistry } = require(path.join(ROOT, "src/main/groups"));
const exe = sz.locate({ appPath: ROOT });
const work = fs.mkdtempSync(path.join(os.tmpdir(), "unp-log-e2e-"));
const settings = { extractMode: "smart", overwrite: "rename", verify: true, tempDir: "", allowHighRatio: false, allowLinks: false };
const trash = async (p) => fs.rmSync(p, { force: true });
const q = new JobQueue((j, c) => runner.run(j, c), { concurrency: 2 });
const runner = new Runner({ sevenZip: new sz.SevenZip(exe), rar: null, settings: () => settings, trash, spawn: (s) => { const j = q.add(s); if (s.groupId) groups.attach(s.groupId, j.id); return j; } });
const groups = new GroupRegistry({ queue: q, trash });
const done = (id) => new Promise((res) => { const h = (g) => { if (g.id === id && g.finished) { groups.off("change", h); setTimeout(() => res(groups.summary(id)), 80); } }; groups.on("change", h); });
let fails = 0;
const ok = (c, m, x) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}${x ? `  -> ${x}` : ""}`); if (!c) fails += 1; };

function folder(name) {
  const d = path.join(work, name);
  const st = path.join(work, `${name}-st`);
  const mk = (rel, body) => { fs.mkdirSync(path.dirname(path.join(st, rel)), { recursive: true }); fs.writeFileSync(path.join(st, rel), body); };
  fs.mkdirSync(d, { recursive: true });
  mk("Trip/IMG_1.jpg", "jpg-bytes");
  mk("Trip/clip.mp4", "video-bytes-video-bytes");
  mk("Papers/plan.docx", "doc");
  mk("Music/song.mp3", "mp3");
  execFileSync(exe, ["a", "-tzip", path.join(d, "holiday.zip"), "Trip"], { cwd: st, stdio: "ignore" });
  execFileSync(exe, ["a", "-t7z", path.join(d, "office.7z"), "Papers"], { cwd: st, stdio: "ignore" });
  execFileSync(exe, ["a", "-tzip", path.join(d, "audio.zip"), "Music"], { cwd: st, stdio: "ignore" });
  fs.writeFileSync(path.join(d, "broken.7z"), "not an archive at all");
  fs.rmSync(st, { recursive: true, force: true });
  return d;
}

(async () => {
  // own-folder mode, sources to archival, one broken archive
  const d1 = folder("Old backups");
  let g = groups.start(["holiday.zip", "office.7z", "audio.zip", "broken.7z"].map((n) => path.join(d1, n)), { destMode: "own", sourcesAfter: "archival", exportLog: true });
  let s = await done(g.groupId);
  ok(s.exportLog && fs.existsSync(s.exportLog), "log written and reported on the batch summary", s.exportLog);
  const txt = fs.readFileSync(path.join(d1, "What's in here.txt"), "utf8");
  console.log(txt.split("\r\n").map((l) => `      | ${l}`).join("\n"));
  ok(/holds 4 files/.test(txt) && /1 photos, 1 videos, 1 audio, 1 documents/.test(txt), "totals by kind");
  ok(/3 of 4 archives were extracted/.test(txt) && /broken\.7z: failed/.test(txt), "sources and the failure listed");
  ok(/left where they were/.test(txt), "note says sources stayed (a failure blocks the archival move)");
  ok(fs.existsSync(path.join(d1, "holiday", "Trip", "IMG_1.jpg")) && fs.existsSync(path.join(d1, "holiday.zip")), "structure untouched, archives still there");
  const csv = fs.readFileSync(path.join(d1, "Contents.csv"), "utf8");
  ok(/holiday\\Trip,IMG_1\.jpg,9,[^,]+,Photos,holiday\.zip/.test(csv) && !/holiday\.zip,\d/.test(csv.split("\r\n").slice(1).map((l) => l.split(",")[1]).join("\n")), "contents list names the source archive and omits the archives themselves");

  // merge mode, everything succeeds, archival
  const d2 = folder("Second");
  fs.rmSync(path.join(d2, "broken.7z"));
  const merge = path.join(work, "Merged");
  g = groups.start(["holiday.zip", "office.7z", "audio.zip"].map((n) => path.join(d2, n)), { destMode: "merge", mergeDir: merge, sourcesAfter: "archival", exportLog: true });
  s = await done(g.groupId);
  const t2 = fs.readFileSync(path.join(merge, "What's in here.txt"), "utf8");
  ok(s.allOk && /holds 4 files/.test(t2) && /moved to "Second - archival"/.test(t2), "merge mode: log in the merge folder, archival folder noted and not counted", t2.split("\r\n")[3]);
  ok(/Trip,IMG_1\.jpg,9,[^,]+,Photos,several archives/.test(fs.readFileSync(path.join(merge, "Contents.csv"), "utf8")), "merged files are attributed to several archives");

  // off by default
  const d3 = folder("Third");
  g = groups.start([path.join(d3, "holiday.zip")], { destMode: "own" });
  s = await done(g.groupId);
  ok(!s.exportLog && !fs.existsSync(path.join(d3, "What's in here.txt")), "no log unless asked");

  console.log(`\n${fails ? `${fails} FAILURES` : "ALL PASSED"}`);
  fs.rmSync(work, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
