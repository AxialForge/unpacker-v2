// The non-memories part of a Snapchat "My Data" export, turned into readable files.
//
// Sections observed on a full account export (October 2026), all under json/:
//   chat_history.json      { "<conversation>": [ { From, Media Type, Created, Content, IsSender,
//                                                  Created(microseconds), IsSaved, Media IDs } ] }
//   snap_history.json      { "<conversation>": [ { From, Media Type, Created, IsSender, … } ] }
//   friends.json           { "Friends": [ { Username, Display Name, Creation Timestamp, … } ], … }
//   story_history.json     { "Your Story Views": [...], "Friend and Public Story Views": [...] }
//   location_history.json  { "Location History": [ [ datetime, "lat, lon" ] ], "Areas you may …": [...], … }
//   + account, user_profile, search_history, ranking, snap_ads, … (rendered generically)
// chat_media/<YYYY-MM-DD>_b~<id>.jpg|mp4|gif|webp   pictures sent in chats; "Media IDs" in a
//                                                   message names the b~<id> (several joined by "|")
//
// Two exports of the same account overlap (the memories-only export and the
// full one). loadSections() therefore accepts several copies of a section and
// merge*() functions join them without duplicates. Pure except for the disk.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const safety = require("./safety");

const csvCell = (c) => safety.csvCell(c ?? "");
const csv = (rows) => `﻿${rows.map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`;
const safe = (s) => safety.safeFileName(String(s || "").trim()) || "unknown";

/** All copies of json/<name>.json under `stage`: stage/json and each stage/_sections/<n>/json. */
function sectionFiles(stage, name) {
  const out = [];
  const direct = path.join(stage, "json", `${name}.json`);
  if (fs.existsSync(direct)) out.push(direct);
  const alt = path.join(stage, "_sections");
  if (fs.existsSync(alt)) for (const d of fs.readdirSync(alt).sort()) if (fs.existsSync(path.join(alt, d, "json", `${name}.json`))) out.push(path.join(alt, d, "json", `${name}.json`));
  return out;
}

function sectionNames(stage) {
  const names = new Set();
  const add = (dir) => fs.existsSync(dir) && fs.readdirSync(dir).filter((f) => /\.json$/i.test(f)).forEach((f) => names.add(f.replace(/\.json$/i, "")));
  add(path.join(stage, "json"));
  const alt = path.join(stage, "_sections");
  if (fs.existsSync(alt)) for (const d of fs.readdirSync(alt)) add(path.join(alt, d, "json"));
  return [...names].sort();
}

function loadSection(stage, name, warn) {
  const copies = [];
  for (const f of sectionFiles(stage, name)) {
    try {
      copies.push(JSON.parse(fs.readFileSync(f, "utf8")));
    } catch (err) {
      if (warn) warn(`${path.basename(f)} could not be read: ${err.message}`);
    }
  }
  return copies;
}

// ── merging several copies of one section ────────────────────────

/** Conversations: union of messages per conversation, deduplicated on (time, sender, type, content). */
function mergeConversations(copies) {
  const out = new Map();
  for (const c of copies) {
    if (!c || typeof c !== "object" || Array.isArray(c)) continue;
    for (const [conv, msgs] of Object.entries(c)) {
      if (!Array.isArray(msgs)) continue;
      if (!out.has(conv)) out.set(conv, new Map());
      const m = out.get(conv);
      for (const x of msgs) {
        const k = `${x["Created(microseconds)"] || x.Created}|${x.From}|${x["Media Type"]}|${x.Content || ""}`;
        if (!m.has(k)) m.set(k, x);
      }
    }
  }
  const res = {};
  for (const [conv, m] of out) res[conv] = [...m.values()].sort((a, b) => (a["Created(microseconds)"] || 0) - (b["Created(microseconds)"] || 0) || String(a.Created).localeCompare(String(b.Created)));
  return res;
}

/** Lists under named keys (friends.json, story_history.json): union per key, deduplicated on the whole record. */
function mergeLists(copies) {
  const out = {};
  for (const c of copies) {
    if (!c || typeof c !== "object" || Array.isArray(c)) continue;
    for (const [k, v] of Object.entries(c)) {
      if (!Array.isArray(v)) {
        if (out[k] === undefined) out[k] = v;
        continue;
      }
      const seen = new Set((out[k] || []).map((x) => JSON.stringify(x)));
      out[k] = out[k] || [];
      for (const x of v) {
        const j = JSON.stringify(x);
        if (!seen.has(j)) {
          seen.add(j);
          out[k].push(x);
        }
      }
    }
  }
  return out;
}

/** Anything else: the copy with the most content wins. */
function pickLargest(copies) {
  return copies.map((c) => [JSON.stringify(c).length, c]).sort((a, b) => b[0] - a[0]).map((x) => x[1])[0];
}

// ── readable renderers ───────────────────────────────────────────

