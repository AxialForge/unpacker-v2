// Organizer end-to-end on a fake Takeout tree shaped like the real one on D:.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const ROOT = "C:\\Project Folder\\Unpacker V2";
const org = require(path.join(ROOT, "src/main/organize"));
const exif = require(path.join(ROOT, "src/main/exif"));
const { JobQueue } = require(path.join(ROOT, "src/main/jobs/queue"));

let fails = 0;
const ok = (c, m, x) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}${x ? `  -> ${x}` : ""}`); if (!c) fails += 1; };
const work = fs.mkdtempSync(path.join(os.tmpdir(), "unp-org-e2e-"));
const bin = path.join(work, "_bin");
fs.mkdirSync(bin);
const trash = async (p) => fs.renameSync(p, path.join(bin, `${crypto.randomBytes(3).toString("hex")}-${path.basename(p)}`));

// a JPEG body: SOI + APP0 + SOS(+random) + EOI ; unique per call unless body given
const jpg = (body) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1"), Buffer.from([0xff, 0xda, 0x00, 0x02]), body || crypto.randomBytes(2000), Buffer.from([0xff, 0xd9])]);
const side = (ts, title) => JSON.stringify({ title, photoTakenTime: { timestamp: String(ts) }, creationTime: { timestamp: String(ts + 5000) } });

// two per-part roots like a browser-extracted set, plus Drive and Mail
const p1 = path.join(work, "takeout-x-2-001", "Takeout");
const p2 = path.join(work, "takeout-x-2-002", "Takeout");
const mk = (root, rel, data) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), data); };
const T1 = 1562000000; // 2019-07-01
const T2 = 1640000000; // 2021-12-20
const shared = jpg(); // the same photo in the year folder and in an album
mk(p1, "Google Photos/Photos from 2019/IMG_0395.JPG", shared);
mk(p1, "Google Photos/Photos from 2019/IMG_0395.JPG.supplemental-metadata.json", side(T1, "IMG_0395.JPG"));
mk(p1, "Google Photos/Photos from 2019/IMG_0395(1).JPG", jpg());
mk(p1, "Google Photos/Photos from 2019/IMG_0395.JPG.supplemental-metadata(1).json", side(T1 + 60, "IMG_0395.JPG"));
mk(p1, "Google Photos/Photos from 2019/IMG_0395-edited.JPG", jpg());
mk(p1, "Google Photos/Photos from 2019/orphan.JPG.supplemental-metadata.json", side(T1, "orphan.JPG")); // media in a missing part
mk(p1, "Google Photos/Photos from 2019/metadata.json", "{}");
mk(p2, "Google Photos/Chicago 2019/IMG_0395.JPG", shared); // album copy of the same photo
mk(p2, "Google Photos/Chicago 2019/IMG_0395.JPG.supplemental-metadata.json", side(T1, "IMG_0395.JPG"));
mk(p2, "Google Photos/Chicago 2019/metadata.json", JSON.stringify({ title: "Chicago 2019" }));
mk(p2, "Google Photos/Photos from 2021/clip.mp4", crypto.randomBytes(3000));
mk(p2, "Google Photos/Photos from 2021/clip.mp4.supplemental-metadata.json", side(T2, "clip.mp4"));
mk(p2, "Google Photos/Photos from 2021/nosidecar.jpg", jpg());
mk(p1, "Drive/Projects/plan.docx", "docx");
mk(p2, "Drive/Projects/budget.xlsx", "xlsx");
mk(p2, "Drive/notes.txt", "n");
mk(p1, "Mail/All mail Including Spam and Trash.mbox", "From x\n");
mk(p2, "Contacts/My Contacts/contacts.vcf", "BEGIN:VCARD");
mk(p1, "archive_browser.html", "<html>");

(async () => {
  const roots = org.findTakeoutRoots(work);
  ok(roots.length === 2, "two per-part Takeout roots found", roots.map((r) => path.relative(work, r)).join(", "));
  const svc = org.discoverServices(roots);
  ok(svc.map((s) => s.name).sort().join() === "Contacts,Drive,Google Photos,Mail", "services discovered across roots", svc.map((s) => `${s.name}:${s.files}`).join(", "));

  const ctx = { stage: () => {}, progress: () => {}, warn: () => {}, signal: new AbortController().signal };
  const r = await org.run(work, { library: path.join(work, "Library"), photos: { enabled: true, dates: true, exif: true, yearMonth: true, dedupe: true, sidecars: "json" }, services: { enabled: true, skip: [] } }, ctx, { trash });
  const L = r.output;
  const has = (rel) => fs.existsSync(path.join(L, rel));
  const s = r.summary.photos;
  console.log("      summary:", JSON.stringify(s));
  ok(has("Photos/2019/07/IMG_0395.JPG") && has("Photos/2019/07/IMG_0395(1).JPG") && has("Photos/2019/07/IMG_0395-edited.JPG"), "photos sorted into Year/Month", fs.existsSync(path.join(L, "Photos", "2019", "07")) ? fs.readdirSync(path.join(L, "Photos", "2019", "07")).join(", ") : "-");
  ok(has("Photos/2021/12/clip.mp4") && has("Photos/Undated/nosidecar.jpg"), "video dated from JSON; file without sidecar lands in Undated");
  ok(s.duplicates === 1 && !has("Photos/2019/07/IMG_0395 (2).JPG") && fs.readdirSync(bin).some((n) => /IMG_0395\.JPG$/.test(n)), "album copy detected as duplicate and binned, not stored twice");
  const albums = fs.readFileSync(path.join(L, "Photos", "Albums.txt"), "utf8");
  ok(/\[Chicago 2019\]\nPhotos\/2019\/07\/IMG_0395\.JPG/.test(albums), "Albums.txt maps the album to the kept file", albums.replace(/\n/g, " | "));
  const mt = fs.statSync(path.join(L, "Photos", "2019", "07", "IMG_0395.JPG")).mtime.toISOString();
  ok(mt.startsWith("2019-07-01"), "file modified time set from photoTakenTime", mt);
  const taken = exif.getDateTaken(fs.readFileSync(path.join(L, "Photos", "2019", "07", "IMG_0395.JPG")));
  ok(taken === "2019:07:01 16:53:20", "EXIF DateTimeOriginal written into the JPEG", taken);
  ok(s.exifWritten === 3, "three JPEGs got EXIF (IMG, (1), edited); mp4 skipped", `written=${s.exifWritten} skipped=${s.exifSkipped}`);
  ok(s.orphanSidecars === 1 && has("Photos/_json/Photos from 2019/orphan.JPG.supplemental-metadata.json"), "orphan sidecar counted and parked in _json");
  ok(has("Photos/_json/Photos from 2019/IMG_0395.JPG.supplemental-metadata.json") && has("Photos/_json/Chicago 2019/IMG_0395.JPG.supplemental-metadata.json"), "used sidecars moved into _json by album");
  ok(has("Drive/Projects/plan.docx") && has("Drive/Projects/budget.xlsx") && has("Drive/notes.txt"), "Drive merged from both parts");
  ok(has("Mail/All mail Including Spam and Trash.mbox") && has("Contacts/My Contacts/contacts.vcf"), "Mail and Contacts moved");
  ok(!fs.existsSync(path.join(p1, "Google Photos")) && !fs.existsSync(path.join(p2, "Drive")), "emptied source folders removed");
  ok(fs.existsSync(path.join(L, "Takeout-organize-report.txt")), "report written");

  // through the queue with the dependency: organize waits for a (fake) extract
  const q = new JobQueue(async (job) => (job.kind === "fake-extract" ? { output: job.options.out } : org.run(job.inputs[0], job.options, ctx, { trash })));
  const w2 = path.join(work, "second");
  mk(path.join(w2, "Takeout"), "Google Photos/Photos from 2020/a.jpg", jpg());
  mk(path.join(w2, "Takeout"), "Google Photos/Photos from 2020/a.jpg.json", side(1590000000, "a.jpg"));
  const a = q.add({ kind: "fake-extract", label: "x", inputs: [], options: { out: w2 } });
  const b = q.add({ kind: "organize", label: "o", inputs: [], options: { photos: { yearMonth: true } }, after: a.id });
  await new Promise((res) => { const h = (j) => { if (j.id === b.id && ["done", "failed", "cancelled"].includes(j.state)) { q.off("change", h); res(); } }; q.on("change", h); });
  ok(q.get(b.id).state === "done" && fs.existsSync(path.join(w2, "Library", "Photos", "2020", "05", "a.jpg")), "queued organize ran after its extract and used its output", q.get(b.id).error);
  const c = q.add({ kind: "fake-fail", label: "f", inputs: [], options: {} });
  q.cancel(c.id);
  const d = q.add({ kind: "organize", label: "o2", inputs: [], options: {}, after: c.id });
  await new Promise((r2) => setTimeout(r2, 20));
  ok(q.get(d.id).state === "cancelled" && /Skipped/.test(q.get(d.id).stage), "dependent job is skipped when its dependency was cancelled", q.get(d.id).stage);

  console.log(`\n${fails ? `${fails} FAILURES` : "ALL PASSED"}  (${work})`);
  if (!fails) fs.rmSync(work, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
