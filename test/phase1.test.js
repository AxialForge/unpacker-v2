const test = require("node:test");
const assert = require("node:assert/strict");
const { JobQueue, maskSecrets } = require("../src/main/jobs/queue");
const sz = require("../src/main/engine/sevenzip");
const safety = require("../src/main/safety");
const policy = require("../src/main/policy");

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test("secrets never leave the queue in snapshots, but retry still sees them", async () => {
  const seen = [];
  const q = new JobQueue(async (job) => {
    seen.push(job.options.password);
    return {};
  });
  const events = [];
  q.on("change", (j) => events.push(j));
  const j = q.add({ kind: "test", label: "x", inputs: [], options: { password: "hunter2", outPassword: "p2", level: 5 } });
  await tick();
  assert.ok(events.length > 0);
  for (const e of events) {
    assert.equal(e.options.password, "•");
    assert.equal(e.options.outPassword, "•");
    assert.equal(e.options.level, 5);
  }
  assert.equal(q.listSafe()[0].options.password, "•");
  assert.equal(q.get(j.id).options.password, "hunter2", "internal job keeps the real value");
  assert.deepEqual(seen, ["hunter2"]);
  assert.deepEqual(maskSecrets({ a: 1 }), { a: 1 });
  assert.deepEqual(maskSecrets({ password: "" }), { password: "" }, "empty stays empty");
});

test("redactArgs masks -p and -hp switches only", () => {
  assert.deepEqual(sz.redactArgs(["a", "-t7z", "-psecret", "-hpsecret", "-mx=5", "out.7z"]), ["a", "-t7z", "-p•", "-hp•", "-mx=5", "out.7z"]);
});

const LINK_LIST = `
--
Path = x.tar
Type = tar

----------
Path = docs
Folder = +
Size = 0
Attributes = D drwxr-xr-x

Path = docs/link
Folder = -
Size = 0
Attributes = _ lrwxrwxrwx
Symbolic Link = ../../etc/passwd

Path = plain.txt
Folder = -
Size = 3
Attributes = A

Path = junction
Folder = +
Attributes = DL
`;

test("parseList surfaces link entries; linkEntries and inspect use them", () => {
  const r = sz.parseList(LINK_LIST);
  assert.equal(r.entries.find((e) => e.path === "docs/link").link, "../../etc/passwd");
  assert.equal(r.entries.find((e) => e.path === "plain.txt").link, "");
  assert.equal(r.entries.find((e) => e.path === "docs").link, "", "a plain directory is not a link");
  assert.equal(r.entries.find((e) => e.path === "junction").link, "(reparse point)");
  assert.equal(r.totals.links, 2);
  const links = safety.linkEntries(r.entries);
  assert.deepEqual(links.map((l) => l.path), ["docs/link", "junction"]);
});

test("cloudSyncRoot recognises sync folders from env and well-known names", () => {
  const env = { OneDrive: "C:\\Users\\me\\OneDrive", OneDriveCommercial: "C:\\Users\\me\\OneDrive - Viking Forge" };
  assert.equal(safety.cloudSyncRoot("C:\\Users\\me\\OneDrive\\Photos\\a.jpg", env), "OneDrive");
  assert.equal(safety.cloudSyncRoot("c:/users/me/onedrive - viking forge/docs", env), "OneDrive for work");
  assert.equal(safety.cloudSyncRoot("G:\\My Drive\\x", env), "Google Drive");
  assert.equal(safety.cloudSyncRoot("C:\\Users\\me\\Dropbox\\x", env), "Dropbox");
  assert.equal(safety.cloudSyncRoot("C:\\Users\\me\\OneDriveNot\\x", env), null, "prefix must be a whole segment");
  assert.equal(safety.cloudSyncRoot("D:\\Albums\\2026", env), null);
  assert.equal(safety.cloudSyncRoot("D:\\Albums", {}), null);
});

test("close and sleep policies", () => {
  assert.equal(policy.closeDecision({ busy: false, closeToTray: true }), "quit");
  assert.equal(policy.closeDecision({ busy: true, closeToTray: false }), "ask");
  assert.equal(policy.closeDecision({ busy: true, closeToTray: true }), "hide");
  assert.equal(policy.wantAwake({ running: 1, pending: 0, preventSleep: true }), true);
  assert.equal(policy.wantAwake({ running: 0, pending: 2, preventSleep: undefined }), true, "default on");
  assert.equal(policy.wantAwake({ running: 1, pending: 0, preventSleep: false }), false);
  assert.equal(policy.wantAwake({ running: 0, pending: 0, preventSleep: true }), false);
});