/** Generic JSON -> indented text that a person can read. */
function renderText(v, indent = 0, lines = []) {
  const pad = "  ".repeat(indent);
  if (Array.isArray(v)) {
    if (!v.length) lines.push(`${pad}(none)`);
    for (const x of v) {
      if (x && typeof x === "object") {
        lines.push(`${pad}-`);
        renderText(x, indent + 1, lines);
      } else lines.push(`${pad}- ${x}`);
    }
  } else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (x && typeof x === "object") {
        lines.push(`${pad}${k}:`);
        renderText(x, indent + 1, lines);
      } else lines.push(`${pad}${k}: ${x === null || x === "" ? "(empty)" : x}`);
    }
  } else lines.push(`${pad}${v}`);
  return lines;
}

const when = (s) => String(s || "").replace(/ UTC$/, "");

function chatLine(m) {
  const who = m.IsSender ? "me" : m.From || "?";
  const t = m["Media Type"] || "";
  let body;
  if (t === "TEXT") body = m.Content == null ? "" : String(m.Content);
  else if (t === "MEDIA") body = `[photo or video${m["Media IDs"] ? `: ${m["Media IDs"]}` : ""}]`;
  else if (t === "STICKER") body = "[sticker]";
  else if (t === "NOTE") body = "[voice note]";
  else if (t === "SHARE") body = `[shared${m.Content ? `: ${m.Content}` : ""}]`;
  else if (t.startsWith("STATUS")) body = `[${t.replace(/^STATUS/, "status ").toLowerCase().trim() || "status"}]`;
  else body = `[${t.toLowerCase()}]${m.Content ? ` ${m.Content}` : ""}`;
  return `${when(m.Created)}  ${who}: ${body}${m.IsSaved ? "  (saved)" : ""}`;
}

/**
 * Write the account sections into `library`. Moves chat_media. Returns counts.
 * @param {string} stage   extracted export (json/, _sections/, chat_media/)
 * @param {string} library output root
 */
