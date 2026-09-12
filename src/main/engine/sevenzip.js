// Thin, careful wrapper around the 7-Zip console engine (7z.exe + 7z.dll).
//
// Everything the app does to an archive goes through here. The design rules:
//   * 7-Zip is a child process, never a native module (keeps npm install trivial).
//   * stdin is closed and a password switch is ALWAYS passed, so 7-Zip can never
//     sit waiting on a prompt. A wrong/missing password comes back as an error we
//     classify as "password" and the UI asks the user.
//   * Progress is parsed from -bsp1 output. 7-Zip redraws its progress with
//     backspaces, so chunks are split on \b \r \n and a partial tail is carried
//     over between chunks.
//   * Compound formats (tar.gz etc.) are two passes with a temp .tar in between.
//
// Pure helpers (parsers, classifier, arg builders, locate) are exported for
// unit tests and never touch Electron.

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Never let 7-Zip prompt. If the archive isn't encrypted this is ignored; if it
// is, 7-Zip fails with a "Wrong password" that classify() recognises.
const NO_PASSWORD = "unpacker-v2-no-password-given";

const COMMON = ["-y", "-bso1", "-bse1", "-bsp1", "-bb0", "-sccUTF-8", "-scsUTF-8"];

const EXIT = { 0: "ok", 1: "warning", 2: "fatal", 7: "usage", 8: "memory", 255: "cancelled" };

// ── locate ───────────────────────────────────────────────────────

/**
 * Candidate 7z.exe locations, most specific first:
 *   packaged app  -> <resources>/7zip/7z.exe   (electron-builder extraResources)
 *   from source   -> <repo>/vendor/7zip/7z.exe
 *   the user's own 7-Zip install, then anything on PATH.
 */
function candidates({ resourcesPath, appPath, env = process.env } = {}) {
  const list = [];
  if (resourcesPath) list.push(path.join(resourcesPath, "7zip", "7z.exe"));
  if (appPath) list.push(path.join(appPath, "vendor", "7zip", "7z.exe"));
  const pf = env.ProgramFiles || "C:\\Program Files";
  const pf86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  list.push(path.join(pf, "7-Zip", "7z.exe"), path.join(pf86, "7-Zip", "7z.exe"));
  for (const dir of String(env.PATH || env.Path || "").split(path.delimiter)) {
    if (dir) list.push(path.join(dir, "7z.exe"));
  }
  return list;
}

function locate(opts = {}) {
  const exists = opts.exists || fs.existsSync;
  for (const c of candidates(opts)) if (exists(c)) return c;
  return null;
}

// ── progress parsing ─────────────────────────────────────────────

/**
 * Returns a feed(chunk) function. 7-Zip -bsp1 emits fragments like
 * "  0%", " 12% 3 - dir\file.txt", "100%", each overwritten with \b or \r.
 * Fragments can be cut mid-number by the pipe, so keep the unterminated tail.
 */
function createProgressParser(onProgress) {
  let tail = "";
  let last = -1;
  return function feed(chunk) {
    const text = tail + chunk;
    const parts = text.split(/[\r\n\b]+/);
    tail = parts.pop() || "";
    // The tail may itself be a complete "NN%" line; report it too but keep it
    // so a following "- file" continuation still attaches.
    const consider = parts.concat(tail);
    for (const frag of consider) {
      const m = /^\s*(\d{1,3})%(?:\s+(\d+))?(?:\s*-\s*(.+))?\s*$/.exec(frag);
      if (!m) continue;
      const percent = Math.min(100, parseInt(m[1], 10));
      const file = m[3] ? m[3].trim() : undefined;
      if (percent !== last || file) {
        last = percent;
        onProgress({ percent, file });
      }
    }
    if (tail.length > 4096) tail = tail.slice(-1024);
  };
}

// ── error classification ─────────────────────────────────────────

/**
 * Turn an exit code + captured output into { kind, message }.
 * kinds: ok | warning | password | corrupt | unsupported | notfound | cancelled | diskfull | fatal
 */
