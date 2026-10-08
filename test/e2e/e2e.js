// End-to-end exercise of the runner against the real 7-Zip (and WinRAR if present).
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const zlib = require("node:zlib");

const ROOT = "C:\\Project Folder\\Unpacker V2";
const sz = require(path.join(ROOT, "src/main/engine/sevenzip"));
const rarE = require(path.join(ROOT, "src/main/engine/rar"));
const { Runner } = require(path.join(ROOT, "src/main/jobs/runner"));
const { JobQueue } = require(path.join(ROOT, "src/main/jobs/queue"));

const work = fs.mkdtempSync(path.join(os.tmpdir(), "unp-e2e-"));
const bin = path.join(work, "_bin");
fs.mkdirSync(bin);
const settings = { format: "7z", level: 5, outputMode: "beside", outputDir: "", extractMode: "smart", overwrite: "rename", verify: true, concurrency: 2, tempDir: "", allowHighRatio: false };

const engine = new sz.SevenZip(sz.locate({ appPath: ROOT }));
const rarExe = rarE.locate();
const runner = new Runner({ sevenZip: engine, rar: rarExe ? new rarE.Rar(rarExe) : null, settings: () => settings, trash: async (p) => fs.renameSync(p, path.join(bin, path.basename(p))) });
const q = new JobQueue((j, c) => runner.run(j, c), { concurrency: 2 });

const wait = (job) => new Promise((res) => {
  const check = (j) => { if (j.id === job.id && !["queued", "running"].includes(j.status || j.state)) { q.off("change", check); res(q.get(job.id)); } };
  q.on("change", check);
});
const run = (spec) => wait(q.add(spec));
let fails = 0;
const ok = (cond, msg, extra) => { console.log(`${cond ? "PASS" : "FAIL"}  ${msg}${extra ? `  -> ${extra}` : ""}`); if (!cond) fails += 1; };

// ── fixtures ──────────────────────────────────────────────────────
const src = path.join(work, "Projekt Ärger ✓");
fs.mkdirSync(path.join(src, "nested", "deep er"), { recursive: true });
fs.writeFileSync(path.join(src, "readme.txt"), "hello unpacker\n".repeat(1000));
fs.writeFileSync(path.join(src, "nested", "ünïcode 名前.md"), "# md\n".repeat(500));
fs.writeFileSync(path.join(src, "nested", "deep er", "random.bin"), crypto.randomBytes(3 * 1024 * 1024)); // incompressible, forces split
const deepName = "d".repeat(120);
fs.mkdirSync(path.join(src, deepName, deepName), { recursive: true });
fs.writeFileSync(path.join(src, deepName, deepName, "long-path.txt"), "long");
const sha = (p) => crypto.createHash("sha1").update(fs.readFileSync(p)).digest("hex");
const tree = (dir) => { const out = {}; (function w(d, rel) { for (const n of fs.readdirSync(d).sort()) { const p = path.join(d, n); const r = rel ? `${rel}/${n}` : n; if (fs.statSync(p).isDirectory()) w(p, r); else out[r] = sha(p); } })(dir, ""); return out; };
const SRC_TREE = tree(src);
const sameTree = (dir) => JSON.stringify(tree(dir)) === JSON.stringify(SRC_TREE);

