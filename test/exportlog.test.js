const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const log = require("../src/main/exportlog");

test("kindOf sorts extensions into plain kinds", () => {
  assert.equal(log.kindOf("a.JPG"), "Photos");
  assert.equal(log.kindOf("a.mp4"), "Videos");
  assert.equal(log.kindOf("a.flac"), "Audio");
  assert.equal(log.kindOf("a.docx"), "Documents");
  assert.equal(log.kindOf("a.7z"), "Archives");
  assert.equal(log.kindOf("a.bin"), "Other");
  assert.equal(log.kindOf("noext"), "Other");
});

test("write describes the folders without moving anything", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "unp-log-"));
  try {
    const put = (rel, data) => {
      const p = path.join(d, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, data);
      fs.utimesSync(p, new Date("2024-03-05T10:00:00Z"), new Date("2024-03-05T10:00:00Z"));
    };
    put("alpha/Trip/IMG_1.jpg", "12345");
    put("alpha/Trip/clip.mp4", "1234567890");
    put("alpha/notes, final.txt", "abc");
    put("beta/report.pdf", "pdf");
    put("alpha.zip", "source archive");
    put("Mass-extract-report.txt", "report");
    const before = fs.readdirSync(d).sort();
    const r = log.write({
      dir: d,
      title: "Old backups - extracted archives",
      roots: [{ path: path.join(d, "alpha"), source: "alpha.zip" }, { path: path.join(d, "beta"), source: "beta.7z" }, { path: path.join(d, "alpha", "Trip"), source: "nested" }],
      sources: [{ name: "alpha.zip", state: "done", output: path.join(d, "alpha") }, { name: "beta.7z", state: "done", output: path.join(d, "beta") }, { name: "broken.rar", state: "failed", error: "Unexpected end of archive" }],
      notes: ["The source archives were left where they were."],
      now: new Date("2026-10-04T00:00:00Z"),
    });
    assert.equal(r.files, 4, "nested root is not counted twice; the archive and report outside the roots are not listed");
    assert.equal(r.bytes, 5 + 10 + 3 + 3);
    assert.deepEqual(fs.readdirSync(d).sort(), [...before, log.CONTENTS, log.OVERVIEW, log.SUMMARY].sort(), "only the three log files were added");
    const h = fs.readFileSync(r.overview, "utf8");
    assert.match(h, /<title>Old backups - extracted archives<\/title>/);
    assert.match(h, /<b>4 files<\/b>, <b>21 B<\/b>/);
    assert.match(h, /\["alpha\/Trip","IMG_1\.jpg",5,"2024-03-05","Photos","alpha\.zip"\]/, "every file is embedded for the search box");
    assert.match(h, /broken\.rar: failed \(Unexpected end of archive\)/);
    assert.ok(!/<script src=|<link /.test(h), "self-contained: nothing fetched from anywhere");
    const s = fs.readFileSync(r.summary, "utf8");
    assert.match(s, /^Old backups - extracted archives\r\n=+\r\n/);
    assert.match(s, /This folder holds 4 files, 21 B in total: 1 photos, 1 videos, 2 documents\./);
    assert.match(s, /alpha\s+3 files\s+18 B\s+1 photos, 1 videos, 1 documents\r\n\s+dated 2024-03-05/);
    assert.match(s, /beta\s+1 files/);
    assert.match(s, /2 of 3 archives were extracted\./);
    assert.match(s, /alpha\.zip {2}-> {2}alpha/);
    assert.match(s, /Needs attention\r\n-+\r\n {2}broken\.rar: failed \(Unexpected end of archive\)/);
    assert.match(s, /left where they were/);
    const c = fs.readFileSync(r.contents, "utf8");
    assert.ok(c.startsWith("﻿folder,file,size (bytes),modified,kind,came from\r\n"));
    assert.match(c, /alpha\\Trip,IMG_1\.jpg,5,2024-03-05T10:00:00Z,Photos,alpha\.zip\r\n/);
    assert.match(c, /alpha,"notes, final\.txt",3,2024-03-05T10:00:00Z,Documents,alpha\.zip\r\n/, "commas are quoted");
    assert.match(c, /beta,report\.pdf,3,[^,]+,Documents,beta\.7z/);
    // running it again does not list its own files
    const again = log.write({ dir: d, title: "x", roots: [{ path: d }], skip: new Set([path.join(d, "alpha.zip").toLowerCase()]) });
    assert.equal(again.files, 5, "whole folder: 4 files + the report, minus the skipped archive and the three log files");
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test("roots that point at the same folder are merged", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "unp-log-"));
  try {
    fs.writeFileSync(path.join(d, "a.txt"), "a");
    const inv = log.inventory(d, [{ path: d, source: "one.zip" }, { path: d, source: "two.zip" }]);
    assert.equal(inv.files.length, 1);
    assert.equal(inv.files[0].source, "several archives");
    assert.equal(log.summarise(inv.files).groups[0].name, "(files at the top)");
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});
