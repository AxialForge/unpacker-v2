// Phase 1 end-to-end: partial-output cleanup, link refusal, inside-only manifest + verify from archive.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const ROOT = "C:\\Project Folder\\Unpacker V2";
const sz = require(path.join(ROOT, "src/main/engine/sevenzip"));
const { Runner } = require(path.join(ROOT, "src/main/jobs/runner"));
const { JobQueue } = require(path.join(ROOT, "src/main/jobs/queue"));
const chunker = require(path.join(ROOT, "src/main/chunker"));
chunker.CHUNK_SIZES.push({ id: "test3m", label: "3 MB (test)", bytes: 3 * 1024 ** 2 });

const exe = sz.locate({ appPath: ROOT });
const engine = new sz.SevenZip(exe);
const work = fs.mkdtempSync(path.join(os.tmpdir(), "unp-p1-"));
const settings = { format: "7z", level: 5, outputMode: "folder", outputDir: path.join(work, "out"), extractMode: "smart", overwrite: "rename", verify: true, tempDir: "", allowHighRatio: false, allowLinks: false, manifestPlacement: "beside" };
const runner = new Runner({ sevenZip: engine, rar: null, settings: () => settings, trash: async () => {} });
const q = new JobQueue((j, c) => runner.run(j, c), { concurrency: 1 });
const wait = (job) => new Promise((res) => { const check = (j) => { if (j.id === job.id && !["queued", "running"].includes(j.state)) { q.off("change", check); res(q.get(job.id)); } }; q.on("change", check); });
const run = (spec) => wait(q.add(spec));
let fails = 0;
const ok = (c, m, x) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}${x ? `  -> ${x}` : ""}`); if (!c) fails += 1; };

const src = path.join(work, "Set");
const mk = (rel, buf) => { fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true }); fs.writeFileSync(path.join(src, rel), buf); };
for (let i = 0; i < 8; i += 1) mk(`part${i}/f.bin`, crypto.randomBytes(2_000_000));
for (let i = 0; i < 6; i += 1) mk(`slow/s${i}.bin`, crypto.randomBytes(12_000_000)); // enough work to cancel mid-write
const cancelWhenCompressing = (job) => new Promise((res) => {
  const watch = (j) => { if (j.id === job.id && /^Compressing/.test(j.stage) && j.progress > 0) { q.off("change", watch); q.cancel(job.id); res(); } };
  q.on("change", watch);
});
mk("notes.txt", "n".repeat(100));

(async () => {
  // 1. cancel a chunked pack mid-way: verified chunks stay, partial ones and the manifest do not
  const outDir = settings.outputDir;
  const cj = q.add({ kind: "pack", label: "cancel", inputs: [src], options: { format: "7z", level: 9, chunkSize: "test3m", chunkMode: "chunks", manifest: true, hash: false } });
  await new Promise((res) => {
    const watch = (j) => { if (j.id === cj.id && /Packing 0[3-9]of|Packing 0[3-9]/.test(j.stage)) { q.off("change", watch); q.cancel(cj.id); res(); } };
    q.on("change", watch);
    setTimeout(() => { q.off("change", watch); q.cancel(cj.id); res(); }, 15000);
  });
  let j = await wait(cj);
  const left = fs.existsSync(outDir) ? fs.readdirSync(outDir) : [];
  ok(j.state === "cancelled", "pack cancelled", j.state);
  ok(!left.some((n) => /manifest\.txt$/.test(n)), "no manifest left after cancel", left.join(", "));
  ok(j.warnings.some((w) => /Removed \d+ partial output/.test(w)), "partial outputs reported removed", j.warnings.join(" | "));
  for (const n of left) {
    let good = true;
    try { await engine.test(path.join(outDir, n)); } catch { good = false; }
    ok(good, `leftover ${n} is a complete, verified chunk`);
  }

  // 2. cancel a plain compress with verify OFF -> everything produced removed
  settings.verify = false;
  const out2 = path.join(work, "out2");
  settings.outputDir = out2;
  const cj2 = q.add({ kind: "compress", label: "c2", inputs: [src], options: { format: "7z", level: 9 } });
  await cancelWhenCompressing(cj2);
  j = await wait(cj2);
  ok(j.state === "cancelled" && (!fs.existsSync(out2) || fs.readdirSync(out2).length === 0), "cancelled compress leaves nothing behind", fs.existsSync(out2) ? fs.readdirSync(out2).join(", ") : "(no dir)");
  settings.verify = true;

  // 3. a pre-existing file with the same name is never touched
  const out3 = path.join(work, "out3");
  fs.mkdirSync(out3);
  fs.writeFileSync(path.join(out3, "Set.7z"), "PRE-EXISTING");
  settings.outputDir = out3;
  const cj3 = q.add({ kind: "compress", label: "c3", inputs: [src], options: { format: "7z", level: 9 } });
  await cancelWhenCompressing(cj3);
  j = await wait(cj3);
  ok(fs.readFileSync(path.join(out3, "Set.7z"), "utf8") === "PRE-EXISTING" && !fs.existsSync(path.join(out3, "Set (2).7z")), "pre-existing Set.7z untouched, our Set (2).7z removed", fs.readdirSync(out3).join(", "));

  // 4. archive with a symlink entry is refused, then allowed with the setting
  const linkDir = path.join(work, "linksrc");
  fs.mkdirSync(path.join(linkDir, "d"), { recursive: true });
  fs.writeFileSync(path.join(linkDir, "d", "real.txt"), "real");
  let haveLink = true;
  try { fs.symlinkSync(path.join(linkDir, "d"), path.join(linkDir, "escape"), "junction"); } catch { haveLink = false; }
  if (haveLink) {
    const linkTar = path.join(work, "links.tar");
    execFileSync(exe, ["a", "-ttar", "-snl", linkTar, "d", "escape"], { cwd: linkDir, windowsHide: true });
    const listing = await engine.list(linkTar);
    ok(listing.totals.links >= 1, "7-Zip listing exposes the link entry", listing.entries.map((e) => `${e.path}${e.link ? ` -> ${e.link}` : ""}`).join(", "));
    j = await run({ kind: "extract", label: "xl", inputs: [linkTar], options: { dest: path.join(work, "xl") } });
    ok(j.state === "failed" && j.errorKind === "unsafe" && /link entr/.test(j.error), "link archive refused by default", j.error);
    settings.allowLinks = true;
    j = await run({ kind: "extract", label: "xl2", inputs: [linkTar], options: { dest: path.join(work, "xl2") } });
    ok(j.state === "done", "allowed with the setting", j.error);
    settings.allowLinks = false;
  } else console.log("SKIP  could not create a junction here");

  // 5. inside-only manifest: no txt beside; verify from an archive works
  const out5 = path.join(work, "out5");
  settings.outputDir = out5;
  j = await run({ kind: "pack", label: "inside", inputs: [path.join(src, "part0"), path.join(src, "notes.txt")], options: { format: "zip", level: 0, chunkSize: "", manifest: true, hash: true, manifestPlacement: "inside", password: "pw" } });
  const names5 = fs.readdirSync(out5);
  ok(j.state === "done" && !names5.some((n) => /manifest\.txt$/.test(n)) && names5.length === 1, "inside-only placement writes no plain-text manifest", names5.join(", "));
  j = await run({ kind: "verify-manifest", label: "vfa", inputs: [path.join(out5, names5[0])], options: { password: "pw" } });
  ok(j.state === "done" && /verify\.txt$/.test(j.output) && fs.existsSync(j.output), "verify-manifest from an archive (encrypted) passes", j.error || j.output);
  ok(/Everything matches/.test(fs.readFileSync(j.output, "utf8")), "report says everything matches");

  // 6. cloud warning is attached when inputs sit under a OneDrive-looking root
  process.env.OneDrive = work;
  j = await run({ kind: "compress", label: "cloud", inputs: [path.join(src, "notes.txt")], options: { format: "zip", level: 1, outputMode: "folder", outputDir: path.join(work, "out6") } });
  ok(j.state === "done" && j.warnings.some((w) => /OneDrive/.test(w)), "OneDrive input produces a warning", j.warnings.join(" | "));
  delete process.env.OneDrive;

  console.log(`\n${fails ? `${fails} FAILURES` : "ALL PASSED"}  (${work})`);
  if (!fails) fs.rmSync(work, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