(async () => {
  // 1. compress to 7z (default), verify on
  let j = await run({ kind: "compress", label: "7z", inputs: [src], options: { format: "7z", level: 5 } });
  ok(j.state === "done", "compress folder -> 7z", j.error || j.output);
  const out7z = j.output;

  // 2. compress to zip with password (AES)
  j = await run({ kind: "compress", label: "zip", inputs: [src], options: { format: "zip", level: 1, password: "pw 123" } });
  ok(j.state === "done", "compress -> AES zip with password", j.error || j.output);
  const outZip = j.output;

  // 3. tar.gz compound
  j = await run({ kind: "compress", label: "tgz", inputs: [src], options: { format: "tar.gz", level: 3 } });
  ok(j.state === "done" && /\.tar\.gz$/.test(j.output), "compress -> tar.gz (two-pass)", j.error || j.output);
  const outTgz = j.output;

  // 4. split zip: 1 MB volumes over ~3 MB random data
  j = await run({ kind: "compress", label: "split", inputs: [src], options: { format: "zip", level: 0, split: "1m" } });
  ok(j.state === "done" && /\.zip\.001$/.test(j.output) && fs.existsSync(j.output.replace(/001$/, "003")), "compress -> split zip volumes", j.error || j.output);
  const outSplit = j.output;

  // 5. RAR via WinRAR (if present)
  let outRar = null;
  if (rarExe) {
    j = await run({ kind: "compress", label: "rar", inputs: [src], options: { format: "rar", level: 3, password: "rarpw" } });
    ok(j.state === "done", "compress -> RAR via WinRAR (encrypted headers)", j.error || j.output);
    outRar = j.output;
  } else console.log("SKIP  WinRAR not installed");

  // 6. extract 7z (smart: archive has single root -> extracts beside)
  const ex = path.join(work, "extract");
  fs.mkdirSync(ex);
  j = await run({ kind: "extract", label: "x7z", inputs: [out7z], options: { dest: ex } });
  ok(j.state === "done" && sameTree(path.join(ex, path.basename(src))), "extract 7z, tree identical (unicode, long paths)", j.error || j.output);

  // 7. extract encrypted zip without password -> needs-password, then retry with it
  const ex2 = path.join(work, "extract2");
  j = await run({ kind: "extract", label: "xzip", inputs: [outZip], options: { dest: ex2 } });
  ok(j.state === "needs-password", "encrypted zip without password parks as needs-password", j.state + " " + j.error);
  j = await wait(q.retry(j.id, { password: "pw 123" }));
  ok(j.state === "done" && sameTree(path.join(ex2, path.basename(src))), "retry with password extracts", j.error);
  j = await run({ kind: "extract", label: "xzipbad", inputs: [outZip], options: { dest: path.join(work, "extract2b"), password: "wrong" } });
  ok(j.state === "needs-password", "wrong password -> needs-password again", j.state + " " + j.error);

  // 8. extract tar.gz and split set
  j = await run({ kind: "extract", label: "xtgz", inputs: [outTgz], options: { dest: path.join(work, "extract3") } });
  ok(j.state === "done" && sameTree(path.join(work, "extract3", path.basename(src))), "extract tar.gz (compound)", j.error);
  j = await run({ kind: "extract", label: "xsplit", inputs: [outSplit], options: { dest: path.join(work, "extract4") } });
  ok(j.state === "done" && sameTree(path.join(work, "extract4", path.basename(src))), "extract split .zip.001 set", j.error);
  if (outRar) {
    j = await run({ kind: "extract", label: "xrar", inputs: [outRar], options: { dest: path.join(work, "extract5"), password: "rarpw" } });
    ok(j.state === "done" && sameTree(path.join(work, "extract5", path.basename(src))), "extract RAR5 (encrypted) with 7-Zip", j.error);
  }

  // 9. convert zip -> 7z with delete-original (trash stand-in) and outPassword
  const convSrc = path.join(work, "conv.zip");
  fs.copyFileSync(outZip, convSrc);
  j = await run({ kind: "convert", label: "conv", inputs: [convSrc], options: { format: "7z", level: 1, password: "pw 123", outPassword: "newpw", deleteOriginal: true } });
  ok(j.state === "done" && fs.existsSync(path.join(bin, "conv.zip")) && !fs.existsSync(convSrc), "convert zip->7z, original moved to bin after verify", j.error || j.output);
  j = await run({ kind: "extract", label: "xconv", inputs: [path.join(work, "conv.7z")], options: { dest: path.join(work, "extract6"), password: "newpw" } });
  ok(j.state === "done" && sameTree(path.join(work, "extract6", path.basename(src))), "converted archive round-trips with new password", j.error);

  // 10. convert split set -> tar.gz and delete all volumes
  const sdir = path.join(work, "splitconv");
  fs.mkdirSync(sdir);
  for (const n of ["001", "002", "003", "004"]) fs.copyFileSync(outSplit.replace(/001$/, n), path.join(sdir, `set.zip.${n}`));
  j = await run({ kind: "convert", label: "convsplit", inputs: [path.join(sdir, "set.zip.001")], options: { format: "tar.gz", deleteOriginal: true } });
  ok(j.state === "done" && fs.readdirSync(sdir).join() === "set.tar.gz", "convert split set -> tar.gz removes every volume", j.error || fs.readdirSync(sdir).join());

  // 11. test job + corrupt archive
  j = await run({ kind: "test", label: "t", inputs: [out7z], options: {} });
  ok(j.state === "done", "test job on good 7z", j.error);
  const bad = path.join(work, "broken.7z");
  fs.writeFileSync(bad, fs.readFileSync(out7z).subarray(0, 40000));
  j = await run({ kind: "extract", label: "xbad", inputs: [bad], options: { dest: path.join(work, "extract7") } });
  ok(j.state === "failed" && (j.errorKind === "corrupt" || j.errorKind === "unsupported"), "truncated 7z fails as corrupt", `${j.errorKind}: ${j.error}`);
  j = await run({ kind: "extract", label: "xnot", inputs: [path.join(src, "readme.txt")], options: { dest: path.join(work, "extract8") } });
  ok(j.state === "failed", "non-archive fails cleanly", `${j.errorKind}: ${j.error}`);

  // 12. path traversal zip (hand-built, stored entries)
  const evil = path.join(work, "evil.zip");
  fs.writeFileSync(evil, buildZip([["../../evil.txt", "owned"], ["ok.txt", "fine"]]));
  j = await run({ kind: "extract", label: "xevil", inputs: [evil], options: { dest: path.join(work, "extract9") } });
  ok(j.state === "failed" && j.errorKind === "unsafe", "zip with ../ entry is refused", `${j.errorKind}: ${j.error}`);

  // 13. cancel mid-job
  const big = path.join(work, "big");
  fs.mkdirSync(big);
  for (let i = 0; i < 6; i += 1) fs.writeFileSync(path.join(big, `b${i}.bin`), crypto.randomBytes(8 * 1024 * 1024));
  const cj = q.add({ kind: "compress", label: "cancel", inputs: [big], options: { format: "7z", level: 9 } });
  setTimeout(() => q.cancel(cj.id), 700);
  j = await wait(cj);
  ok(j.state === "cancelled", "cancel mid-compress", j.state);

  // 14. compress many small files: per-item naming + output to folder
  const outdir = path.join(work, "outdir");
  j = await run({ kind: "compress", label: "multi", inputs: [path.join(src, "readme.txt"), path.join(src, "nested")], options: { format: "zip", outputMode: "folder", outputDir: outdir } });
  ok(j.state === "done" && path.dirname(j.output) === outdir && /Projekt Ärger ✓\.zip$/.test(j.output), "multi-input archive named after parent, into chosen folder", j.error || j.output);
  const listing = await engine.list(j.output);
  ok(listing.entries.some((e) => e.path === "readme.txt") && listing.entries.some((e) => /^nested[\\/]/.test(e.path)), "multi-input zip keeps only item-relative paths", listing.entries.map((e) => e.path).slice(0, 4).join(", "));

  console.log(`\n${fails ? `${fails} FAILURES` : "ALL PASSED"}  (work dir: ${work})`);
  if (!fails) fs.rmSync(work, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });

// minimal ZIP writer (stored entries) for the traversal test
function buildZip(files) {
  const parts = []; const central = []; let offset = 0;
  const crc = (b) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  for (const [name, data] of files) {
    const n = Buffer.from(name, "utf8"); const d = Buffer.from(data, "utf8"); const c = crc(d);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt16LE(0, 8); lh.writeUInt32LE(0, 10); lh.writeUInt32LE(c, 14); lh.writeUInt32LE(d.length, 18); lh.writeUInt32LE(d.length, 22); lh.writeUInt16LE(n.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8); ch.writeUInt16LE(0, 10); ch.writeUInt32LE(0, 12); ch.writeUInt32LE(c, 16); ch.writeUInt32LE(d.length, 20); ch.writeUInt32LE(d.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42);
    parts.push(lh, n, d); central.push(ch, n); offset += lh.length + n.length + d.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16); eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, cd, eocd]);
}
