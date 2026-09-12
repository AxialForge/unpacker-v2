// Windows Explorer right-click entries, registered per-user (HKCU) with reg.exe.
// No admin rights, no PowerShell. On Windows 11 these appear under
// "Show more options" (the classic menu); that is a Windows limitation for any
// app that doesn't ship a packaged (MSIX) context-menu extension.
//
// Entries:
//   any file / folder  -> "Add to archive (Unpacker V2)"     --compress <path>
//   archive types      -> "Extract here (Unpacker V2)"        --extract-here <path>
//                      -> "Extract to folder... (Unpacker V2)" --extract-to <path>
//                      -> "Convert archive... (Unpacker V2)"   --convert <path>
//
// Multi-select launches one process per item; main.js coalesces them through
// the single-instance lock into one job.

const { execFile } = require("node:child_process");
const { SINGLE, COMPOUND } = require("./engine/formats");

const BASE = "HKCU\\Software\\Classes";
const ADD_KEY = "UnpackerV2.Add";
const ARCHIVE_VERBS = [
  { key: "UnpackerV2.ExtractHere", label: "Extract here (Unpacker V2)", flag: "--extract-here" },
  { key: "UnpackerV2.ExtractTo", label: "Extract to folder... (Unpacker V2)", flag: "--extract-to" },
  { key: "UnpackerV2.Convert", label: "Convert archive... (Unpacker V2)", flag: "--convert" },
];

/** Extensions that get the extract verbs. Compound suffixes reduce to their last ext. */
function archiveExtensions() {
  const set = new Set(Object.keys(SINGLE));
  for (const suffix of Object.keys(COMPOUND)) set.add(suffix.slice(suffix.lastIndexOf(".")));
  set.delete(".img");
  set.delete(".msi"); // don't hijack installers
  return [...set];
}

function reg(args) {
  return new Promise((resolve, reject) => {
    execFile("reg.exe", args, { windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || stdout || err.message).trim()));
      else resolve(stdout);
    });
  });
}

async function addVerb(keyPath, label, exe, flag) {
  await reg(["add", keyPath, "/ve", "/d", label, "/f"]);
  await reg(["add", keyPath, "/v", "Icon", "/d", `"${exe}",0`, "/f"]);
  await reg(["add", `${keyPath}\\command`, "/ve", "/d", `"${exe}" ${flag} "%1"`, "/f"]);
}

/** Registry operations as a plan (pure, for tests) */
function plan(exe) {
  const ops = [];
  ops.push({ key: `${BASE}\\*\\shell\\${ADD_KEY}`, label: "Add to archive (Unpacker V2)", flag: "--compress" });
  ops.push({ key: `${BASE}\\Directory\\shell\\${ADD_KEY}`, label: "Add to archive (Unpacker V2)", flag: "--compress" });
  ops.push({ key: `${BASE}\\Directory\\shell\\UnpackerV2.ExtractAll`, label: "Extract all archives in here... (Unpacker V2)", flag: "--extract-all" });
  for (const ext of archiveExtensions()) {
    for (const v of ARCHIVE_VERBS) {
      ops.push({ key: `${BASE}\\SystemFileAssociations\\${ext}\\shell\\${v.key}`, label: v.label, flag: v.flag });
    }
  }
  return ops.map((o) => ({ ...o, exe }));
}

async function register(exe) {
  for (const op of plan(exe)) await addVerb(op.key, op.label, op.exe, op.flag);
  return true;
}

async function unregister() {
  for (const op of plan("")) {
    try {
      await reg(["delete", op.key, "/f"]);
    } catch {
      /* not present */
    }
  }
  return true;
}

async function isRegistered() {
  try {
    await reg(["query", `${BASE}\\*\\shell\\${ADD_KEY}\\command`]);
    return true;
  } catch {
    return false;
  }
}

module.exports = { register, unregister, isRegistered, plan, archiveExtensions };
