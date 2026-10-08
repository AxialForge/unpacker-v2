// End-to-end: a fake 3-part Google Takeout export through the takeout job.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

const ROOT = "C:\\Project Folder\\Unpacker V2";
const sz = require(path.join(ROOT, "src/main/engine/sevenzip"));
const { Runner } = require(path.join(ROOT, "src/main/jobs/runner"));
const { JobQueue } = require(path.join(ROOT, "src/main/jobs/queue"));
const tk = require(path.join(ROOT, "src/main/takeout"));

const exe = sz.locate({ appPath: ROOT });
const work = fs.mkdtempSync(path.join(os.tmpdir(), "unp-tk-e2e-"));
const bin = path.join(work, "_bin");
fs.mkdirSync(bin);
const settings = { extractMode: "smart", overwrite: "rename", verify: true, tempDir: "", allowHighRatio: false };
const runner = new Runner({ sevenZip: new sz.SevenZip(exe), rar: null, settings: () => settings, trash: async (p) => fs.renameSync(p, path.join(bin, path.basename(p))) });
const q = new JobQueue((j, c) => runner.run(j, c), { concurrency: 1 });
const wait = (job) => new Promise((res) => { const check = (j) => { if (j.id === job.id && !["queued", "running"].includes(j.state)) { q.off("change", check); res(q.get(job.id)); } }; q.on("change", check); });
let fails = 0;
const ok = (c, m, x) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}${x ? `  -> ${x}` : ""}`); if (!c) fails += 1; };

// Build three parts that share Takeout/ and repeat metadata.json + archive_browser.html
const stamp = "20260912T140102Z";
const mk = (n, files) => {
  const stage = path.join(work, `stage${n}`, "Takeout");
  for (const [rel, body] of files) { fs.mkdirSync(path.dirname(path.join(stage, rel)), { recursive: true }); fs.writeFileSync(path.join(stage, rel), body); }
  const out = path.join(work, "dl", `takeout-${stamp}-${String(n).padStart(3, "0")}.zip`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  execFileSync(exe, ["a", "-tzip", out, "Takeout"], { cwd: path.join(work, `stage${n}`), windowsHide: true });
  return out;
};
const p1 = mk(1, [["archive_browser.html", "browser"], ["Google Photos/Trip/IMG_1.jpg", "one"], ["Google Photos/Trip/IMG_1.jpg.json", "{}"], ["Google Photos/Trip/metadata.json", "{v1}"]]);
const p2 = mk(2, [["archive_browser.html", "browser"], ["Google Photos/Trip/IMG_2.jpg", "two"], ["Google Photos/Trip/metadata.json", "{v1}"], ["Drive/doc.txt", "doc"]]);
const p3 = mk(3, [["archive_browser.html", "browser"], ["Mail/All mail.mbox", "mbox".repeat(100)]]);

(async () => {
  const groups = tk.groupTakeout([p1, p2, p3], (p) => fs.statSync(p).size);
  ok(groups.length === 1 && groups[0].parts.length === 3 && groups[0].missing.length === 0, "grouping of the fake export");

  // 1. merge with skip policy, flatten, tidy json
  const dest = path.join(work, "merged");
  let j = await wait(q.add({ kind: "takeout", label: "tk", inputs: [p1, p2, p3], options: { dest, overwrite: "skip", verifyFirst: true, flatten: true, tidyJson: true, resume: true } }));
  ok(j.state === "done", "takeout job completes", j.error);
  const has = (rel) => fs.existsSync(path.join(dest, rel));
  ok(has("Google Photos/Trip/IMG_1.jpg") && has("Google Photos/Trip/IMG_2.jpg") && has("Drive/doc.txt") && has("Mail/All mail.mbox"), "all parts merged into one tree, wrapper removed");
  ok(!has("Takeout"), "Takeout/ wrapper gone");
  ok(has("Google Photos/Trip/_json/IMG_1.jpg.json") && has("Google Photos/Trip/_json/metadata.json") && !has("Google Photos/Trip/metadata.json"), "sidecars tidied");
  ok(!fs.readdirSync(dest).some((n) => /\(2\)/.test(n)) && !fs.readdirSync(path.join(dest, "Google Photos", "Trip")).some((n) => /\(2\)/.test(n)), "no duplicate (2) files from repeated entries");
  ok(has("Takeout-import-report.txt") && !has(tk.STATE_FILE), "report written, state file cleared");

  // 2. truncated part is caught by verify-first before anything is written
  const dest2 = path.join(work, "merged2");
  const badDir = path.join(work, "dl2");
  fs.mkdirSync(badDir);
  const b1 = path.join(badDir, path.basename(p1));
  const b2 = path.join(badDir, path.basename(p2));
  fs.copyFileSync(p1, b1);
  fs.writeFileSync(b2, fs.readFileSync(p2).subarray(0, 100));
  j = await wait(q.add({ kind: "takeout", label: "bad", inputs: [b1, b2], options: { dest: dest2, overwrite: "skip", verifyFirst: true } }));
  ok(j.state === "failed" && /002\.zip failed its integrity check/.test(j.error), "damaged part reported by name before extraction", j.error);
  ok(!fs.existsSync(path.join(dest2, "Takeout")), "nothing extracted when a part is damaged");

  // 3. resume: part 1 done, part 2 re-downloaded, then a second run only does part 2
  fs.copyFileSync(p2, b2);
  j = await wait(q.add({ kind: "takeout", label: "r1", inputs: [b1], options: { dest: dest2, overwrite: "skip", verifyFirst: false } }));
  ok(j.state === "done", "first part alone", j.error);
  // simulate an interrupted run: keep state, mark part 1 done (clearState ran because the job finished; recreate)
  const st = fs.statSync(b1);
  tk.writeState(dest2, { done: { [path.basename(b1)]: { size: st.size, mtimeMs: st.mtimeMs } } });
  j = await wait(q.add({ kind: "takeout", label: "r2", inputs: [b1, b2], options: { dest: dest2, overwrite: "skip", verifyFirst: false, resume: true, trashParts: true } }));
  const report = fs.readFileSync(path.join(dest2, "Takeout-import-report.txt"), "utf8");
  ok(j.state === "done" && /skip {2}takeout-.*-001\.zip/.test(report) && /done {2}takeout-.*-002\.zip/.test(report), "resume skips the finished part", report.split("\n").slice(3).join(" | "));
  ok(fs.existsSync(path.join(bin, path.basename(b1))) && fs.existsSync(path.join(bin, path.basename(b2))) && !fs.existsSync(b1), "parts moved to bin after success");
  ok(fs.existsSync(path.join(dest2, "Takeout", "Drive", "doc.txt")), "part 2 content present, wrapper kept (flatten off)");

  console.log(`\n${fails ? `${fails} FAILURES` : "ALL PASSED"}  (${work})`);
  if (!fails) fs.rmSync(work, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