function classify(code, output = "") {
  const out = String(output);
  const line = (rx) => {
    const m = rx.exec(out);
    return m ? m[0].trim() : null;
  };
  if (code === 0) return { kind: "ok", message: "" };
  if (code === 255 || code === null) return { kind: "cancelled", message: "Cancelled" };
  if (/Wrong password|Can not open encrypted archive|Data Error in encrypted file|Enter password/i.test(out)) {
    return { kind: "password", message: "This archive is password-protected." };
  }
  if (code === 1) {
    // Exit 1 is "finished with warnings" (e.g. a file vanished mid-scan). Never fatal.
    return { kind: "warning", message: line(/WARNING:?.*$/m) || "Finished with warnings." };
  }
  if (/There is not enough space on the disk|Disk full|not enough space/i.test(out)) {
    return { kind: "diskfull", message: "The destination disk ran out of space." };
  }
  if (/The system cannot find the (file|path) specified|cannot find archive|No such file/i.test(out)) {
    return { kind: "notfound", message: line(/ERROR:.*$/m) || "File not found." };
  }
  if (/Can not open the file as archive|Is not archive|Unsupported Method|Unsupported command/i.test(out)) {
    return { kind: "unsupported", message: "7-Zip can't open this file as an archive (unsupported format or not an archive)." };
  }
  if (/Headers Error|Unexpected end of (archive|data)|Data Error|CRC Failed|Unavailable data|Unexpected end of file|Unconfirmed start of archive/i.test(out)) {
    return { kind: "corrupt", message: line(/(Headers Error|Unexpected end of \w+|Data Error|CRC Failed|Unavailable data).*$/m) || "The archive is damaged or truncated." };
  }
  if (code === 8) return { kind: "fatal", message: "7-Zip ran out of memory." };
  if (code === 7) return { kind: "fatal", message: "Internal error: bad 7-Zip command line." };
  return { kind: "fatal", message: line(/ERROR:?.*$/m) || line(/System ERROR:?.*$/m) || `7-Zip exited with code ${code}` };
}

// ── list (-slt) parsing ──────────────────────────────────────────

/**
 * Parse `7z l -slt` output into { archive, entries, totals }.
 * entries: { path, size, packed, isDir, encrypted, modified, attributes }
 * totals:  { size, packed, files, dirs, encrypted:boolean }
 */
function parseList(text) {
  const norm = String(text).replace(/\r\n/g, "\n");
  const sep = norm.indexOf("\n----------\n");
  const headerText = sep >= 0 ? norm.slice(0, sep) : norm;
  const bodyText = sep >= 0 ? norm.slice(sep + "\n----------\n".length) : "";

  const archive = {};
  const hdrStart = headerText.lastIndexOf("\n--\n");
  if (hdrStart >= 0) {
    for (const ln of headerText.slice(hdrStart + 4).split("\n")) {
      const m = /^([^=]+?) = (.*)$/.exec(ln);
      if (m) archive[m[1].trim()] = m[2];
    }
  }

  const entries = [];
  for (const block of bodyText.split(/\n\s*\n/)) {
    const kv = {};
    let any = false;
    for (const ln of block.split("\n")) {
      const m = /^([^=]+?) = (.*)$/.exec(ln);
      if (m) {
        kv[m[1].trim()] = m[2];
        any = true;
      }
    }
    if (!any || kv.Path == null) continue;
    const attrs = kv.Attributes || "";
    const isDir = kv.Folder === "+" || /^D/.test(attrs);
    entries.push({
      path: kv.Path,
      size: Number(kv.Size || 0),
      packed: Number(kv["Packed Size"] || 0),
      isDir,
      encrypted: kv.Encrypted === "+",
      modified: kv.Modified || "",
      attributes: attrs,
    });
  }

  const totals = { size: 0, packed: 0, files: 0, dirs: 0, encrypted: false };
  for (const e of entries) {
    if (e.isDir) totals.dirs += 1;
    else {
      totals.files += 1;
      totals.size += e.size;
      totals.packed += e.packed;
    }
    if (e.encrypted) totals.encrypted = true;
  }
  return { archive, entries, totals };
}

/** Single top-level folder name if every entry lives under one, else null. */
function singleRoot(entries) {
  let root = null;
  for (const e of entries) {
    const first = String(e.path).split(/[\\/]/)[0];
    if (!first) return null;
    if (root == null) root = first;
    else if (root !== first) return null;
  }
  if (root == null) return null;
  // The root must itself be a directory entry (or implied by nested paths).
  const hasNested = entries.some((e) => /[\\/]/.test(e.path));
  const rootIsDir = entries.some((e) => e.isDir && e.path === root);
  return hasNested || rootIsDir ? root : null;
}

// ── argument builders (pure, tested) ─────────────────────────────

function passwordArg(password) {
  return `-p${password && password.length ? password : NO_PASSWORD}`;
}

/**
 * Args for `7z a`. items is a list-file path (`@file`) or explicit paths.
 * @param {object} o { type, level, password, headerEncrypt, split, threads }
 */
