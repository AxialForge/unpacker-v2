const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sc = require("../src/main/snapchat");
const exif = require("../src/main/exif");

const jpeg = (fill = 1) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1"), Buffer.from([0xff, 0xda, 0x00, 0x02]), Buffer.alloc(64, fill), Buffer.from([0xff, 0xd9])]);
const T = (y, m, d, hh, mm, ss) => Date.UTC(y, m - 1, d, hh, mm, ss) / 1000;

test("part names: plain, numbered and browser copies", () => {
  assert.deepEqual(sc.parsePartName("D:\\x\\mydata~1790635398407.zip"), { id: "1790635398407", index: 1, copy: 0 });
  assert.deepEqual(sc.parsePartName("mydata~1790635398407-3.zip"), { id: "1790635398407", index: 3, copy: 0 });
  assert.deepEqual(sc.parsePartName("mydata~1790635398407-2 (1).zip"), { id: "1790635398407", index: 2, copy: 1 });
  assert.equal(sc.parsePartName("takeout-20260912T140102Z-001.zip"), null);
  assert.equal(sc.isSnapchatPart("mydata.zip"), false);
});

test("groupExports sorts parts, reports gaps and repeated downloads", () => {
  const g = sc.groupExports(["a/mydata~1-3.zip", "a/mydata~1.zip", "a/mydata~1 (1).zip", "a/mydata~2.zip", "a/other.zip"], () => 10);
  assert.equal(g.length, 2);
  const one = g.find((x) => x.id === "1");
  assert.deepEqual(one.parts.map((p) => p.index), [1, 3]);
  assert.deepEqual(one.missing, [2]);
  assert.equal(one.duplicates.length, 1);
  assert.equal(one.parts[0].path, "a/mydata~1.zip", "the un-suffixed download is kept");
  assert.equal(one.totalBytes, 20);
});

test("locations and dates parse; 0,0 means no position", () => {
  assert.deepEqual(sc.parseLocation("Latitude, Longitude: 41.479101, -82.680124"), { lat: 41.479101, lon: -82.680124 });
  assert.equal(sc.parseLocation("Latitude, Longitude: 0.0, 0.0"), null);
  assert.equal(sc.parseLocation(""), null);
  assert.equal(sc.parseLocation("Latitude, Longitude: 95.0, 10.0"), null, "out of range");
  assert.equal(sc.parseDate("2024-07-01 15:30:45 UTC"), T(2024, 7, 1, 15, 30, 45));
  assert.equal(sc.parseDate("July 1"), null);
  assert.equal(sc.stamp(T(2024, 7, 1, 5, 3, 9)), "2024-07-01_050309");
});

test("parseHistory reads Snapchat's record shape", () => {
  const recs = sc.parseHistory({ "Saved Media": [{ Date: "2024-07-01 15:30:45 UTC", "Media Type": "Image", Location: "Latitude, Longitude: 1.5, 2.5" }, { Date: "2024-07-02 01:00:00 UTC", "Media Type": "Video", Location: "Latitude, Longitude: 0.0, 0.0" }, { Date: "bad", "Media Type": "Image" }] });
  assert.equal(recs.length, 2);
  assert.deepEqual(recs[0], { time: T(2024, 7, 1, 15, 30, 45), type: "jpg", gps: { lat: 1.5, lon: 2.5 }, date: "2024-07-01 15:30:45 UTC" });
  assert.equal(recs[1].type, "mp4");
  assert.equal(recs[1].gps, null);
  assert.deepEqual(sc.parseHistory({}), []);
});

test("matchRecords pairs on time and type, each record once", () => {
  const t = T(2024, 7, 1, 15, 30, 45);
  const records = [
    { time: t, type: "jpg", gps: { lat: 1, lon: 1 } },
    { time: t, type: "jpg", gps: { lat: 2, lon: 2 } }, // two photos in the same second
    { time: t, type: "mp4", gps: null },
    { time: t + 500, type: "jpg", gps: null }, // its file is in a part we do not have
  ];
  const files = [
    { name: "a.jpg", time: t, type: "jpg" },
    { name: "b.jpg", time: t + 1, type: "jpg" }, // one second off still matches
    { name: "c.mp4", time: t, type: "mp4" },
    { name: "d.jpg", time: t + 9000, type: "jpg" }, // no record
  ];
  const r = sc.matchRecords(files, records);
  assert.equal(r.pairs.size, 3);
  assert.deepEqual(r.pairs.get("a.jpg").gps, { lat: 1, lon: 1 });
  assert.deepEqual(r.pairs.get("b.jpg").gps, { lat: 2, lon: 2 });
  assert.equal(r.pairs.get("c.mp4").type, "mp4");
  assert.deepEqual(r.unmatchedFiles, ["d.jpg"]);
  assert.equal(r.unusedRecords.length, 1);
  assert.equal(r.unusedRecords[0].time, t + 500);
});

