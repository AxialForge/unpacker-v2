// Snapchat end-to-end: (A) a fake export through the real queue + engine;
// (B) a small slice of the REAL export (read-only source, temp copy, deleted after)
// to prove 7-Zip restores the timestamps the matching relies on. Prints counts only.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const ROOT = "C:\\Project Folder\\Unpacker V2";
const sz = require(path.join(ROOT, "src/main/engine/sevenzip"));
const { Runner } = require(path.join(ROOT, "src/main/jobs/runner"));
const { JobQueue } = require(path.join(ROOT, "src/main/jobs/queue"));
const sc = require(path.join(ROOT, "src/main/snapchat"));
const exif = require(path.join(ROOT, "src/main/exif"));

const exe = sz.locate({ appPath: ROOT });
const work = fs.mkdtempSync(path.join(os.tmpdir(), "unp-snap-e2e-"));
const bin = path.join(work, "_bin");
fs.mkdirSync(bin);
const settings = { overwrite: "rename", verify: true, tempDir: "", allowHighRatio: false, allowLinks: false };
const runner = new Runner({ sevenZip: new sz.SevenZip(exe), rar: null, settings: () => settings, trash: async (p) => fs.renameSync(p, path.join(bin, path.basename(p))) });
const q = new JobQueue((j, c) => runner.run(j, c), { concurrency: 1 });
const wait = (job) => new Promise((res) => { const h = (j) => { if (j.id === job.id && !["queued", "running"].includes(j.state)) { q.off("change", h); res(q.get(job.id)); } }; q.on("change", h); });
let fails = 0;
const ok = (c, m, x) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}${x ? `  -> ${x}` : ""}`); if (!c) fails += 1; };
const jpeg = (n) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1"), Buffer.from([0xff, 0xda, 0x00, 0x02]), Buffer.alloc(500, n), Buffer.from([0xff, 0xd9])]);

(async () => {
  // ── A: fake two-part export ──
  const dl = path.join(work, "dl");
  fs.mkdirSync(dl);
  const records = [];
  const mkPart = (n, items, withJson) => {
    const st = path.join(work, `st${n}`);
    for (const it of items) {
      const p = path.join(st, "memories", it.name);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, it.data);
      const d = new Date(it.t * 1000);
      fs.utimesSync(p, d, d);
    }
    if (withJson) {
      fs.mkdirSync(path.join(st, "json"), { recursive: true });
      fs.writeFileSync(path.join(st, "json", "memories_history.json"), JSON.stringify({ "Saved Media": records }));
      fs.writeFileSync(path.join(st, "json", "friends.json"), "{}");
      fs.writeFileSync(path.join(st, "index.html"), "<html></html>");
    }
    const out = path.join(dl, n === 1 ? "mydata~1234567890123.zip" : `mydata~1234567890123-${n}.zip`);
    execFileSync(exe, ["a", "-tzip", out, "*"], { cwd: st, windowsHide: true });
    return out;
  };
  const T = (y, m, d, h, mi, s) => Date.UTC(y, m - 1, d, h, mi, s) / 1000;
  const iso = (t) => new Date(t * 1000).toISOString().replace("T", " ").replace(/\.\d{3}Z/, " UTC");
  const uuid = (n) => `${String(n).padStart(8, "0")}-0000-0000-0000-000000000000`;
  const a = [], b = [];
  for (let i = 0; i < 6; i += 1) {
    const t = T(2022 + (i % 3), 1 + i, 10 + i, 12, i, 30);
    const video = i % 3 === 2;
    records.push({ Date: iso(t), "Media Type": video ? "Video" : "Image", Location: `Latitude, Longitude: ${40 + i}.5, -${80 + i}.25`, "Download Link": "", "Media Download Url": "" });
    const day = new Date(t * 1000).toISOString().slice(0, 10);
    const item = { name: `${day}_${uuid(i)}-main.${video ? "mp4" : "jpg"}`, data: video ? Buffer.alloc(800, i) : jpeg(i), t };
    (i < 4 ? a : b).push(item);
    if (i === 0) a.push({ name: `${day}_${uuid(i)}-overlay.png`, data: "png", t });
  }
  records.push({ Date: iso(T(2025, 5, 5, 5, 5, 5)), "Media Type": "Image", Location: "Latitude, Longitude: 0.0, 0.0" }); // never delivered
  const p1 = mkPart(1, a, true);
  const p2 = mkPart(2, b, false);

  const groups = sc.groupExports([p1, p2], (p) => fs.statSync(p).size);
  ok(groups.length === 1 && groups[0].parts.length === 2 && groups[0].missing.length === 0, "two parts grouped into one export");
  const dest = path.join(work, "Snapchat-export");
  let j = await wait(q.add({ kind: "snapchat", label: "s", inputs: [p1, p2], options: { dest, verifyFirst: true, trashParts: true, organize: {} } }));
  ok(j.state === "done", "snapchat job completes", j.error || j.output);
  const L = j.output;
  const all = [];
  (function w(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? w(path.join(d, e.name)) : all.push(path.relative(L, path.join(d, e.name)).replace(/\\/g, "/")); })(L);
  console.log("      library:", all.join(", "));
  const rep = fs.readFileSync(path.join(L, "Snapchat library report.txt"), "utf8");
  ok(/Memories: 6 files \(4 photos, 2 videos\)/.test(rep) && /matched to Snapchat's list: 6; not matched: 0/.test(rep), "all six files matched after a real zip round trip (timestamps survived extraction)", rep.split("\r\n")[5]);
  ok(/EXIF positions written: 4/.test(rep) && /listed by Snapchat but not in this export: 1/.test(rep), "positions written into the 4 photos; 1 missing memory reported");
  ok(all.includes("Memories/2022/01/2022-01-10_120030.jpg") && all.includes("Memories/2022/01/2022-01-10_120030_overlay.png"), "photo and its overlay land together under the taken time");
  const g = exif.getGps(fs.readFileSync(path.join(L, "Memories/2022/01/2022-01-10_120030.jpg")));
  ok(g && Math.abs(g.lat - 40.5) < 1e-6 && Math.abs(g.lon + 80.25) < 1e-6, "position readable from the photo", JSON.stringify(g));
  ok(all.includes("Account data/json/friends.json") && all.includes("Memories/Missing memories.csv") && all.includes("Memories/Memories index.csv"), "account data kept; index and missing list written");
  ok(fs.readdirSync(bin).length === 2 && !fs.existsSync(p1), "parts binned after success");
  ok(j.warnings.some((w) => /1 memories are listed/.test(w)), "job warns about the missing memory");

  // already-extracted folder path
  const st3 = path.join(work, "already");
  fs.mkdirSync(path.join(st3, "memories"), { recursive: true });
  fs.mkdirSync(path.join(st3, "json"), { recursive: true });
  fs.writeFileSync(path.join(st3, "json", "memories_history.json"), JSON.stringify({ "Saved Media": [] }));
  fs.writeFileSync(path.join(st3, "memories", `2020-06-06_${uuid(50)}-main.jpg`), jpeg(9));
  j = await wait(q.add({ kind: "snapchat", label: "f", inputs: [st3], options: { extracted: true, organize: { yearMonth: false, rename: false, overlays: "folder" } } }));
  ok(j.state === "done" && fs.existsSync(path.join(j.output, "Memories", `2020-06-06_${uuid(50)}-main.jpg`)), "extracted-folder mode with flat layout and original names", j.error);

  // ── B: slice of the real export ──
  const real = "D:\\Snapchat\\mydata~1790635398407.zip";
  if (fs.existsSync(real)) {
    const slice = path.join(work, "real");
    execFileSync(exe, ["x", real, `-o${slice}`, "json\\memories_history.json", "memories\\2021-*", "-y"], { windowsHide: true, stdio: "ignore" });
    const n = fs.readdirSync(path.join(slice, "memories")).filter((f) => /-main\./.test(f)).length;
    const r = await sc.organize(slice, {}, { stage() {}, progress() {}, warn() {}, signal: new AbortController().signal });
    ok(n > 0 && r.summary.media === n && r.summary.matched === n, `real export slice: every extracted file matched its record`, `${r.summary.matched} of ${n} matched, ${r.summary.gpsWritten} positions written, ${r.summary.overlays} overlays paired`);
  } else console.log("SKIP  real export not present");

  console.log(`\n${fails ? `${fails} FAILURES` : "ALL PASSED"}`);
  fs.rmSync(work, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); fs.rmSync(work, { recursive: true, force: true }); process.exit(2); });
