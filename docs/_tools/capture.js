// Regenerates every documentation screenshot, without any manual clicking.
//
//   cd docs/_tools && npm install        (once)
//   node docs/_tools/capture.js [outDir] [--themes=light,dark]
//
// What it does:
//   1. Builds FAKE sample data under docs/_tools/_demo (random bytes, invented
//      names). No real user data is ever read or shown.
//   2. Starts the application from source with Playwright, in an isolated
//      profile (docs/_tools/_demo/profile-<theme>), at 100% scale.
//   3. Drives each page and dialog, saves <shot>_clean.png and the bounding box
//      of every control listed for that surface in ui_spec.js
//      (<shot>.callouts.json). annotate.py turns those into *_annotated.png.
//   4. Writes runtime_facts.json (versions, menu read-out, profile path).
//
// The application source is not modified. The only hook used is the
// development-only "shot:open" message the application already listens for.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { _electron } = require("playwright-core");
const spec = require("./ui_spec");

const ROOT = path.resolve(__dirname, "..", "..");
const VERSION = require(path.join(ROOT, "package.json")).version;
const args = process.argv.slice(2);
const outDir = path.resolve(args.find((a) => !a.startsWith("--")) || path.join(ROOT, "docs", "release-package", VERSION));
const themes = (args.find((a) => a.startsWith("--themes=")) || "--themes=light,dark").slice(9).split(",");
const SHOTS = path.join(outDir, "screenshots");
const DEMO = path.join(__dirname, "_demo");
const SEVENZIP = path.join(ROOT, "vendor", "7zip", "7z.exe");
const ELECTRON = require(path.join(ROOT, "node_modules", "electron"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const z = (cwd, a) => execFileSync(SEVENZIP, a, { cwd, windowsHide: true, stdio: "ignore" });

// ── fake data ─────────────────────────────────────────────────────
function jpeg(bytes) {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1"), Buffer.from([0xff, 0xda, 0x00, 0x02]), crypto.randomBytes(bytes), Buffer.from([0xff, 0xd9])]);
}
function buildDemo(theme) {
  const d = path.join(DEMO, `data-${theme}`);
  fs.rmSync(d, { recursive: true, force: true });
  const mk = (rel, data) => {
    const p = path.join(d, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data);
    return p;
  };
  // an "album" to compress
  for (let i = 1; i <= 6; i += 1) mk(`Holiday 2026/Day ${i <= 3 ? 1 : 2}/IMG_${1000 + i}.jpg`, jpeg(900_000));
  mk("Holiday 2026/Day 2/clip.mp4", crypto.randomBytes(4_000_000));
  mk("Holiday 2026/notes.txt", "Trip notes\n".repeat(400));
  for (let i = 1; i <= 40; i += 1) mk(`Documents/report-${String(i).padStart(2, "0")}.txt`, `Quarterly report ${i}\n`.repeat(300));
  // archives to extract / convert / test
  fs.mkdirSync(path.join(d, "Downloads"));
  z(d, ["a", "-tzip", path.join(d, "Downloads", "vacation-photos.zip"), "Holiday 2026"]);
  z(d, ["a", "-t7z", path.join(d, "Downloads", "project-files.7z"), "Documents"]);
  z(d, ["a", "-ttar", path.join(d, "site.tar"), "Documents"]);
  z(d, ["a", "-tgzip", path.join(d, "Downloads", "site-backup.tar.gz"), path.join(d, "site.tar")]);
  fs.rmSync(path.join(d, "site.tar"));
  fs.mkdirSync(path.join(d, "Problem files"));
  fs.writeFileSync(path.join(d, "Problem files", "damaged-download.7z"), fs.readFileSync(path.join(d, "Downloads", "project-files.7z")).subarray(0, 300));
  z(d, ["a", "-tzip", "-pdemo-password", "-mem=AES256", path.join(d, "Problem files", "locked-payroll-sample.zip"), "Documents"]);
  // a folder for mass extract
  fs.mkdirSync(path.join(d, "Old backups"));
  z(d, ["a", "-tzip", path.join(d, "Old backups", "backup-january.zip"), "Documents"]);
  z(d, ["a", "-t7z", path.join(d, "Old backups", "backup-february.7z"), "Documents"]);
  z(d, ["a", "-tzip", path.join(d, "Old backups", "backup-march.zip"), "Holiday 2026"]);
  // Google Takeout: a two-service export in parts, one part missing, one re-download
  const stamp = "20260912T140102Z";
  const tk = path.join(d, "Takeout downloads");
  fs.mkdirSync(tk);
  const ts = (y, m, day) => String(Math.floor(Date.UTC(y, m - 1, day, 12) / 1000));
  const side = (t, title) => JSON.stringify({ title, photoTakenTime: { timestamp: t }, creationTime: { timestamp: t } });
  for (const part of [1, 2, 3, 5]) {
    const st = path.join(d, `_stage${part}`);
    const put = (rel, data) => {
      const p = path.join(st, "Takeout", rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, data);
    };
    put("archive_browser.html", "<html></html>");
    for (let i = 0; i < 12; i += 1) {
      const name = `IMG_${part}${String(i).padStart(3, "0")}.jpg`;
      put(`Google Photos/Photos from ${2018 + part}/${name}`, jpeg(12_000_000)); // big enough that the Run step stays on screen
      put(`Google Photos/Photos from ${2018 + part}/${name}.supplemental-metadata.json`, side(ts(2018 + part, 1 + i, 3 + i), name));
    }
    put(`Drive/Projects/plan-${part}.docx`, crypto.randomBytes(200_000));
    if (part === 1) put("Mail/All mail Including Spam and Trash.mbox", "From demo@example.com\n".repeat(2000));
    z(st, ["a", "-tzip", "-mx=0", path.join(tk, `takeout-${stamp}-${String(part).padStart(3, "0")}.zip`), "Takeout"]);
    fs.rmSync(st, { recursive: true, force: true });
  }
  fs.copyFileSync(path.join(tk, `takeout-${stamp}-003.zip`), path.join(tk, `takeout-${stamp}-003 (1).zip`));
  // an already-extracted Takeout folder
  const tree = path.join(d, "Extracted earlier", "Takeout");
  const putT = (rel, data) => {
    const p = path.join(tree, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data);
  };
  for (let i = 0; i < 8; i += 1) {
    putT(`Google Photos/Photos from 2017/PIC_${i}.jpg`, jpeg(300_000));
    putT(`Google Photos/Photos from 2017/PIC_${i}.jpg.supplemental-metadata.json`, side(ts(2017, 1 + i, 10), `PIC_${i}.jpg`));
  }
  putT("Google Photos/Family album/PIC_0.jpg", fs.readFileSync(path.join(tree, "Google Photos", "Photos from 2017", "PIC_0.jpg")));
  putT("Drive/Recipes/bread.docx", crypto.randomBytes(40_000));
  putT("Contacts/All Contacts/All Contacts.vcf", "BEGIN:VCARD\nFN:Sample Person\nEND:VCARD\n");
  putT("Calendar/Personal.ics", "BEGIN:VCALENDAR\nEND:VCALENDAR\n");
  // Snapchat: a two-part "My Data" export (memories + sections, then more memories).
  // Memories are real PNGs (the project's own screenshots) so the Library page
  // shows thumbnails; the records are invented.
  const sdl = path.join(d, "Snapchat downloads");
  fs.mkdirSync(sdl);
  const shotsDir = path.join(ROOT, "docs", "screenshots");
  const pngs = fs.readdirSync(shotsDir).filter((n) => n.endsWith(".png")).slice(0, 8).map((n) => fs.readFileSync(path.join(shotsDir, n)));
  const T = (y, m, dd, h, mi, s) => Date.UTC(y, m - 1, dd, h, mi, s) / 1000;
  const iso = (t) => new Date(t * 1000).toISOString().replace("T", " ").replace(/\.\d{3}Z/, " UTC");
  const uuid = (n) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
  const recs = [];
  const partA = [];
  const partB = [];
  for (let i = 0; i < 10; i += 1) {
    const t = T(2023 + (i % 2), 1 + (i % 6), 5 + i, 10 + i, i * 3, 0);
    const video = i % 4 === 3;
    recs.push({ Date: iso(t), "Media Type": video ? "Video" : "Image", Location: i % 3 ? `Latitude, Longitude: ${41.4 + i / 100}, -${81.5 + i / 100}` : "", "Download Link": "" });
    const day = new Date(t * 1000).toISOString().slice(0, 10);
    (i < 6 ? partA : partB).push({ name: `${day}_${uuid(i)}-main.${video ? "mp4" : "png"}`, data: video ? crypto.randomBytes(400_000_000) : pngs[i % pngs.length], t }); // big videos so the Run step is on screen long enough to capture
    if (i === 1) partA.push({ name: `${day}_${uuid(i)}-overlay.png`, data: pngs[0], t });
  }
  recs.push({ Date: iso(T(2024, 12, 24, 18, 0, 0)), "Media Type": "Image", Location: "" }); // listed, never delivered
  const msg = (t, from, type, content, extra = {}) => ({ From: from, "Media Type": type, Created: `${t} UTC`, Content: content, IsSender: from === "sample_user", "Created(microseconds)": Date.parse(`${t.replace(" ", "T")}Z`) * 1000, IsSaved: true, "Media IDs": "", ...extra });
  const chats = {
    sample_friend: [msg("2024-03-02 10:00:00", "sample_friend", "TEXT", "Are we still on for Saturday?"), msg("2024-03-02 10:01:30", "sample_user", "TEXT", "Yes, 2 pm at the lake."), msg("2024-03-02 10:02:00", "sample_friend", "MEDIA", null, { "Media IDs": "b~demo0001" })],
    "Hiking group": [msg("2024-05-11 08:15:00", "sample_user", "TEXT", "Trailhead parking is full, use the lower lot.")],
  };
  const mkSnap = (n, items, withSections) => {
    const st = path.join(d, `_snap${n}`);
    for (const it of items) {
      const p = path.join(st, "memories", it.name);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, it.data);
      const dt = new Date(it.t * 1000);
      fs.utimesSync(p, dt, dt);
    }
    fs.mkdirSync(path.join(st, "json"), { recursive: true });
    fs.writeFileSync(path.join(st, "json", "memories_history.json"), JSON.stringify({ "Saved Media": recs }));
    if (withSections) {
      fs.writeFileSync(path.join(st, "json", "chat_history.json"), JSON.stringify(chats));
      fs.writeFileSync(path.join(st, "json", "friends.json"), JSON.stringify({ Friends: [{ Username: "sample_friend", "Display Name": "Sample Friend", "Creation Timestamp": "2021-01-01 00:00:00 UTC" }], "Blocked Users": [] }));
      fs.writeFileSync(path.join(st, "json", "snap_history.json"), JSON.stringify({ sample_friend: [{ From: "sample_friend", "Media Type": "IMAGE", Created: "2024-03-01 09:00:00 UTC", IsSender: false, "Created(microseconds)": 1 }] }));
      fs.writeFileSync(path.join(st, "json", "story_history.json"), JSON.stringify({ "Your Story Views": [{ "Story Date": "2024-03-01 00:00:00 UTC", "Story Views": 12, "Story Replies": 1 }] }));
      fs.writeFileSync(path.join(st, "json", "location_history.json"), JSON.stringify({ "Location History": [["2024-03-02 14:00:00 UTC", "41.5, -81.6"]], "Areas you may have visited in the last two years": [{ Time: "2024-03", City: "Sample Town", Region: "OH", "Postal Code": "44000" }] }));
      fs.writeFileSync(path.join(st, "json", "account.json"), JSON.stringify({ "Basic Information": { Username: "sample_user", Name: "Sample User", "Creation Date": "2019-06-01 12:00:00 UTC" } }));
      fs.mkdirSync(path.join(st, "chat_media"));
      fs.writeFileSync(path.join(st, "chat_media", "2024-03-02_b~demo0001.png"), pngs[1]);
      fs.writeFileSync(path.join(st, "index.html"), "<html></html>");
    }
    z(st, ["a", "-tzip", "-mx=0", path.join(sdl, n === 1 ? "mydata~1759900000001.zip" : "mydata~1759900000002.zip"), "*"]);
    fs.rmSync(st, { recursive: true, force: true });
  };
  mkSnap(1, partA, true);
  mkSnap(2, partB, false);
  return d;
}

// ── capture ───────────────────────────────────────────────────────
async function run(theme) {
  const data = buildDemo(theme);
  const profile = path.join(DEMO, `profile-${theme}`);
  fs.rmSync(profile, { recursive: true, force: true });
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, "settings.json"), JSON.stringify({ theme, autoUpdate: false, concurrency: 2 }));
  const app = await _electron.launch({ executablePath: ELECTRON, args: [ROOT, "--dev", `--user-data-dir=${profile}`, "--force-device-scale-factor=1"], env: { ...process.env, NO_AUTO_UPDATE: "1" } });
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.waitForFunction(() => document.getElementById("footVersion").textContent.length > 0);
  const size = await app.evaluate(({ BrowserWindow, screen }) => {
    const w = BrowserWindow.getAllWindows()[0];
    const area = screen.getPrimaryDisplay().workAreaSize;
    const h = Math.min(980, area.height - 60);
    w.setContentSize(1280, h);
    w.center();
    return { content: w.getContentSize(), workArea: area, scale: screen.getPrimaryDisplay().scaleFactor };
  });
  await sleep(400);
  const suffix = theme === "light" ? "" : `_${theme}`;
  const send = (which, paths = []) => app.evaluate(({ BrowserWindow }, a) => BrowserWindow.getAllWindows()[0].webContents.send("shot:open", a), { which, paths });
  const idle = () => page.waitForFunction(async () => (await window.unpacker.jobs.list()).every((j) => !["queued", "running"].includes(j.state)), null, { timeout: 180000, polling: 250 });
  const report = [];

  async function shot(surfaceId) {
    const s = spec.find((x) => x.id === surfaceId);
    await sleep(350);
    const callouts = [];
    const hidden = [];
    let n = 0;
    for (const c of s.controls) {
      if (!c.sel) continue;
      const loc = page.locator(c.sel).first();
      const box = (await loc.count()) && (await loc.isVisible()) ? await loc.boundingBox() : null;
      if (!box || box.width < 1) {
        hidden.push(c.id);
        if (!c.optional) report.push(`${s.shot}${suffix}: control "${c.id}" was not visible`);
        continue;
      }
      n += 1;
      callouts.push({ number: n, id: c.id, name: c.name, box: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) } });
    }
    const base = `${s.shot}${suffix}`;
    await page.screenshot({ path: path.join(SHOTS, `${base}_clean.png`) });
    fs.writeFileSync(path.join(SHOTS, `${base}.callouts.json`), JSON.stringify({ shot: s.shot, surface: s.id, theme, image: `${base}_clean.png`, callouts, not_visible: hidden }, null, 2));
    console.log(`  ${base}: ${callouts.length} callouts${hidden.length ? `, not visible: ${hidden.join(", ")}` : ""}`);
  }

  // facts about the running application (menu, versions, where the profile lives)
  if (theme === themes[0]) {
    const facts = await app.evaluate(({ app: a, Menu }) => {
      const walk = (items) => items.map((i) => ({ label: i.label, role: i.role || null, accelerator: i.accelerator || (i.getAcceleratorTextForItem ? null : null), type: i.type, submenu: i.submenu ? walk(i.submenu.items) : undefined }));
      const m = Menu.getApplicationMenu();
      return { name: a.getName(), version: a.getVersion(), userData: a.getPath("userData"), isPackaged: a.isPackaged, versions: process.versions, menu: m ? walk(m.items) : null };
    });
    facts.window = size;
    facts.userData = "(isolated documentation profile under docs/_tools/_demo)";
    fs.writeFileSync(path.join(outDir, "runtime_facts.json"), JSON.stringify(facts, null, 2));
  }

  // 02: tools and options, empty queue
  await shot("archives_tools");

  // fill the queue with real jobs on fake data
  const dl = path.join(data, "Downloads");
  await page.evaluate(
    async ({ dl, bad, album, backups }) => {
      const u = window.unpacker;
      await u.jobs.addPaths({ paths: [`${dl}\\vacation-photos.zip`], action: "extract", options: {} });
      await u.jobs.addPaths({ paths: [`${dl}\\project-files.7z`], action: "convert", options: { format: "zip", level: 5 } });
      await u.jobs.addPaths({ paths: [`${dl}\\site-backup.tar.gz`], action: "test", options: {} });
      await u.jobs.addPaths({ paths: [bad], action: "extract", options: {} });
      await u.pack.start([album], { format: "zip", level: 0, chunkSize: "", manifest: true, hash: true });
      const found = await u.massExtract.scan([backups]);
      await u.massExtract.start({ paths: found.items.map((i) => i.path), options: { destMode: "own", nested: "leave", sourcesAfter: "archival", sequential: true } });
    },
    { dl, bad: path.join(data, "Problem files", "damaged-download.7z"), album: path.join(data, "Holiday 2026"), backups: path.join(data, "Old backups") }
  );
  await idle();
  await sleep(600);
  await page.evaluate((p) => submitPaths([p], "extract"), path.join(data, "Holiday 2026", "notes.txt")); // produces a "Skipped" notice
  await shot("main_window");
  await shot("archives_queue");

  // 04: password dialog, opened by a real encrypted archive
  await page.evaluate((p) => window.unpacker.jobs.addPaths({ paths: [p], action: "extract", options: {} }), path.join(data, "Problem files", "locked-payroll-sample.zip"));
  await page.waitForSelector("#pwModal:not([hidden])", { timeout: 30000 });
  await shot("dialog_password");
  await page.click("#pwCancel");

  // 05: smart compress (Archival preset, so every control is live)
  await send("pack", [path.join(data, "Holiday 2026")]);
  await page.waitForFunction(() => !document.getElementById("pkOk").disabled && !document.getElementById("pkModal").hidden, null, { timeout: 60000 });
  await page.click('#pkPreset [data-preset="archival"]');
  await page.selectOption("#pkChunk", "4g");
  await page.fill("#pkPassword", "demo");
  await page.dispatchEvent("#pkPassword", "input");
  await shot("dialog_smart_compress");
  await page.click("#pkCancel");

  await send("convert", [path.join(dl, "vacation-photos.zip"), path.join(dl, "project-files.7z"), path.join(dl, "site-backup.tar.gz")]);
  await page.waitForSelector("#convModal:not([hidden])");
  await shot("dialog_convert");
  await page.click("#convCancel");

  await send("massExtract", [dl]);
  await page.waitForSelector("#meModal:not([hidden])");
  await page.selectOption("#meDest", "merge");
  await shot("dialog_mass_extract");
  await page.click("#meCancel");

  const tk = path.join(data, "Takeout downloads");
  await send("takeout", [tk]);
  await page.waitForSelector("#tkModal:not([hidden])");
  await shot("dialog_takeout");
  await page.click("#tkCancel");

  // 09-12: the wizard, run for real
  await send("takeoutTab", [tk, path.join(data, "Extracted earlier")]);
  await page.waitForSelector("#wzFound .tk-export");
  await shot("takeout_step1");
  await page.click("#wzNext");
  await page.waitForSelector('.wz-page[data-page="2"]:not([hidden])');
  await shot("takeout_step2");
  await page.click("#wzNext");
  await page.waitForSelector("#wzRail li.running", { timeout: 30000 });
  await sleep(700);
  await shot("takeout_step3");
  await page.waitForSelector('.wz-page[data-page="4"]:not([hidden])', { timeout: 300000 });
  await shot("takeout_step4");

  // 15-18: the Snapchat wizard, run for real on the fake export
  const sdl = path.join(data, "Snapchat downloads");
  await send("snapchatTab", [sdl]);
  await page.waitForSelector("#scFound .tk-export");
  await shot("snapchat_step1");
  await page.click("#scNext");
  await page.waitForSelector('.wz-page[data-sc-page="2"]:not([hidden])');
  await shot("snapchat_step2");
  await page.click("#scNext");
  await page.waitForSelector("#scRail li.running", { timeout: 30000 });
  await shot("snapchat_step3");
  await page.waitForSelector('.wz-page[data-sc-page="4"]:not([hidden])', { timeout: 300000 });
  await shot("snapchat_step4");

  // 19: the Library page on the Snapchat result, with a photo selected
  const snapLib = path.join(sdl, "Snapchat-export", "Snapchat Library");
  await send("library", [snapLib]);
  await page.waitForSelector("#libGrid .li.dir");
  await page.click('#libGrid .li.dir:has-text("Memories")');
  await page.waitForFunction(() => document.querySelectorAll("#libGrid .li.dir").length > 0 && document.querySelector("#libCrumbs .crumb.on") && document.querySelector("#libCrumbs .crumb.on").textContent === "Memories");
  await page.click("#libGrid .li.dir");
  await page.waitForFunction(() => /^\d{4}$/.test(document.querySelector("#libCrumbs .crumb.on").textContent));
  await page.click("#libGrid .li.dir");
  await page.waitForSelector("#libGrid .li:not(.dir)");
  await page.click("#libGrid .li:not(.dir)");
  await page.waitForSelector("#libPreview:not([hidden]) img");
  await page.waitForFunction(() => [...document.querySelectorAll("#libGrid .li-thumb img")].every((i) => i.complete));
  await sleep(400);
  await shot("library_page");

  await send("settings");
  await page.waitForSelector("#pageSettings:not([hidden])");
  await shot("settings_page");
  await send("about");
  await page.waitForSelector("#pageAbout:not([hidden])");
  await shot("about_page");

  if (errors.length) report.push(...errors.map((e) => `${theme}: page error: ${e}`));
  await idle().catch(() => {});
  await app.close();
  return report;
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const all = [];
  for (const t of themes) {
    console.log(`theme: ${t}`);
    all.push(...(await run(t)));
  }
  fs.rmSync(DEMO, { recursive: true, force: true });
  fs.writeFileSync(path.join(SHOTS, "capture_report.txt"), all.length ? `${all.join("\n")}\n` : "no problems\n");
  console.log(all.length ? `problems:\n${all.join("\n")}` : "capture finished with no problems");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