async function organizeAccount(stage, library, ctx, deps = {}) {
  const warn = ctx.warn || (() => {});
  const moveFile = deps.moveFile;
  const rep = { conversations: 0, messages: 0, chatMedia: 0, chatMediaLinked: 0, snaps: 0, friendsLists: 0, stories: 0, locations: 0, sections: [] };
  const names = sectionNames(stage);
  rep.sections = names;
  const dataOut = path.join(library, "Account data");
  const put = (rel, text) => {
    const p = path.join(library, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text, "utf8");
  };

  // chats
  const mediaOwner = new Map(); // b~id -> conversation
  const chats = mergeConversations(loadSection(stage, "chat_history", warn));
  const allRows = [["conversation", "time (UTC)", "from", "type", "content", "media ids", "saved"]];
  for (const [conv, msgs] of Object.entries(chats).sort()) {
    rep.conversations += 1;
    rep.messages += msgs.length;
    const lines = [`Chat with ${conv}`, `${msgs.length} messages, ${when(msgs[0] && msgs[0].Created)} to ${when(msgs[msgs.length - 1] && msgs[msgs.length - 1].Created)} (UTC)`, ""];
    for (const m of msgs) {
      lines.push(chatLine(m));
      allRows.push([conv, when(m.Created), m.IsSender ? "me" : m.From || "", m["Media Type"] || "", m.Content == null ? "" : m.Content, m["Media IDs"] || "", m.IsSaved ? "yes" : ""]);
      for (const id of String(m["Media IDs"] || "").split("|").map((s) => s.trim()).filter(Boolean)) mediaOwner.set(id, conv);
    }
    put(path.join("Chats", safe(conv), `Chat with ${safe(conv)}.txt`), `${lines.join("\r\n")}\r\n`);
  }
  if (rep.conversations) put(path.join("Chats", "All chats.csv"), csv(allRows));

  // chat media: by date from the file name, linked to a conversation when a message names it
  const cm = path.join(stage, "chat_media");
  if (fs.existsSync(cm)) {
    const idx = [["file", "date", "conversation", "kind"]];
    for (const f of fs.readdirSync(cm).sort()) {
      const m = /^(\d{4})-(\d{2})-(\d{2})_(.+)$/.exec(f);
      if (!m) continue;
      const id = (/^(b~[A-Za-z0-9_\-=]+)/.exec(m[4]) || [])[1];
      const conv = id ? mediaOwner.get(id) : null;
      const kind = /^overlay~/.test(m[4]) ? "overlay" : /^thumbnail~/.test(m[4]) ? "thumbnail" : /\.(mp4|mov)$/i.test(f) ? "video" : "picture";
      const rel = conv ? path.join("Chats", safe(conv), "Media", f) : path.join("Chats", "Media", m[1], m[2], f);
      const target = await moveFile(path.join(cm, f), path.join(library, rel));
      const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12));
      try {
        fs.utimesSync(target, d, d);
      } catch {
        /* fine */
      }
      rep.chatMedia += 1;
      if (conv) rep.chatMediaLinked += 1;
      idx.push([path.relative(library, target).replace(/\\/g, "/"), `${m[1]}-${m[2]}-${m[3]}`, conv || "", kind]);
    }
    if (rep.chatMedia) put(path.join("Chats", "Chat media index.csv"), csv(idx));
    try {
      fs.rmdirSync(cm);
    } catch {
      /* leftovers */
    }
  }

  // snaps
  const snaps = mergeConversations(loadSection(stage, "snap_history", warn));
  const snapRows = [["conversation", "time (UTC)", "direction", "from", "type"]];
  for (const [conv, list] of Object.entries(snaps).sort()) for (const s of list) snapRows.push([conv, when(s.Created), s.IsSender ? "sent" : "received", s.From || "", (s["Media Type"] || "").toLowerCase()]);
  rep.snaps = snapRows.length - 1;
  if (rep.snaps) put(path.join("Snaps", "Snap log.csv"), csv(snapRows));

  // friends
  const friends = mergeLists(loadSection(stage, "friends", warn));
  for (const [k, list] of Object.entries(friends)) {
    if (!Array.isArray(list) || !list.length) continue;
    const cols = [...new Set(list.flatMap((x) => Object.keys(x || {})))];
    put(path.join("Friends", `${safe(k)}.csv`), csv([cols, ...list.map((x) => cols.map((c) => (x || {})[c]))]));
    rep.friendsLists += 1;
  }

  // stories
  const stories = mergeLists(loadSection(stage, "story_history", warn));
  for (const [k, list] of Object.entries(stories)) {
    if (!Array.isArray(list) || !list.length) continue;
    const cols = [...new Set(list.flatMap((x) => Object.keys(x || {})))];
    put(path.join("Stories", `${safe(k)}.csv`), csv([cols, ...list.map((x) => cols.map((c) => (x || {})[c]))]));
    rep.stories += list.length;
  }

  // location
  const loc = pickLargest(loadSection(stage, "location_history", warn));
  if (loc && typeof loc === "object") {
    const hist = Array.isArray(loc["Location History"]) ? loc["Location History"] : [];
    const rows = [["time (UTC)", "latitude", "longitude"]];
    for (const e of hist) {
      if (!Array.isArray(e) || e.length < 2) continue;
      const mm = /(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/.exec(String(e[1]));
      rows.push([when(e[0]), mm ? mm[1] : "", mm ? mm[2] : ""]);
    }
    if (rows.length > 1) put(path.join("Location", "Location history.csv"), csv(rows));
    rep.locations = rows.length - 1;
    const areas = loc["Areas you may have visited in the last two years"];
    if (Array.isArray(areas) && areas.length) {
      const cols = [...new Set(areas.flatMap((x) => Object.keys(x || {})))];
      put(path.join("Location", "Areas visited.csv"), csv([cols, ...areas.map((x) => cols.map((c) => (x || {})[c]))]));
    }
  }

  // every section, readable + raw
  for (const name of names) {
    const copies = loadSection(stage, name);
    if (!copies.length) continue;
    const data = ["chat_history", "snap_history"].includes(name) ? mergeConversations(copies) : ["friends", "story_history"].includes(name) ? mergeLists(copies) : pickLargest(copies);
    put(path.join("Account data", `${name}.txt`), `${renderText(data).join("\r\n")}\r\n`);
  }
  // raw files: keep every copy
  let copyNo = 0;
  for (const dir of [path.join(stage, "json"), path.join(stage, "html"), ...(fs.existsSync(path.join(stage, "_sections")) ? fs.readdirSync(path.join(stage, "_sections")).map((d) => path.join(stage, "_sections", d)) : [])]) {
    if (!fs.existsSync(dir)) continue;
    const isAlt = dir.includes(`${path.sep}_sections${path.sep}`);
    const walk = async (d, rel) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) await walk(p, path.join(rel, e.name));
        else await moveFile(p, path.join(dataOut, isAlt ? `original ${copyNo}` : "", rel, e.name));
      }
      try {
        fs.rmdirSync(d);
      } catch {
        /* leftovers */
      }
    };
    if (isAlt) copyNo += 1;
    await walk(dir, isAlt ? "" : path.basename(dir));
  }
  try {
    fs.rmdirSync(path.join(stage, "_sections"));
  } catch {
    /* fine */
  }
  for (const f of fs.existsSync(stage) ? fs.readdirSync(stage) : []) if (/^index.*\.html$/i.test(f)) await moveFile(path.join(stage, f), path.join(dataOut, f));
  const readme = [
    "Account data",
    "============",
    "",
    "Everything Snapchat exported about the account, as readable text files (one per section)",
    "with the original json/ and html/ files kept underneath. Sections:",
    ...names.map((n) => `  ${n}`),
    "",
    "Chats, Snaps, Friends, Stories and Location have their own folders one level up.",
  ];
  put(path.join("Account data", "What's in here.txt"), `${readme.join("\r\n")}\r\n`);
  return rep;
}

module.exports = { organizeAccount, mergeConversations, mergeLists, pickLargest, renderText, chatLine, loadSection, sectionNames, sectionFiles };