test("EXIF position round-trips, north/south and east/west", () => {
  const r = exif.setDateTaken(jpeg(), new Date(Date.UTC(2024, 6, 1, 15, 30, 45)), { gps: { lat: 41.479101, lon: -82.680124 } });
  assert.equal(r.gps, true);
  assert.equal(exif.getDateTaken(r.buf), "2024:07:01 15:30:45");
  const g = exif.getGps(r.buf);
  assert.ok(Math.abs(g.lat - 41.479101) < 1e-6 && Math.abs(g.lon + 82.680124) < 1e-6);
  const s = exif.getGps(exif.setDateTaken(jpeg(), new Date(0), { gps: { lat: -33.5, lon: 151.25 } }).buf);
  assert.deepEqual(s, { lat: -33.5, lon: 151.25 });
  assert.equal(exif.getGps(exif.setDateTaken(jpeg(), new Date(0)).buf), null, "no position unless asked");
  assert.equal(exif.getGps(jpeg()), null);
});

test("organize builds a dated, geotagged library and lists what is missing", async () => {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "unp-snap-"));
  try {
    const put = (rel, data, t) => {
      const p = path.join(stage, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, data);
      if (t) fs.utimesSync(p, t, t);
    };
    const u1 = "11111111-1111-1111-1111-111111111111";
    const u2 = "22222222-2222-2222-2222-222222222222";
    const u3 = "33333333-3333-3333-3333-333333333333";
    const u9 = "99999999-9999-9999-9999-999999999999";
    const t1 = T(2024, 7, 1, 15, 30, 45);
    const t2 = T(2023, 12, 25, 8, 0, 0);
    put(`memories/2024-07-01_${u1}-main.jpg`, jpeg(1), t1);
    put(`memories/2024-07-01_${u1}-overlay.png`, "png", t1);
    put(`memories/2023-12-25_${u2}-main.mp4`, "video", t2);
    put(`memories/2022-03-03_${u3}-main.jpg`, jpeg(3), T(2026, 10, 1, 0, 0, 0)); // timestamp lost: falls back to the name
    put(`memories/2021-01-01_${u9}-overlay.png`, "orphan");
    put("memories/memories.html", "<html></html>");
    put("index.html", "<html></html>");
    put("html/faq.html", "<html></html>");
    put("json/chat_history.json", "{}");
    put(
      "json/memories_history.json",
      JSON.stringify({
        "Saved Media": [
          { Date: "2024-07-01 15:30:45 UTC", "Media Type": "Image", Location: "Latitude, Longitude: 41.5, -82.5" },
          { Date: "2023-12-25 08:00:00 UTC", "Media Type": "Video", Location: "Latitude, Longitude: 0.0, 0.0" },
          { Date: "2020-02-02 02:02:02 UTC", "Media Type": "Image", Location: "Latitude, Longitude: 1.0, 1.0" },
        ],
      })
    );
    const warnings = [];
    const ctx = { stage() {}, progress() {}, warn: (w) => warnings.push(w), signal: new AbortController().signal };
    const r = await sc.organize(stage, {}, ctx);
    const L = r.output;
    const has = (rel) => fs.existsSync(path.join(L, rel));
    assert.ok(has("Memories/2024/07/2024-07-01_153045.jpg"));
    assert.ok(has("Memories/2024/07/2024-07-01_153045_overlay.png"), "overlay follows its photo under the same name");
    assert.ok(has("Memories/2023/12/2023-12-25_080000.mp4"));
    assert.ok(has("Memories/2022/03/2022-03-03_120000.jpg"), "no record and a lost timestamp: day from the name, noon");
    assert.ok(has(`Memories/Overlays/Without a photo/2021-01-01_${u9}-overlay.png`));
    assert.ok(has("Account data/json/chat_history.json") && has("Account data/json/memories_history.json") && has("Account data/html/faq.html") && has("Account data/index.html") && has("Account data/memories.html"));
    assert.ok(!fs.existsSync(path.join(stage, "memories")) && !fs.existsSync(path.join(stage, "json")), "the extracted folders are emptied");
    const photo = fs.readFileSync(path.join(L, "Memories/2024/07/2024-07-01_153045.jpg"));
    assert.equal(exif.getDateTaken(photo), "2024:07:01 15:30:45");
    assert.deepEqual(exif.getGps(photo), { lat: 41.5, lon: -82.5 });
    assert.equal(Math.round(fs.statSync(path.join(L, "Memories/2023/12/2023-12-25_080000.mp4")).mtimeMs / 1000), t2);
    assert.deepEqual({ media: r.summary.media, matched: r.summary.matched, unmatched: r.summary.unmatched, missing: r.summary.missingRecords, gps: r.summary.gpsWritten, overlays: r.summary.overlays, orphans: r.summary.orphanOverlays }, { media: 3, matched: 2, unmatched: 1, missing: 1, gps: 1, overlays: 1, orphans: 1 });
    assert.ok(r.summary.otherSections.includes("chat_history"));
    const idx = fs.readFileSync(path.join(L, "Memories/Memories index.csv"), "utf8");
    assert.match(idx, /Memories\/2024\/07\/2024-07-01_153045\.jpg,2024-07-01T15:30:45Z,photo,41\.5,-82\.5,Memories\/2024\/07\/2024-07-01_153045_overlay\.png,yes/);
    assert.match(fs.readFileSync(path.join(L, "Memories/Missing memories.csv"), "utf8"), /2020-02-02T02:02:02Z,photo,1,1/);
    assert.ok(warnings.some((w) => /1 memories are listed by Snapchat/.test(w)));
    assert.ok(has("Snapchat library report.txt"));
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
});

