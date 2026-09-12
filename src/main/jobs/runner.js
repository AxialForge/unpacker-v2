// Executes one job (compress / extract / convert / test) end to end.
//
// Every job follows the same shape: inspect -> check (space, safety, password)
// -> do the work -> verify -> clean up. Nothing destructive happens before a
// verify passes, and "delete original" means the Recycle Bin, never unlink.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { detectArchive, TARGETS, LEVELS } = require("../engine/formats");
const { EngineError, singleRoot } = require("../engine/sevenzip");
const rarEngine = require("../engine/rar");
const safety = require("../safety");
const takeout = require("../takeout");

const MAX_WALK_ENTRIES = 250000; // stop estimating input size beyond this; the job still runs

class Runner {
  /**
   * @param {object} deps
   * @param {import('../engine/sevenzip').SevenZip} deps.sevenZip
   * @param {import('../engine/rar').Rar|null} deps.rar
   * @param {() => object} deps.settings   returns the current settings object
   * @param {(p:string) => Promise<void>} deps.trash  move a path to the Recycle Bin
   */
  constructor({ sevenZip, rar, settings, trash }) {
    this.sevenZip = sevenZip;
    this.rar = rar || null;
    this.settings = settings;
    this.trash = trash || (async (p) => fsp.rm(p, { recursive: true, force: true }));
  }

  run(job, ctx) {
    switch (job.kind) {
      case "compress":
        return this.compress(job, ctx);
      case "extract":
        return this.extract(job, ctx);
      case "convert":
        return this.convert(job, ctx);
      case "test":
        return this.test(job, ctx);
      case "takeout":
        return this.takeout(job, ctx);
      default:
        throw new Error(`Unknown job kind: ${job.kind}`);
    }
  }

  // ── helpers ─────────────────────────────────────────────────────

