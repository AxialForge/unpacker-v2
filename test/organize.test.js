const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const exif = require("../src/main/exif");
const org = require("../src/main/organize");

// A tiny but structurally valid JPEG: SOI, APP0 (JFIF), SOS, EOI.
function jpeg({ withExif = false, dateTags = true } = {}) {
  const soi = Buffer.from([0xff, 0xd8]);
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.from("JFIF\0\x01\x01\x00\x00\x01\x00\x01\x00\x00", "latin1")]);
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]);
  if (!withExif) return Buffer.concat([soi, app0, sos]);
  const d = new Date(Date.UTC(2001, 0, 1, 0, 0, 0));
  const base = exif.setDateTaken(Buffer.concat([soi, app0, sos]), d).buf; // inserts a proper segment
  if (dateTags) return base;
  // strip the two date tags by zeroing the entry count of the Exif IFD (keeps pointer)
  const segs = exif.segments(base);
  const app1 = segs.find((s) => s.marker === 0xe1);
  const tiff = app1.start + 10;
  const out = Buffer.from(base);
  out.writeUInt16BE(0, tiff + 26); // Exif IFD entry count -> 0
  return out;
}

test("exif: inserts DateTimeOriginal when a JPEG has no Exif", () => {
  const d = new Date(Date.UTC(2019, 6, 1, 10, 30, 5));
  const r = exif.setDateTaken(jpeg(), d);
  assert.equal(r.written, true);
  assert.equal(r.mode, "insert");
  assert.equal(exif.getDateTaken(r.buf), "2019:07:01 10:30:05");
  assert.ok(r.buf.length > 40);
  assert.equal(r.buf.readUInt16BE(0), 0xffd8, "still a JPEG");
  assert.deepEqual([...r.buf.subarray(-2)], [0xff, 0xd9], "EOI intact");
});

test("exif: overwrites existing date tags in place", () => {
  const withDate = jpeg({ withExif: true });
  assert.equal(exif.getDateTaken(withDate), "2001:01:01 00:00:00");
  const r = exif.setDateTaken(withDate, new Date(Date.UTC(2022, 11, 31, 23, 59, 59)));
  assert.equal(r.mode, "overwrite");
  assert.equal(r.buf.length, withDate.length, "same size: overwritten in place");
  assert.equal(exif.getDateTaken(r.buf), "2022:12:31 23:59:59");
});

test("exif: refuses non-JPEG and Exif without date tags", () => {
  assert.equal(exif.setDateTaken(Buffer.from("not a jpeg at all"), new Date()).written, false);
  const noTags = jpeg({ withExif: true, dateTags: false });
  const r = exif.setDateTaken(noTags, new Date());
  assert.equal(r.written, false);
  assert.match(r.reason, /without date tags/);
});

test("matchSidecar follows Google's naming rules", () => {
  const jsons = [
    "IMG_0395.JPG.supplemental-metadata.json",
    "IMG_0395.JPG.supplemental-metadata(1).json",
    "20190821_190343.jpg.json",
    "a-very-long-photo-name-from-a-phone-camera-2019-08-21.supplemental-metadata.json",
    "metadata.json",
  ];
  assert.equal(org.matchSidecar("IMG_0395.JPG", jsons), "IMG_0395.JPG.supplemental-metadata.json");
  assert.equal(org.matchSidecar("IMG_0395(1).JPG", jsons), "IMG_0395.JPG.supplemental-metadata(1).json");
  assert.equal(org.matchSidecar("20190821_190343.jpg", jsons), "20190821_190343.jpg.json");
  assert.equal(org.matchSidecar("IMG_0395-edited.JPG", jsons), "IMG_0395.JPG.supplemental-metadata.json", "edited copies use the original's sidecar");
  assert.equal(org.matchSidecar("a-very-long-photo-name-from-a-phone-camera-2019-08-21-extra.jpg", jsons), "a-very-long-photo-name-from-a-phone-camera-2019-08-21.supplemental-metadata.json", "truncated sidecar name");
  assert.equal(org.matchSidecar("IMG_9999.JPG", jsons), null);
});

test("takenDate and yearMonth", () => {
  const d = org.takenDate({ photoTakenTime: { timestamp: "1566428623" } });
  assert.equal(d.toISOString(), "2019-08-21T23:03:43.000Z");
  assert.equal(org.yearMonth(d), "2019/08");
  assert.equal(org.takenDate({ creationTime: { timestamp: "1" } }).getTime(), 1000, "falls back to creationTime");
  assert.equal(org.takenDate({}), null);
  assert.equal(org.takenDate(null), null);
});

test("findTakeoutRoots handles wrapper, bare Takeout, and per-part folders", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "unp-org-"));
  try {
    fs.mkdirSync(path.join(d, "merged", "Takeout", "Google Photos"), { recursive: true });
    fs.mkdirSync(path.join(d, "parts", "takeout-x-001", "Takeout", "Drive"), { recursive: true });
    fs.mkdirSync(path.join(d, "parts", "takeout-x-002", "Takeout", "Mail"), { recursive: true });
    assert.deepEqual(org.findTakeoutRoots(path.join(d, "merged")), [path.join(d, "merged", "Takeout")]);
    assert.deepEqual(org.findTakeoutRoots(path.join(d, "merged", "Takeout")), [path.join(d, "merged", "Takeout")]);
    assert.deepEqual(org.findTakeoutRoots(path.join(d, "parts")).sort(), [path.join(d, "parts", "takeout-x-001", "Takeout"), path.join(d, "parts", "takeout-x-002", "Takeout")]);
    const svc = org.discoverServices(org.findTakeoutRoots(path.join(d, "parts")));
    assert.deepEqual(svc.map((s) => s.name).sort(), ["Drive", "Mail"]);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});
