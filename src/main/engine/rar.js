// Optional RAR *creation* through the user's own WinRAR install.
//
// Only rar.exe can write RAR files; its licence forbids redistributing it, so
// this app never bundles it. Extraction of RAR/RAR5 needs nothing extra: 7-Zip
// handles it. If WinRAR isn't installed, "RAR" simply isn't offered as a target.

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { createProgressParser, EngineError } = require("./sevenzip");

function candidates({ env = process.env } = {}) {
  const pf = env.ProgramFiles || "C:\\Program Files";
  const pf86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const list = [path.join(pf, "WinRAR", "Rar.exe"), path.join(pf86, "WinRAR", "Rar.exe")];
  for (const dir of String(env.PATH || env.Path || "").split(path.delimiter)) {
    if (dir) list.push(path.join(dir, "Rar.exe"), path.join(dir, "rar.exe"));
  }
  return list;
}

function locate(opts = {}) {
  const exists = opts.exists || fs.existsSync;
  for (const c of candidates(opts)) if (exists(c)) return c;
  return null;
}

/**
 * Args for `rar a`. -ep1 stores paths relative to each given item (matches
 * 7-Zip's default), -r recurses folders, -hp encrypts names as well as data.
 * @param {object} o { level (0..5), password, split }
 */
function addArgs(out, listFile, o = {}) {
  const args = ["a", "-ep1", "-r", "-y", "-o+", "-idc", `-m${o.level == null ? 3 : o.level}`, "-scul"];
  if (o.password) args.push(`-hp${o.password}`);
  if (o.split) args.push(`-v${o.split}`);
  args.push(out, `@${listFile}`);
  return args;
}

function classify(code, output = "") {
  if (code === 0) return { kind: "ok", message: "" };
  if (code === 255 || code === null) return { kind: "cancelled", message: "Cancelled" };
  if (code === 1) return { kind: "warning", message: "WinRAR finished with warnings." };
  if (/not enough space|disk full/i.test(output)) return { kind: "diskfull", message: "The destination disk ran out of space." };
  const m = /(ERROR|Cannot|No files).*$/m.exec(output);
  return { kind: "fatal", message: m ? m[0].trim() : `WinRAR exited with code ${code}` };
}

class Rar {
  constructor(exe) {
    if (!exe) throw new Error("WinRAR not found");
    this.exe = exe;
  }

  /** `listFile` must be UTF-16LE with BOM (the -scul switch). */
  add(out, listFile, o = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.exe, addArgs(out, listFile, o), {
        cwd: o.cwd || undefined,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      const feed = createProgressParser((p) => o.onProgress && o.onProgress(p));
      const onData = (buf) => {
        const s = buf.toString("utf8");
        output += s;
        if (output.length > 1024 * 1024) output = output.slice(-256 * 1024);
        feed(s);
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      let aborted = false;
      const abort = () => {
        aborted = true;
        try {
          child.kill();
        } catch {
          /* gone */
        }
      };
      if (o.signal) {
        if (o.signal.aborted) abort();
        else o.signal.addEventListener("abort", abort, { once: true });
      }
      child.on("error", reject);
      child.on("close", (code) => {
        if (o.signal) o.signal.removeEventListener("abort", abort);
        const cls = classify(aborted ? 255 : code, output);
        if (cls.kind === "ok" || cls.kind === "warning") resolve(true);
        else reject(new EngineError(cls, output));
      });
    });
  }
}

/** Write a list file the way rar -scul wants it: UTF-16LE with BOM. */
function writeListFile(file, paths) {
  const text = `\ufeff${paths.join("\r\n")}\r\n`;
  fs.writeFileSync(file, Buffer.from(text, "utf16le"));
}

module.exports = { Rar, locate, candidates, addArgs, classify, writeListFile };
