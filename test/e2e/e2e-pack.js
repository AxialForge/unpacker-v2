// End-to-end: smart pack into chunks with manifest + hashes, then verify.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const ROOT = "C:\\Project Folder\\Unpacker V2";
const sz = require(path.join(ROOT, "src/main/engine/sevenzip"));
const { Runner } = require(path.join(ROOT, "src/main/jobs/runner"));
const { JobQueue } = require(path.join(ROOT, "src/main/jobs/queue"));
const analyze = require(path.join(ROOT, "src/main/analyze"));
const manifest = require(path.join(ROOT, "src/main/manifest"));

const engine = new sz.SevenZip(sz.locate({ appPath: ROOT }));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "unp-pack-e2e-"));
const settings = { format: "7z", level: 5, outputMode: "folder", outputDir: path.join(work, "out"), extractMode: "smart", overwrite: "rename", verify: true, tempDir: "", allowHighRatio: false };
const runner = new Runner({ sevenZip: engine, rar: null, settings: () => settings, trash: async () => {} });
const q = new JobQueue((j, c) => runner.run(j, c), { concurrency: 1 });
const wait = (job) => new Promise((res) => { const check = (j) => { if (j.id === job.id && !["queued", "running"].includes(j.state)) { q.off("change", check); res(q.get(job.id)); } }; q.on("change", check); });
const run = (spec) => wait(q.add(spec));
let fails = 0;
const ok = (c, m, x) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}${x ? `  -> ${x}` : ""}`); if (!c) fails += 1; };

// fixture: "album" of incompressible files in year folders + text docs; ~ 12 MB total
const src = path.join(work, "Album 2026");
const mk = (rel, buf) => { fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true }); fs.writeFileSync(path.join(src, rel), buf); };
mk("2019 Trip/IMG_1.jpg", crypto.randomBytes(1_500_000));
mk("2019 Trip/IMG_2.jpg", crypto.randomBytes(1_500_000));
mk("2020/MOV_1.mp4", crypto.randomBytes(2_500_000));
mk("2021/MOV_2.mp4", crypto.randomBytes(2_000_000));
mk("2021/MOV_3.mp4", crypto.randomBytes(2_000_000));
mk("huge.iso", crypto.randomBytes(5_000_000));
mk("notes/readme.txt", "notes\n".repeat(2000));
// a 4 MB chunk limit is not in CHUNK_SIZES; monkey-patch a test preset
const chunker = require(path.join(ROOT, "src/main/chunker"));
chunker.CHUNK_SIZES.push({ id: "test4m", label: "4 MB (test)", bytes: 4 * 1024 ** 2 });

(async () => {
  // analysis says: media -> store
  const a = await analyze.analyze([src]);
  ok(a.suggestion.kind === "store" && a.suggestion.format === "zip" && a.files === 7, "analysis suggests Store/ZIP for a media album", `${a.suggestion.kind} ${Math.round(a.probeRatio * 100)}%`);
  const t = await analyze.analyze([path.join(src, "notes")]);
  ok(t.suggestion.kind === "text" && t.probeRatio < 0.2, "analysis suggests 7z for text", `${t.suggestion.kind} ${Math.round(t.probeRatio * 100)}%`);

  // pack: zip store, 4 MB chunks, manifest + hashes
  let j = await run({ kind: "pack", label: "pack", inputs: [src], options: { format: "zip", level: 0, chunkSize: "test4m", chunkMode: "chunks", manifest: true, hash: true } });
  ok(j.state === "done", "pack job completes", j.error || j.output);
  const outDir = settings.outputDir;
  const names = fs.readdirSync(outDir).sort();
  console.log("      outputs:", names.join(", "));
  const mfile = names.find((n) => /\.manifest\.txt$/.test(n));
  ok(!!mfile && /^Album 2026_[A-HJ-NP-Z2-9]{8}\.manifest\.txt$/.test(mfile), "manifest named <stem>_<ID>.manifest.txt", mfile);
  const id = mfile.split("_")[1].slice(0, 8);
  const m = manifest.parseManifest(fs.readFileSync(path.join(outDir, mfile), "utf8"));
  ok(m.id === id && m.files.length === 7 && m.hashed, "manifest lists all 7 files with hashes");
  ok(names.filter((n) => n.startsWith(`Album 2026_${id}-`)).length >= 4, "several chunk archives share the ID");
  const vol = m.chunks.find((c) => c.volumes);
  ok(!!vol && /\.zip\.001$/.test(vol.file) && fs.existsSync(path.join(outDir, vol.file)) && fs.existsSync(path.join(outDir, vol.file.replace(/001$/, "002"))), "oversized huge.iso became a volume set", vol && vol.file);
  ok(j.warnings.some((w) => /larger than the chunk limit/.test(w)), "job warned about the oversized file");
  const trip = m.files.filter((f) => f.rel.includes("/2019 Trip/")).map((f) => f.chunk);
  ok(trip.length === 2 && trip[0] === trip[1], "2019 Trip kept together in one chunk", trip.join("/"));
  for (const c of m.chunks) {
    const l = await engine.list(path.join(outDir, c.file));
    const hasManifest = l.entries.some((e) => e.path === mfile);
    const hasFiles = m.files.filter((f) => f.chunk === c.label).every((f) => l.entries.some((e) => e.path.replace(/\\/g, "/") === f.rel));
    ok(hasManifest && hasFiles, `chunk ${c.label} holds its files + a manifest copy`, l.entries.map((e) => e.path).join(", "));
  }

  // verify: clean set passes
  j = await run({ kind: "verify-manifest", label: "v", inputs: [path.join(outDir, mfile)], options: {} });
  ok(j.state === "done" && /verify\.txt$/.test(j.output), "verify-manifest passes on a clean set", j.error || j.output);
  ok(/Everything matches/.test(fs.readFileSync(j.output, "utf8")), "verify report says everything matches");

  // verify: flip a byte inside a stored zip entry -> DAMAGED (CRC) ; delete a chunk -> MISSING
  const victim = path.join(outDir, m.chunks[0].file);
  const buf = fs.readFileSync(victim);
  buf[Math.floor(buf.length / 2)] ^= 0xff;
  fs.writeFileSync(victim, buf);
  fs.rmSync(path.join(outDir, m.chunks[1].file));
  j = await run({ kind: "verify-manifest", label: "v2", inputs: [path.join(outDir, mfile)], options: {} });
  ok(j.state === "failed" && /DAMAGED/.test(j.error) && /MISSING/.test(j.error), "verify-manifest reports a corrupted and a missing archive", j.error);

  // pack without manifest, no limit, 7z with solid cap -> single archive, plain name
  const out2 = path.join(work, "out2");
  settings.outputDir = out2;
  j = await run({ kind: "pack", label: "single", inputs: [path.join(src, "notes")], options: { format: "7z", level: 7, solidCap: "256m", chunkSize: "", manifest: false } });
  ok(j.state === "done" && path.basename(j.output) === "notes.7z", "plain single archive without manifest", j.error || j.output);

  // volumes mode: whole set as one archive in 4 MB pieces
  j = await run({ kind: "pack", label: "vols", inputs: [src], options: { format: "7z", level: 0, chunkSize: "test4m", chunkMode: "volumes", manifest: true, hash: false } });
  const vnames = fs.readdirSync(out2);
  ok(j.state === "done" && vnames.some((n) => /^Album 2026_[A-Z2-9]{8}\.7z\.001$/.test(n)) && vnames.some((n) => /\.7z\.003$/.test(n)), "volumes mode cuts one archive into pieces", vnames.join(", "));

  console.log(`\n${fails ? `${fails} FAILURES` : "ALL PASSED"}  (${work})`);
  if (!fails) fs.rmSync(work, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
