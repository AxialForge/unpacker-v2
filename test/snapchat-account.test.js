const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const acct = require("../src/main/snapchat-account");

const msg = (t, from, type, content, extra = {}) => ({ From: from, "Media Type": type, Created: `${t} UTC`, Content: content, "Conversation Title": null, IsSender: from === "me_user", "Created(microseconds)": Date.parse(`${t.replace(" ", "T")}Z`) * 1000, IsSaved: false, "Media IDs": "", ...extra });

test("mergeConversations unions messages across copies without duplicates, sorted by time", () => {
  const a = { pal: [msg("2024-01-02 10:00:00", "pal", "TEXT", "hi"), msg("2024-01-02 10:01:00", "me_user", "TEXT", "hey")] };
  const b = { pal: [msg("2024-01-02 10:01:00", "me_user", "TEXT", "hey"), msg("2024-01-01 09:00:00", "pal", "MEDIA", null, { "Media IDs": "b~abc|b~def" })], other: [msg("2024-02-02 00:00:00", "other", "STICKER", null)] };
  const m = acct.mergeConversations([a, b]);
  assert.deepEqual(Object.keys(m).sort(), ["other", "pal"]);
  assert.equal(m.pal.length, 3);
  assert.equal(m.pal[0]["Media Type"], "MEDIA", "earliest first");
  assert.equal(acct.chatLine(m.pal[0]), "2024-01-01 09:00:00  pal: [photo or video: b~abc|b~def]");
  assert.equal(acct.chatLine(m.pal[2]), "2024-01-02 10:01:00  me: hey");
  assert.equal(acct.chatLine(msg("2024-01-01 00:00:00", "x", "STATUSERASEDMESSAGE", null)), "2024-01-01 00:00:00  x: [status erasedmessage]");
});

test("mergeLists unions named lists; pickLargest keeps the fullest copy", () => {
  const m = acct.mergeLists([{ Friends: [{ Username: "a" }], Note: "x" }, { Friends: [{ Username: "a" }, { Username: "b" }], Blocked: [{ Username: "c" }] }]);
  assert.deepEqual(m.Friends.map((f) => f.Username), ["a", "b"]);
  assert.deepEqual(m.Blocked.map((f) => f.Username), ["c"]);
  assert.equal(m.Note, "x");
  assert.deepEqual(acct.pickLargest([{ a: 1 }, { a: 1, b: [1, 2, 3] }]), { a: 1, b: [1, 2, 3] });
});

test("renderText writes nested data as indented, readable lines", () => {
  const lines = acct.renderText({ "Basic Information": { Username: "u", Email: "" }, Devices: [{ Make: "m" }, "plain"], Empty: [] });
  assert.deepEqual(lines, ["Basic Information:", "  Username: u", "  Email: (empty)", "Devices:", "  -", "    Make: m", "  - plain", "Empty:", "  (none)"]);
});

