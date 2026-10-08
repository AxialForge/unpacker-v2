// REAL combined run: both exports in D:\Snapchat through the snapchat job into a temp folder.
// Prints counts and folder names only; the output is deleted at the end. Sources are read-only.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const ROOT = "C:\\Project Folder\\Unpacker V2";
const sz = require(path.join(ROOT, "src/main/engine/sevenzip"));
const { Runner } = require(path.join(ROOT, "src/main/jobs/runner"));
const { JobQueue } = require(path.join(ROOT, "src/main/jobs/queue"));
const sc = require(path.join(ROOT, "src/main/snapchat"));

const src = "D:\\Snapchat";
const parts = fs.readdirSync(src).filter((n) => sc.isSnapchatPart(n)).map((n) => path.join(src, n));
const groups = sc.groupExports(parts, (p) => fs.statSync(p).size);
console.log("exports found:", groups.length, "| parts:", parts.length, "| bytes:", groups.reduce((a, g) => a + g.totalBytes, 0));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "unp-snap-real-"));
const settings = { overwrite: "rename", verify: true, tempDir: "", allowHighRatio: false, allowLinks: false };
const runner = new Runner({ sevenZip: new sz.SevenZip(sz.locate({ appPath: ROOT })), rar: null, settings: () => settings, trash: async () => {} });
const q = new JobQueue((j, c) => runner.run(j, c), { concurrency: 1 });
let lastStage = "";
q.on("change", (j) => { if (j.stage !== lastStage) { lastStage = j.stage; console.log("  stage:", j.stage); } });
const wait = (job) => new Promise((res) => { const h = (j) => { if (j.id === job.id && !["queued", "running"].includes(j.state)) { q.off("change", h); res(q.get(job.id)); } }; q.on("change", h); });

(async () => {
  const dest = path.join(work, "Snapchat-export");
  const job = q.add({ kind: "snapchat", label: "real", inputs: parts, options: { dest, verifyFirst: true, trashParts: false, organize: { exportLog: true } } });
  const j = await wait(job);
  console.log("state:", j.state, j.error || "");
  for (const w of j.warnings) console.log("  warning:", w.slice(0, 160));
  const lib = j.output;
  if (lib && fs.existsSync(lib)) {
    console.log("--- report");
    console.log(fs.readFileSync(path.join(lib, "Snapchat library report.txt"), "utf8").split("\r\n").filter((l) => !/^library:/.test(l)).join("\n"));
    const count = (d) => { let n = 0; (function w(x) { for (const e of fs.readdirSync(x, { withFileTypes: true })) e.isDirectory() ? w(path.join(x, e.name)) : n++; })(d); return n; };
    console.log("--- top folders (file counts)");
    for (const e of fs.readdirSync(lib, { withFileTypes: true })) console.log(`  ${e.name}${e.isDirectory() ? "/  " + count(path.join(lib, e.name)) : ""}`);
    const mem = path.join(lib, "Memories");
    const years = fs.existsSync(mem) ? fs.readdirSync(mem).filter((n) => /^\d{4}$/.test(n)) : [];
    console.log("Memories years:", years.join(", "));
    console.log("What's in here.txt first lines:");
    console.log(fs.readFileSync(path.join(lib, "What's in here.txt"), "utf8").split("\r\n").slice(0, 8).map((l) => "  | " + l).join("\n"));
    const left = fs.readdirSync(dest).filter((n) => n !== "Snapchat Library");
    console.log("left in the extracted folder after organising:", left.length ? left.join(", ") : "nothing");
  }
  fs.rmSync(work, { recursive: true, force: true });
  console.log("temp output deleted");
})().catch((e) => { console.error("CRASH", e); fs.rmSync(work, { recursive: true, force: true }); process.exit(2); });