function addArgs(out, listFile, o = {}) {
  const args = ["a", `-t${o.type || "7z"}`];
  if (o.type === "tar") {
    // tar has no level; -mx is rejected for it
  } else {
    args.push(`-mx=${o.level == null ? 5 : o.level}`);
  }
  args.push(`-mmt=${o.threads ? o.threads : "on"}`);
  if (o.password) {
    args.push(`-p${o.password}`);
    if (o.type === "7z" && o.headerEncrypt !== false) args.push("-mhe=on");
    if (o.type === "zip") args.push("-mem=AES256");
  }
  if (o.split) args.push(`-v${o.split}`);
  if (o.type === "7z" || o.type === "zip" || o.type === "tar") args.push("-snl"); // store symlinks as links, don't follow
  args.push("-ssw"); // include files that are open for writing (logs, etc.)
  args.push(out, `@${listFile}`);
  return args;
}

function extractArgs(archive, outDir, o = {}) {
  const ow = { overwrite: "-aoa", skip: "-aos", rename: "-aou", renameExisting: "-aot" }[o.overwrite || "rename"];
  const args = ["x", archive, `-o${outDir}`, ow, passwordArg(o.password)];
  if (o.type && o.type !== "auto" && o.type !== "split") args.push(`-t${o.type}`);
  return args;
}

function testArgs(archive, o = {}) {
  return ["t", archive, passwordArg(o.password)];
}

function listArgs(archive, o = {}) {
  return ["l", "-slt", archive, passwordArg(o.password)];
}

// ── process runner ───────────────────────────────────────────────

/**
 * Spawn 7z.exe. Resolves with { code, output }. Rejects only on spawn failure.
 * @param {object} o { cwd, onProgress, onOutput, signal, extraEnv }
 */
function run(exe, args, o = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, [...args, ...COMMON], {
      cwd: o.cwd || undefined,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(o.extraEnv || {}) },
    });
    let output = "";
    const feed = createProgressParser((p) => o.onProgress && o.onProgress(p));
    const onData = (buf) => {
      const s = buf.toString("utf8");
      output += s;
      if (output.length > 4 * 1024 * 1024) output = output.slice(-1024 * 1024);
      feed(s);
      if (o.onOutput) o.onOutput(s);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    let aborted = false;
    const abort = () => {
      aborted = true;
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    };
    if (o.signal) {
      if (o.signal.aborted) abort();
      else o.signal.addEventListener("abort", abort, { once: true });
    }

    child.on("error", reject);
    child.on("close", (code) => {
      if (o.signal) o.signal.removeEventListener("abort", abort);
      resolve({ code: aborted ? 255 : code, output });
    });
  });
}

/**
 * Two 7-Zip processes piped together: `7z x <archive> -so | 7z <consumerArgs> -si`.
 * Used to look INSIDE a compound archive (tar.gz -> tar) without a temp file.
 * -so disables the producer's stdout messages by itself; its errors go to stderr.
 */