test("organizeAccount builds chats, media, snaps, friends, stories, location and readable sections from two copies", async () => {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "unp-acct-"));
  try {
    const put = (rel, data) => {
      const p = path.join(stage, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, typeof data === "string" ? data : JSON.stringify(data));
    };
    // copy 1 (memories-only export) and copy 2 (full export) of the same account
    put("_sections/1/json/memories_history.json", { "Saved Media": [] });
    put("_sections/1/json/friends.json", { Friends: [{ Username: "a", "Display Name": "A" }] });
    put("_sections/2/json/friends.json", { Friends: [{ Username: "a", "Display Name": "A" }, { Username: "b", "Display Name": "B" }], "Blocked Users": [{ Username: "z", "Display Name": "" }] });
    put("_sections/2/json/chat_history.json", { pal: [msg("2024-01-02 10:00:00", "pal", "TEXT", "hi, there"), msg("2024-01-02 10:00:30", "pal", "MEDIA", null, { "Media IDs": "b~abc" })], "Group: Trip": [msg("2024-03-03 03:03:03", "me_user", "TEXT", "x")] });
    put("_sections/2/json/snap_history.json", { pal: [{ From: "pal", "Media Type": "IMAGE", Created: "2024-01-05 00:00:00 UTC", IsSender: false, "Created(microseconds)": 1 }] });
    put("_sections/2/json/story_history.json", { "Your Story Views": [{ "Story Date": "2024-01-01 00:00:00 UTC", "Story Views": 3, "Story Replies": 0 }] });
    put("_sections/2/json/location_history.json", { "Location History": [["2024-01-01 01:00:00 UTC", "41.5, -82.5"]], "Areas you may have visited in the last two years": [{ Time: "2024-01", City: "Town", Region: "OH", "Postal Code": "44000" }] });
    put("_sections/2/json/account.json", { "Basic Information": { Username: "me_user" } });
    put("json/account.json", { "Basic Information": { Username: "me_user" } }); // the plain copy left by extraction
    put("html/account.html", "<html></html>");
    put("index.html", "<html></html>");
    put("chat_media/2024-01-02_b~abc.jpg", "pic");
    put("chat_media/2024-05-05_b~zzz.mp4", "vid");
    put("chat_media/2024-05-05_overlay~zip-1111.webp", "ov");
    const lib = path.join(stage, "Library");
    const warnings = [];
    const moveFile = async (src, dst) => {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.renameSync(src, dst);
      return dst;
    };
    const r = await acct.organizeAccount(stage, lib, { warn: (w) => warnings.push(w) }, { moveFile });
    const has = (rel) => fs.existsSync(path.join(lib, rel));
    assert.equal(r.conversations, 2);
    assert.equal(r.messages, 3);
    const chat = fs.readFileSync(path.join(lib, "Chats", "pal", "Chat with pal.txt"), "utf8");
    assert.match(chat, /^Chat with pal\r\n2 messages, 2024-01-02 10:00:00 to 2024-01-02 10:00:30 \(UTC\)\r\n\r\n2024-01-02 10:00:00  pal: hi, there\r\n/);
    assert.ok(has(path.join("Chats", "Group_ Trip", "Chat with Group_ Trip.txt")), "unsafe characters in a conversation name are replaced");
    assert.match(fs.readFileSync(path.join(lib, "Chats", "All chats.csv"), "utf8"), /pal,2024-01-02 10:00:00,pal,TEXT,"hi, there",,\r\n/);
    assert.ok(has(path.join("Chats", "pal", "Media", "2024-01-02_b~abc.jpg")), "media named in a message lands with that conversation");
    assert.ok(has(path.join("Chats", "Media", "2024", "05", "2024-05-05_b~zzz.mp4")) && has(path.join("Chats", "Media", "2024", "05", "2024-05-05_overlay~zip-1111.webp")), "unlinked media by date");
    assert.equal(r.chatMedia, 3);
    assert.equal(r.chatMediaLinked, 1);
    assert.match(fs.readFileSync(path.join(lib, "Chats", "Chat media index.csv"), "utf8"), /Chats\/pal\/Media\/2024-01-02_b~abc\.jpg,2024-01-02,pal,picture/);
    assert.match(fs.readFileSync(path.join(lib, "Snaps", "Snap log.csv"), "utf8"), /pal,2024-01-05 00:00:00,received,pal,image/);
    assert.match(fs.readFileSync(path.join(lib, "Friends", "Friends.csv"), "utf8"), /Username,Display Name\r\na,A\r\nb,B\r\n/, "friends merged across copies");
    assert.ok(has(path.join("Friends", "Blocked Users.csv")));
    assert.ok(has(path.join("Stories", "Your Story Views.csv")));
    assert.match(fs.readFileSync(path.join(lib, "Location", "Location history.csv"), "utf8"), /2024-01-01 01:00:00,41\.5,-82\.5/);
    assert.ok(has(path.join("Location", "Areas visited.csv")));
    assert.match(fs.readFileSync(path.join(lib, "Account data", "account.txt"), "utf8"), /Basic Information:\r\n {2}Username: me_user/);
    assert.ok(has(path.join("Account data", "json", "account.json")) && has(path.join("Account data", "html", "account.html")) && has(path.join("Account data", "index.html")), "originals kept");
    assert.ok(has(path.join("Account data", "original 1", "json", "memories_history.json")) && has(path.join("Account data", "original 2", "json", "chat_history.json")), "every export's own copy kept");
    assert.ok(has(path.join("Account data", "What's in here.txt")));
    assert.deepEqual(r.sections, ["account", "chat_history", "friends", "location_history", "memories_history", "snap_history", "story_history"]);
    assert.ok(!fs.existsSync(path.join(stage, "chat_media")) && !fs.existsSync(path.join(stage, "_sections")) && !fs.existsSync(path.join(stage, "json")), "staging emptied");
    assert.equal(warnings.length, 0);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
});