test("organize refuses a folder that is not a Snapchat export", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "unp-snap-"));
  try {
    await assert.rejects(sc.organize(d, {}, { stage() {}, progress() {}, warn() {} }), /not a Snapchat export/);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test("organize burns the overlay into a copy of the photo when asked and a compositor is available", async () => {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "unp-snap-burn-"));
  try {
    const t = Date.UTC(2024, 6, 1, 15, 30, 45) / 1000;
    const put = (rel, data) => {
      const p = path.join(stage, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, data);
      fs.utimesSync(p, new Date(t * 1000), new Date(t * 1000));
    };
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1"), Buffer.from([0xff, 0xda, 0x00, 0x02]), Buffer.alloc(64, 1), Buffer.from([0xff, 0xd9])]);
    const uuid = "00000000-0000-4000-8000-000000000001";
    put(`memories/2024-07-01_${uuid}-main.jpg`, jpeg);
    put(`memories/2024-07-01_${uuid}-overlay.png`, "png");
    put("json/memories_history.json", JSON.stringify({ "Saved Media": [{ Date: "2024-07-01 15:30:45 UTC", "Media Type": "Image", Location: "Latitude, Longitude: 41.5, -81.6" }] }));
    put("index.html", "<html></html>");
    const calls = [];
    const composite = async (photo, overlay) => {
      calls.push([path.basename(photo), path.basename(overlay)]);
      return jpeg; // a "composited" picture without EXIF
    };
    const r = await sc.organize(stage, { burn: true }, { stage() {}, progress() {}, warn: (w) => assert.fail(w) }, { composite });
    const dir = path.join(r.output, "Memories", "2024", "07");
    assert.deepEqual(calls, [["2024-07-01_153045.jpg", "2024-07-01_153045_overlay.png"]], "composited after the files were placed and renamed");
    assert.ok(fs.existsSync(path.join(dir, "2024-07-01_153045.jpg")), "original kept");
    const burned = fs.readFileSync(path.join(dir, "2024-07-01_153045_with overlay.jpg"));
    assert.equal(exif.getDateTaken(burned), "2024:07:01 15:30:45", "the burned copy gets the taken time");
    assert.deepEqual(exif.getGps(burned), { lat: 41.5, lon: -81.6 }, "and the position");
    assert.equal(r.summary.burned, 1);
    assert.match(fs.readFileSync(r.report, "utf8"), /1 photos written with the overlay burned in/);
    // without a compositor nothing is burned and nothing fails
    const stage2 = fs.mkdtempSync(path.join(os.tmpdir(), "unp-snap-burn2-"));
    fs.mkdirSync(path.join(stage2, "memories"));
    fs.mkdirSync(path.join(stage2, "json"));
    fs.writeFileSync(path.join(stage2, "memories", `2024-07-01_${uuid}-main.jpg`), jpeg);
    fs.writeFileSync(path.join(stage2, "memories", `2024-07-01_${uuid}-overlay.png`), "png");
    fs.writeFileSync(path.join(stage2, "json", "memories_history.json"), JSON.stringify({ "Saved Media": [] }));
    const r2 = await sc.organize(stage2, { burn: true }, { stage() {}, progress() {}, warn() {} });
    assert.equal(r2.summary.burned, 0);
    fs.rmSync(stage2, { recursive: true, force: true });
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
});