function runPiped(exe, archive, consumerArgs, o = {}) {
  return new Promise((resolve, reject) => {
    const producer = spawn(exe, ["x", archive, "-so", "-y", passwordArg(o.password), "-bsp0", "-bso0"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const consumer = spawn(exe, [...consumerArgs, "-si", "-y", "-sccUTF-8"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let perr = "";
    const cap = (s) => (output.length > 4 * 1024 * 1024 ? output.slice(-1024 * 1024) : output + s);
    consumer.stdout.on("data", (b) => (output = cap(b.toString("utf8"))));
    consumer.stderr.on("data", (b) => (output = cap(b.toString("utf8"))));
    producer.stderr.on("data", (b) => (perr += b.toString("utf8")));
    producer.stdout.on("error", () => {}); // EPIPE when the consumer closes early
    consumer.stdin.on("error", () => {});
    producer.stdout.pipe(consumer.stdin);
    const abort = () => {
      try { producer.kill(); } catch { /* gone */ }
      try { consumer.kill(); } catch { /* gone */ }
    };
    if (o.signal) o.signal.addEventListener("abort", abort, { once: true });
    let pcode = null;
    let done = 0;
    const finish = (ccode) => {
      if (o.signal) o.signal.removeEventListener("abort", abort);
      // A producer failure (wrong password, damaged outer stream) is the real error.
      if (pcode !== 0 && pcode != null) resolve({ code: pcode, output: `${perr}\n${output}` });
      else resolve({ code: ccode, output: `${output}\n${perr}` });
    };
    let ccode = null;
    producer.on("error", reject);
    consumer.on("error", reject);
    producer.on("close", (c) => { pcode = c; done += 1; if (done === 2) finish(ccode); });
    consumer.on("close", (c) => { ccode = c; done += 1; if (done === 2) finish(ccode); });
  });
}

// ── high-level engine ────────────────────────────────────────────

class SevenZip {
  constructor(exe) {
    if (!exe) throw new Error("7-Zip engine not found");
    this.exe = exe;
  }

  async version() {
    const { output } = await run(this.exe, ["i"]);
    const m = /7-Zip[^\n]*?(\d+\.\d+)/.exec(output);
    return m ? m[1] : "unknown";
  }

  /** @returns {Promise<{archive, entries, totals, physicalSize}>} throws EngineError */
  async list(archive, o = {}) {
    // Compound (tar.gz): list the inner tar through a pipe so entries, sizes
    // and the single-root check reflect the real files, not the one .tar member.
    const res = o.inner
      ? await runPiped(this.exe, archive, ["l", "-slt", `-t${o.inner}`], { password: o.password, signal: o.signal })
      : await run(this.exe, listArgs(archive, o), { signal: o.signal });
    const cls = classify(res.code, res.output);
    if (cls.kind !== "ok" && cls.kind !== "warning") throw new EngineError(cls, res.output);
    const parsed = parseList(res.output);
    parsed.physicalSize = Number(parsed.archive["Physical Size"] || 0);
    return parsed;
  }

  async test(archive, o = {}) {
    const res = await run(this.exe, testArgs(archive, o), { signal: o.signal, onProgress: o.onProgress });
    const cls = classify(res.code, res.output);
    if (cls.kind !== "ok") throw new EngineError(cls, res.output);
    if (!/Everything is Ok/i.test(res.output)) throw new EngineError({ kind: "corrupt", message: "Integrity test did not report OK." }, res.output);
    return true;
  }

  /**
   * Extract `archive` into `outDir`. Handles compound formats (tar.gz -> tar ->
   * files) using `o.tempDir` for the intermediate tar.
   */
  async extract(archive, outDir, o = {}) {
    fs.mkdirSync(outDir, { recursive: true });
    if (!o.inner) {
      return this.#runChecked(extractArgs(archive, outDir, o), o, 0, 100);
    }
    // Compound: pass 1 unwraps the outer stream into a temp folder.
    const temp = fs.mkdtempSync(path.join(o.tempDir || os.tmpdir(), "unpacker-inner-"));
    try {
      await this.#runChecked(extractArgs(archive, temp, { ...o, type: o.type }), o, 0, 35);
      const inner = fs.readdirSync(temp).map((f) => path.join(temp, f))[0];
      if (!inner) throw new EngineError({ kind: "corrupt", message: "Outer stream produced no inner archive." }, "");
      await this.#runChecked(extractArgs(inner, outDir, { ...o, type: o.inner, password: undefined }), o, 35, 100);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
    return true;
  }

  /**
   * Create `out` from the files listed in `listFile` (one path per line, UTF-8).
   * For compound targets (inner: "tar") a temp tar is built first.
   */
  async add(out, listFile, o = {}) {
    if (!o.inner) {
      return this.#runChecked(addArgs(out, listFile, o), o, 0, 100);
    }
    const temp = fs.mkdtempSync(path.join(o.tempDir || os.tmpdir(), "unpacker-tar-"));
    const innerPath = path.join(temp, `${path.basename(out).replace(/\.[^.]+$/, "")}.tar`);
    try {
      await this.#runChecked(addArgs(innerPath, listFile, { ...o, type: o.inner, password: undefined, split: undefined }), o, 0, 50);
      const innerList = path.join(temp, "inner.txt");
      fs.writeFileSync(innerList, `${innerPath}\n`, "utf8");
      await this.#runChecked(addArgs(out, innerList, { ...o, type: o.type, password: undefined, split: undefined }), { ...o, cwd: undefined }, 50, 100);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
    return true;
  }

  async #runChecked(args, o, from, to) {
    const res = await run(this.exe, args, {
      cwd: o.cwd,
      signal: o.signal,
      onOutput: o.onOutput,
      onProgress: o.onProgress ? (p) => o.onProgress({ percent: from + ((to - from) * p.percent) / 100, file: p.file }) : undefined,
    });
    const cls = classify(res.code, res.output);
    if (cls.kind === "ok") return true;
    if (cls.kind === "warning" && o.tolerateWarnings !== false) {
      if (o.onWarning) o.onWarning(cls.message);
      return true;
    }
    throw new EngineError(cls, res.output);
  }
}

class EngineError extends Error {
  constructor(cls, output) {
    super(cls.message || cls.kind);
    this.name = "EngineError";
    this.kind = cls.kind;
    this.output = (output || "").slice(-4000);
  }
}

module.exports = {
  SevenZip,
  EngineError,
  locate,
  candidates,
  run,
  runPiped,
  createProgressParser,
  classify,
  parseList,
  singleRoot,
  addArgs,
  extractArgs,
  testArgs,
  listArgs,
  passwordArg,
  NO_PASSWORD,
  EXIT,
};