  tempDirFor(job) {
    const root = this.settings().tempDir || os.tmpdir();
    const dir = path.join(root, "UnpackerV2", job.id);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  async freeBytes(dir) {
    try {
      const st = await fsp.statfs(dir);
      return Number(st.bavail) * Number(st.bsize);
    } catch {
      return null; // unknown -> don't block
    }
  }

  async ensureSpace(dir, needed, what) {
    if (!needed) return;
    const free = await this.freeBytes(dir);
    if (free != null && free < needed) {
      throw new EngineError(
        { kind: "diskfull", message: `Not enough free space for ${what}: needs about ${safety.fmtBytes(needed)}, ${safety.fmtBytes(free)} free on ${path.parse(dir).root}` },
        ""
      );
    }
  }

  /** Sum sizes of files under the given paths (folders walked). Capped for huge trees. */
  async sizeOf(paths, signal) {
    let total = 0;
    let count = 0;
    let capped = false;
    const walk = async (p) => {
      if (signal && signal.aborted) throw new EngineError({ kind: "cancelled", message: "Cancelled" }, "");
      if (capped) return;
      let st;
      try {
        st = await fsp.lstat(safety.longPath(p));
      } catch {
        return;
      }
      count += 1;
      if (count > MAX_WALK_ENTRIES) {
        capped = true;
        return;
      }
      if (st.isSymbolicLink()) return;
      if (st.isDirectory()) {
        let names = [];
        try {
          names = await fsp.readdir(safety.longPath(p));
        } catch {
          return;
        }
        for (const n of names) await walk(path.join(p, n));
      } else total += st.size;
    };
    for (const p of paths) await walk(p);
    return { total, count, capped };
  }

  targetFor(id) {
    const t = TARGETS[id];
    if (!t) throw new EngineError({ kind: "fatal", message: `Unknown target format: ${id}` }, "");
    if (t.engine === "rar" && !this.rar) throw new EngineError({ kind: "fatal", message: "RAR creation needs WinRAR installed." }, "");
    return t;
  }

  outputDirFor(job, firstInput) {
    const s = this.settings();
    const mode = job.options.outputMode || s.outputMode;
    const dir = mode === "folder" ? job.options.outputDir || s.outputDir : "";
    return dir || path.dirname(firstInput);
  }

  /** Archive name for a set of inputs: the item's own name, or the parent folder's. */
  archiveStem(inputs) {
    if (inputs.length === 1) {
      const det = detectArchive(inputs[0]);
      const base = path.basename(inputs[0]);
      if (det && det.entryPoint) return det.baseName;
      const ext = path.extname(base);
      return ext && !fs.statSync(inputs[0]).isDirectory() ? base.slice(0, -ext.length) : base;
    }
    const parent = path.basename(path.dirname(inputs[0]));
    return parent && !/^[A-Za-z]:$/.test(parent) ? parent : "Archive";
  }

  async createArchive({ out, inputs, cwd, target, options, tempDir, ctx, from, to }) {
    const level = LEVELS.find((l) => l.id === Number(options.level ?? this.settings().level)) || LEVELS[3];
    const onProgress = scale(ctx, from, to);
    if (target.engine === "rar") {
      const list = path.join(tempDir, "rar-list.txt");
      rarEngine.writeListFile(list, inputs);
      await this.rar.add(out, list, {
        level: level.rar,
        password: options.password || undefined,
        split: options.split || undefined,
        cwd,
        signal: ctx.signal,
        onProgress,
      });
    } else {
      const list = path.join(tempDir, "7z-list.txt");
      fs.writeFileSync(list, `${inputs.join("\r\n")}\r\n`, "utf8");
      await this.sevenZip.add(out, list, {
        type: target.type,
        inner: target.inner,
        level: level.mx,
        password: target.encrypt ? options.password || undefined : undefined,
        headerEncrypt: target.headerEncrypt,
        split: target.split ? options.split || undefined : undefined,
        cwd,
        tempDir,
        signal: ctx.signal,
        onProgress,
        onWarning: (m) => ctx.warn(m),
      });
    }
    // With -v the engine names the first volume "<out>.001"; report that path.
    if (options.split && target.split) {
      const first = `${out}.001`;
      if (fs.existsSync(first)) return first;
      const rarFirst = out.replace(/\.rar$/i, ".part1.rar");
      if (fs.existsSync(rarFirst)) return rarFirst;
    }
    return out;
  }

  async verify(out, ctx, from, to, password) {
    ctx.stage("Verifying");
    await this.sevenZip.test(out, { signal: ctx.signal, onProgress: scale(ctx, from, to), password });
  }

  async inspect(archive, options, ctx, inner) {
    ctx.stage("Reading archive");
    const listing = await this.sevenZip.list(archive, { password: options.password, signal: ctx.signal, inner });
    if (listing.totals.encrypted && !options.password) {
      throw new EngineError({ kind: "password", message: "This archive is password-protected." }, "");
    }
    const bad = safety.unsafeEntries(listing.entries.map((e) => e.path));
    if (bad.length) {
      throw new EngineError({ kind: "unsafe", message: `Refused: archive contains paths that escape the target folder (e.g. "${bad[0]}").` }, "");
    }
    const packed = listing.physicalSize || listing.totals.packed || (await fsp.stat(archive)).size;
    if (!(options.allowHighRatio || this.settings().allowHighRatio) && safety.bombRisk({ packed, size: listing.totals.size })) {
      throw new EngineError(
        { kind: "unsafe", message: `Refused: suspicious compression ratio (${safety.fmtBytes(packed)} expands to ${safety.fmtBytes(listing.totals.size)}). Enable "allow extreme ratios" in Settings if this is expected.` },
        ""
      );
    }
    return listing;
  }

  extractDestFor(archive, listing, options) {
    const s = this.settings();
    const det = detectArchive(archive) || { baseName: path.basename(archive) };
    const base = options.dest || path.dirname(archive);
    const mode = options.extractMode || s.extractMode;
    const exists = (p) => fs.existsSync(p);
    const sub = () => safety.uniquePath(path.join(base, safety.safeFileName(det.baseName)), exists);
    if (mode === "here") return base;
    if (mode === "subfolder") return sub();
    const root = singleRoot(listing.entries);
    if (root && !exists(path.join(base, root))) return base;
    return sub();
  }

  // ── jobs ────────────────────────────────────────────────────────

  async compress(job, ctx) {
    const inputs = job.inputs.map((p) => path.resolve(p));
    for (const p of inputs) if (!fs.existsSync(safety.longPath(p))) throw new EngineError({ kind: "notfound", message: `Missing: ${p}` }, "");
    const target = this.targetFor(job.options.format || this.settings().format);
    const tempDir = this.tempDirFor(job);
    try {
      ctx.stage("Measuring");
      const { total, capped } = await this.sizeOf(inputs, ctx.signal);
      const outDir = this.outputDirFor(job, inputs[0]);
      fs.mkdirSync(outDir, { recursive: true });
      const stem = safety.safeFileName(job.options.name || this.archiveStem(inputs));
      const out = safety.uniquePath(path.join(outDir, `${stem}${target.ext}`), (p) => fs.existsSync(p) || fs.existsSync(`${p}.001`), { ext: target.ext });
      if (!capped) await this.ensureSpace(outDir, Math.ceil(total * 1.05) + 1024 * 1024, "the new archive");
      if (target.inner && !capped) await this.ensureSpace(tempDir, total + 1024 * 1024, "the temporary tar");

      ctx.stage(`Compressing to ${target.id}`);
      const produced = await this.createArchive({ out, inputs, target, options: job.options, tempDir, ctx, from: 0, to: this.settings().verify ? 85 : 100 });
      if (this.settings().verify) await this.verify(produced, ctx, 85, 100, job.options.password);
      return { output: produced };
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  async extract(job, ctx) {
    const archive = path.resolve(job.inputs[0]);
    if (!fs.existsSync(safety.longPath(archive))) throw new EngineError({ kind: "notfound", message: `Missing: ${archive}` }, "");
    const det = detectArchive(archive) || { type: "auto" };
    const listing = await this.inspect(archive, job.options, ctx, det.inner);
    const dest = this.extractDestFor(archive, listing, job.options);
    fs.mkdirSync(dest, { recursive: true });
    await this.ensureSpace(dest, listing.totals.size + 1024 * 1024, "extraction");
    const tempDir = det.inner ? this.tempDirFor(job) : null;
    if (tempDir) await this.ensureSpace(tempDir, listing.totals.size + 1024 * 1024, "the temporary tar");
    try {
      ctx.stage(`Extracting ${listing.totals.files} files`);
      await this.sevenZip.extract(archive, dest, {
        inner: det.inner,
        tempDir,
        password: job.options.password,
        overwrite: job.options.overwrite || this.settings().overwrite,
        signal: ctx.signal,
        onProgress: scale(ctx, 0, 100),
        onWarning: (m) => ctx.warn(m),
      });
      return { output: dest };
    } finally {
      if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  async convert(job, ctx) {
    const archive = path.resolve(job.inputs[0]);
    if (!fs.existsSync(safety.longPath(archive))) throw new EngineError({ kind: "notfound", message: `Missing: ${archive}` }, "");
    const det = detectArchive(archive) || { type: "auto", baseName: path.basename(archive) };
    const target = this.targetFor(job.options.format || this.settings().convertTarget);
    const listing = await this.inspect(archive, job.options, ctx, det.inner);

    const tempDir = this.tempDirFor(job);
    const stage = path.join(tempDir, "stage");
    fs.mkdirSync(stage, { recursive: true });
    try {
      const outDir = this.outputDirFor(job, archive);
      fs.mkdirSync(outDir, { recursive: true });
      const out = safety.uniquePath(path.join(outDir, `${safety.safeFileName(det.baseName)}${target.ext}`), (p) => fs.existsSync(p) || fs.existsSync(`${p}.001`), { ext: target.ext });

      const need = listing.totals.size + 1024 * 1024;
      const sameDrive = path.parse(tempDir).root.toLowerCase() === path.parse(outDir).root.toLowerCase();
      await this.ensureSpace(tempDir, sameDrive ? need * 2 : need, "conversion staging");
      if (!sameDrive) await this.ensureSpace(outDir, need, "the converted archive");

      ctx.stage(`Unpacking ${det.type}`);
      await this.sevenZip.extract(archive, stage, {
        inner: det.inner,
        tempDir,
        password: job.options.password,
        overwrite: "overwrite",
        signal: ctx.signal,
        onProgress: scale(ctx, 0, 45),
        onWarning: (m) => ctx.warn(m),
      });

      const items = fs.readdirSync(stage);
      if (!items.length) throw new EngineError({ kind: "corrupt", message: "The source archive is empty." }, "");

      ctx.stage(`Repacking as ${target.id}`);
      const produced = await this.createArchive({
        out,
        inputs: items, // relative to cwd = stage, so the tree is preserved exactly
        cwd: stage,
        target,
        options: { ...job.options, password: job.options.outPassword },
        tempDir,
        ctx,
        from: 45,
        to: 88,
      });

      const verify = this.settings().verify || job.options.deleteOriginal;
      if (verify) await this.verify(produced, ctx, 88, 100, job.options.outPassword);

      if (job.options.deleteOriginal) {
        ctx.stage("Removing original");
        for (const v of volumeSiblings(archive)) await this.trash(v);
      }
      return { output: produced };
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  /**
   * One Google Takeout export: every part merged into one folder, in order.
   * options: { dest, overwrite:"skip"|"overwrite"|"rename", verifyFirst, flatten,
   *            tidyJson, trashParts, resume }
   * Parts are processed strictly one at a time (they land on the same disk),
   * and a state file in `dest` lets an interrupted run pick up where it left off.
   */
  async takeout(job, ctx) {
    const o = job.options;
    const parts = job.inputs.map((p) => path.resolve(p));
    const dest = path.resolve(o.dest);
    fs.mkdirSync(dest, { recursive: true });
    const report = [];
    const log = (line) => report.push(line);

    // Which parts still need doing?
    const state = o.resume === false ? { done: {} } : takeout.readState(dest);
    const stats = await Promise.all(parts.map((p) => fsp.stat(p)));
    const todo = [];
    parts.forEach((p, i) => {
      if (takeout.partIsDone(state, { path: p }, stats[i])) log(`skip  ${path.basename(p)} (already extracted earlier)`);
      else todo.push({ path: p, size: stats[i].size, st: stats[i] });
    });
    if (!todo.length) {
      log("nothing to do: every part was already extracted");
    }
    const totalBytes = todo.reduce((n, p) => n + p.size, 0) || 1;

    // 1. Verify downloads before writing anything (a truncated part 7 of 12 is
    //    far better found now than after 300 GB of extraction).
    let base = 0;
    if (o.verifyFirst && todo.length) {
      ctx.stage(`Checking ${todo.length} downloads`);
      let acc = 0;
      for (const part of todo) {
        const from = (acc / totalBytes) * 15;
        const to = ((acc + part.size) / totalBytes) * 15;
        try {
          await this.sevenZip.test(part.path, { signal: ctx.signal, onProgress: scale(ctx, from, to) });
        } catch (err) {
          throw new EngineError({ kind: err.kind || "corrupt", message: `${path.basename(part.path)} failed its integrity check (${err.message}). Re-download that part from Google, then run again; finished parts are skipped.` }, err.output);
        }
        acc += part.size;
      }
      base = 15;
    }

    // 2. Size everything up front so the space check covers the WHOLE export.
    ctx.stage("Measuring export");
    let need = 0;
    const det0 = todo.length ? detectArchive(todo[0].path) : null;
    for (const part of todo) {
      const listing = await this.sevenZip.list(part.path, { signal: ctx.signal, inner: det0 && det0.inner });
      const bad = safety.unsafeEntries(listing.entries.map((e) => e.path));
      if (bad.length) throw new EngineError({ kind: "unsafe", message: `${path.basename(part.path)} contains an unsafe path ("${bad[0]}")` }, "");
      part.files = listing.totals.files;
      need += listing.totals.size;
    }
    await this.ensureSpace(dest, need + 64 * 1024 * 1024, "the merged export");
    log(`export needs about ${safety.fmtBytes(need)} in ${dest}`);

    // 3. Extract parts strictly in order, each merged into the same folder.
    let acc = 0;
    const tempDir = det0 && det0.inner ? this.tempDirFor(job) : null;
    try {
      for (const part of todo) {
        const from = base + 5 + ((acc / totalBytes) * 75);
        const to = base + 5 + (((acc + part.size) / totalBytes) * 75);
        ctx.stage(`Extracting ${path.basename(part.path)} (${todo.indexOf(part) + 1}/${todo.length}, ${part.files} files)`);
        await this.sevenZip.extract(part.path, dest, {
          inner: det0 && det0.inner,
          tempDir,
          overwrite: o.overwrite || "skip",
          signal: ctx.signal,
          onProgress: scale(ctx, from, to),
          onWarning: (m) => ctx.warn(`${path.basename(part.path)}: ${m}`),
        });
        state.done[path.basename(part.path)] = { size: part.st.size, mtimeMs: part.st.mtimeMs, at: new Date().toISOString() };
        takeout.writeState(dest, state);
        log(`done  ${path.basename(part.path)}: ${part.files} files`);
        acc += part.size;
      }
    } finally {
      if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    }

    // 4. Post-processing, only after every part is in.
    if (o.flatten) {
      ctx.stage("Removing the Takeout wrapper folder");
      const r = takeout.flattenRoot(dest);
      log(`flattened Takeout/: moved ${r.moved} items${r.skipped ? `, left ${r.skipped} that already existed` : ""}`);
    }
    if (o.tidyJson) {
      ctx.stage("Tidying Google Photos JSON sidecars");
      const r = takeout.tidyPhotoSidecars(dest);
      log(`moved ${r.moved} JSON sidecars into _json folders`);
    }
    if (o.trashParts) {
      ctx.stage("Moving the downloaded parts to the Recycle Bin");
      for (const p of parts) await this.trash(p);
      log(`moved ${parts.length} part files to the Recycle Bin`);
    }
    takeout.clearState(dest);
    fs.writeFileSync(path.join(dest, "Takeout-import-report.txt"), `Unpacker V2 - Google Takeout import\n${new Date().toISOString()}\n\n${report.join("\n")}\n`);
    ctx.progress({ percent: 100 });
    return { output: dest };
  }

  async test(job, ctx) {
    const archive = path.resolve(job.inputs[0]);
    ctx.stage("Testing");
    await this.sevenZip.test(archive, { password: job.options.password, signal: ctx.signal, onProgress: scale(ctx, 0, 100) });
    return { output: archive };
  }
}

/** Progress mapped into [from, to] of the job's overall bar. */
function scale(ctx, from, to) {
  return ({ percent, file }) => ctx.progress({ percent: from + ((to - from) * (percent || 0)) / 100, file });
}

/** Every file that belongs to a split set, so "delete original" removes all volumes. */
function volumeSiblings(archive) {
  const dir = path.dirname(archive);
  const name = path.basename(archive);
  const lower = name.toLowerCase();
  let rx = null;
  let stem = null;
  if (/\.001$/.test(lower)) {
    stem = name.slice(0, -4);
    rx = /\.\d{3}$/i;
  } else if (/\.part0*1\.rar$/.test(lower)) {
    stem = name.replace(/\.part0*1\.rar$/i, "");
    rx = /\.part\d+\.rar$/i;
  } else if (/\.rar$/.test(lower)) {
    stem = name.slice(0, -4);
    rx = /\.r\d\d$/i;
  } else if (/\.zip$/.test(lower)) {
    stem = name.slice(0, -4);
    rx = /\.z\d\d$/i;
  }
  const out = [archive];
  if (!rx) return out;
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    if (n === name) continue;
    if (n.toLowerCase().startsWith(stem.toLowerCase()) && rx.test(n.slice(stem.length))) out.push(path.join(dir, n));
  }
  return out;
}

module.exports = { Runner, volumeSiblings, scale };
