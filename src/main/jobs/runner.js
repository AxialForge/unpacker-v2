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
const analyze = require("../analyze");
const chunker = require("../chunker");
const manifestLib = require("../manifest");

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
      case "pack":
        return this.pack(job, ctx);
      case "verify-manifest":
        return this.verifyManifest(job, ctx);
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
      // UNC shares can refuse statfs; ask Windows directly.
      try {
        const { execFile } = require("node:child_process");
        const out = await new Promise((res, rej) => execFile("fsutil", ["volume", "diskfree", dir], { windowsHide: true }, (e, so) => (e ? rej(e) : res(so))));
        const m = /avail(?:able)? free bytes\s*:\s*([\d,]+)/i.exec(out) || /Total free bytes\s*:\s*([\d,]+)/i.exec(out);
        return m ? Number(m[1].replace(/,/g, "")) : null;
      } catch {
        return null; // unknown -> don't block
      }
    }
  }

  /** Warn once per job when inputs sit in a cloud-sync folder (placeholders download on read). */
  warnCloud(paths, ctx) {
    const seen = new Set();
    for (const p of paths) {
      const svc = safety.cloudSyncRoot(p);
      if (svc && !seen.has(svc)) {
        seen.add(svc);
        ctx.warn(`Inputs are in a ${svc} folder. Cloud-only files download as they are read, which can be very slow; mark the folder "Always keep on this device" first if it isn't.`);
      }
    }
  }

  /**
   * Remove archives this job created that never passed a verify. Called from
   * the creating jobs' finally blocks on cancel/failure. Pre-existing files are
   * never touched: uniquePath guarantees "produced" means "created by us".
   */
  discardUnverified(produced, verified, ctx) {
    let removed = 0;
    const done = new Set();
    for (const p of produced) {
      if (verified.has(p) || verified.has(`${p}.001`)) continue;
      if (!fs.existsSync(p)) continue;
      for (const v of volumeSiblings(p)) {
        if (done.has(v.toLowerCase())) continue;
        done.add(v.toLowerCase());
        // 7-Zip may hold the handle for a moment after being killed: retry briefly.
        for (let attempt = 0; attempt < 10; attempt += 1) {
          try {
            fs.rmSync(v, { force: true });
            if (!fs.existsSync(v)) {
              removed += 1;
              break;
            }
          } catch {
            /* retry */
          }
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        }
      }
    }
    if (removed && ctx) ctx.warn(`Removed ${removed} partial output file(s)${verified.size ? `; kept ${verified.size} that had already verified` : ""}.`);
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
        solid: options.solidCap || undefined,
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
    const links = safety.linkEntries(listing.entries);
    if (links.length && !(options.allowLinks || this.settings().allowLinks)) {
      throw new EngineError(
        { kind: "unsafe", message: `Refused: archive contains ${links.length} link entr${links.length === 1 ? "y" : "ies"} (e.g. "${links[0].path}" → ${links[0].target}). Links can point outside the target folder. Turn on "Allow archives that contain links" in Settings if you trust this archive.` },
        ""
      );
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
    const produced = [];
    const verified = new Set();
    let finished = false;
    try {
      this.warnCloud(inputs, ctx);
      ctx.stage("Measuring");
      const { total, capped } = await this.sizeOf(inputs, ctx.signal);
      const outDir = this.outputDirFor(job, inputs[0]);
      fs.mkdirSync(outDir, { recursive: true });
      const stem = safety.safeFileName(job.options.name || this.archiveStem(inputs));
      const out = safety.uniquePath(path.join(outDir, `${stem}${target.ext}`), (p) => fs.existsSync(p) || fs.existsSync(`${p}.001`), { ext: target.ext });
      if (!capped) await this.ensureSpace(outDir, Math.ceil(total * 1.05) + 1024 * 1024, "the new archive");
      if (target.inner && !capped) await this.ensureSpace(tempDir, total + 1024 * 1024, "the temporary tar");

      ctx.stage(`Compressing to ${target.id}`);
      produced.push(out, `${out}.001`); // registered BEFORE creation so a cancel mid-write still cleans up
      const made = await this.createArchive({ out, inputs, target, options: job.options, tempDir, ctx, from: 0, to: this.settings().verify ? 85 : 100 });
      produced.push(made);
      if (this.settings().verify) {
        await this.verify(made, ctx, 85, 100, job.options.password);
        verified.add(made);
      }
      finished = true;
      return { output: made };
    } finally {
      if (!finished) this.discardUnverified(produced, this.settings().verify ? verified : new Set(), ctx);
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
    const producedList = [];
    const verifiedSet = new Set();
    let finished = false;
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
      producedList.push(out, `${out}.001`);
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

      producedList.push(produced);
      const verify = this.settings().verify || job.options.deleteOriginal;
      if (verify) {
        await this.verify(produced, ctx, 88, 100, job.options.outPassword);
        verifiedSet.add(produced);
      }

      if (job.options.deleteOriginal) {
        ctx.stage("Removing original");
        for (const v of volumeSiblings(archive)) await this.trash(v);
      }
      finished = true;
      return { output: produced };
    } finally {
      if (!finished) this.discardUnverified(producedList, verifiedSet, ctx);
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
    if (tempDir && todo.length) {
      // .tgz parts are unwrapped through temp one at a time: room for the biggest one.
      await this.ensureSpace(tempDir, Math.max(...todo.map((p) => p.size)) + 64 * 1024 * 1024, "unpacking a .tgz part");
    }
    this.warnCloud(parts, ctx);
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

  /**
   * Smart compress: enumerate → plan chunks → (hash) → manifest → one archive
   * per chunk → verify. options:
   *   { format, level, solidCap, password, name, outputMode, outputDir,
   *     chunkMode:"chunks"|"volumes"|"none", chunkSize:id, manifest:bool, hash:bool }
   * Chunks are independent archives packed under the limit; a single file
   * bigger than the limit becomes its own volume set (the only way to cut it).
   */
  async pack(job, ctx) {
    const o = job.options;
    const target = this.targetFor(o.format || this.settings().format);
    const tempDir = this.tempDirFor(job);
    const producedList = [];
    const verifiedSet = new Set();
    let finished = false;
    try {
      this.warnCloud(job.inputs, ctx);
      ctx.stage("Listing files");
      const { root, files } = await analyze.enumerate(job.inputs, { signal: ctx.signal });
      if (!files.length) throw new EngineError({ kind: "notfound", message: "Nothing to pack: no files found." }, "");
      const totalBytes = files.reduce((n, f) => n + f.size, 0) || 1;
      const limit = chunker.chunkBytes(o.chunkSize);
      const mode = !limit ? "none" : o.chunkMode || "chunks";
      const splitArg = limit ? `${Math.floor(limit / 1024 ** 2)}m` : undefined;

      // ── plan ──
      let plan;
      if (mode === "chunks") {
        if (!root) throw new EngineError({ kind: "fatal", message: "Independent chunks need all inputs on one drive. Use volumes, or pack each drive separately." }, "");
        const p = chunker.planChunks(files, limit);
        plan = p.chunks.map((c) => ({ files: c.files, bytes: c.bytes, volumes: false }));
        for (const f of p.oversized) plan.push({ files: [f], bytes: f.size, volumes: true });
        if (p.oversized.length) ctx.warn(`${p.oversized.length} file(s) larger than the chunk limit were packed as volume sets (all parts needed to open them).`);
      } else {
        plan = [{ files, bytes: totalBytes, volumes: mode === "volumes" }];
      }
      const count = plan.length;
      plan.forEach((c, i) => {
        c.label = chunker.chunkLabel(i + 1, count);
      });

      // ── names ──
      const outDir = this.outputDirFor(job, job.inputs[0]);
      fs.mkdirSync(outDir, { recursive: true });
      const stem = safety.safeFileName(o.name || this.archiveStem(job.inputs.map((p) => path.resolve(p))));
      const id = o.manifest ? manifestLib.makeId() : null;
      const base = id ? `${stem}_${id}` : stem;
      const exists = (p) => fs.existsSync(p) || fs.existsSync(`${p}.001`);
      const nameFor = (c) => safety.uniquePath(path.join(outDir, `${base}${count > 1 ? `-${c.label}` : ""}${target.ext}`), exists, { ext: target.ext });
      for (const c of plan) c.out = nameFor(c);

      // ── space ──
      await this.ensureSpace(outDir, Math.ceil(totalBytes * 1.02) + 16 * 1024 * 1024, "the new archives");

      // ── hashes (optional, reads everything once more) ──
      let done = 0;
      if (o.manifest && o.hash) {
        ctx.stage("Hashing files (SHA-256)");
        for (const f of files) {
          f.sha256 = await manifestLib.hashFile(f.path, { signal: ctx.signal });
          done += f.size;
          ctx.progress({ percent: (done / totalBytes) * 25, file: f.rel });
        }
      }
      const from0 = o.manifest && o.hash ? 25 : 0;

      // ── manifest (written before packing so it can ride inside every archive) ──
      let manifestPath = null;
      let manifestOut = null;
      if (o.manifest) {
        for (const c of plan) for (const f of c.files) f.chunk = c.label;
        const text = manifestLib.renderManifest({
          id,
          name: stem,
          created: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
          tool: `Unpacker V2 ${o.appVersion || ""}`.trim(),
          format: target.id,
          chunkLimit: o.chunkSize ? `${o.chunkSize} (${mode})` : "none",
          chunks: plan.map((c) => ({ label: c.label, file: path.basename(c.volumes ? `${c.out}.001` : c.out), bytes: c.bytes, volumes: c.volumes })),
          files: files.slice().sort((a, b) => a.chunk.localeCompare(b.chunk) || a.rel.localeCompare(b.rel)),
          hashed: !!o.hash,
        });
        manifestPath = path.join(tempDir, `${base}.manifest.txt`);
        fs.writeFileSync(manifestPath, text, "utf8");
        // "inside" placement: the manifest rides inside every archive but no
        // plain-text copy is left beside them (names stay private when encrypted).
        const placement = o.manifestPlacement || this.settings().manifestPlacement || "beside";
        manifestOut = placement === "inside" ? null : safety.uniquePath(path.join(outDir, `${base}.manifest.txt`), (p) => fs.existsSync(p));
      }

      // ── pack ──
      const verifyOn = this.settings().verify;
      const packTo = verifyOn ? 88 : 100;
      let acc = 0;
      const outputs = [];
      for (const c of plan) {
        ctx.stage(count > 1 ? `Packing ${c.label} (${c.files.length} files, ${safety.fmtBytes(c.bytes)})` : `Compressing to ${target.id}`);
        const inputs = c.files.map((f) => (root ? path.relative(root, f.path) : f.path));
        if (manifestPath) inputs.push(manifestPath); // absolute: stored at the archive root
        producedList.push(c.out, `${c.out}.001`);
        const produced = await this.createArchive({
          out: c.out,
          inputs,
          cwd: root || undefined,
          target,
          options: { ...o, split: c.volumes ? splitArg : undefined },
          tempDir,
          ctx,
          from: from0 + ((acc / totalBytes) * (packTo - from0)),
          to: from0 + (((acc + c.bytes) / totalBytes) * (packTo - from0)),
        });
        outputs.push(produced);
        producedList.push(produced);
        acc += c.bytes;
      }

      // ── verify ──
      if (verifyOn) {
        let vacc = 0;
        for (let i = 0; i < plan.length; i += 1) {
          ctx.stage(count > 1 ? `Verifying ${plan[i].label}` : "Verifying");
          await this.sevenZip.test(outputs[i], { signal: ctx.signal, password: o.password, onProgress: scale(ctx, packTo + ((vacc / totalBytes) * 12), packTo + (((vacc + plan[i].bytes) / totalBytes) * 12)) });
          verifiedSet.add(outputs[i]);
          vacc += plan[i].bytes;
        }
      }
      // The manifest lands beside the archives only once every one of them is in.
      if (manifestPath && manifestOut) fs.copyFileSync(manifestPath, manifestOut);
      finished = true;
      return { output: manifestOut || outputs[0] };
    } finally {
      if (!finished) this.discardUnverified(producedList, verifiedSet, ctx);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  /**
   * Check an archive set against its manifest: every archive present and
   * passing `7z t`; with `deep` (default when hashes exist) each archive is
   * extracted to temp and every file's SHA-256 compared. Writes a report next
   * to the manifest and fails with a summary if anything is off.
   */
  async verifyManifest(job, ctx) {
    let mpath = path.resolve(job.inputs[0]);
    const dir = path.dirname(mpath);
    let pulledDir = null;
    if (!/\.manifest\.txt$/i.test(mpath)) {
      // An archive was given: pull the manifest copy that rides at its root.
      ctx.stage("Reading the manifest inside the archive");
      const listing = await this.sevenZip.list(mpath, { password: job.options.password, signal: ctx.signal });
      const entry = listing.entries.find((e) => /\.manifest\.txt$/i.test(e.path) && !/[\\/]/.test(e.path));
      if (!entry) throw new EngineError({ kind: "unsupported", message: "No manifest found inside that archive. Choose the .manifest.txt file, or an archive made with a manifest." }, "");
      pulledDir = this.tempDirFor(job);
      mpath = await this.sevenZip.extractEntry(mpath, entry.path, pulledDir, { password: job.options.password, signal: ctx.signal });
    }
    const m = manifestLib.parseManifest(fs.readFileSync(mpath, "utf8"));
    if (pulledDir) fs.rmSync(pulledDir, { recursive: true, force: true });
    if (!m.id || !m.chunks.length) throw new EngineError({ kind: "unsupported", message: "That doesn't look like an Unpacker V2 manifest." }, "");
    const deep = job.options.deep == null ? m.hashed : !!job.options.deep && m.hashed;
    const issues = [];
    const lines = [`Unpacker V2 - manifest verification`, `manifest: ${mpath}`, `id: ${m.id}`, `checked: ${new Date().toISOString()}`, `mode: ${deep ? "archive test + SHA-256 of every file" : "archive test only"}`, ""];
    const total = m.chunks.reduce((n, c) => n + c.bytes, 0) || 1;
    let acc = 0;
    const tempDir = deep ? this.tempDirFor(job) : null;
    try {
      for (const c of m.chunks) {
        const file = path.join(dir, c.file);
        const from = (acc / total) * 100;
        const to = ((acc + c.bytes) / total) * 100;
        acc += c.bytes;
        if (!fs.existsSync(file)) {
          issues.push(`MISSING  ${c.label}  ${c.file}`);
          lines.push(`MISSING  ${c.label}  ${c.file}`);
          continue;
        }
        ctx.stage(`Testing ${c.label}`);
        try {
          await this.sevenZip.test(file, { signal: ctx.signal, password: job.options.password, onProgress: scale(ctx, from, deep ? from + (to - from) * 0.4 : to) });
        } catch (err) {
          if (err.kind === "password") throw err;
          issues.push(`DAMAGED  ${c.label}  ${c.file}: ${err.message}`);
          lines.push(`DAMAGED  ${c.label}  ${c.file}: ${err.message}`);
          continue;
        }
        if (!deep) {
          lines.push(`OK       ${c.label}  ${c.file}`);
          continue;
        }
        ctx.stage(`Checking hashes in ${c.label}`);
        const stage = path.join(tempDir, c.label);
        fs.mkdirSync(stage, { recursive: true });
        await this.ensureSpace(tempDir, c.bytes + 16 * 1024 * 1024, "hash verification");
        try {
          await this.sevenZip.extract(file, stage, { password: job.options.password, overwrite: "overwrite", signal: ctx.signal, onProgress: scale(ctx, from + (to - from) * 0.4, from + (to - from) * 0.8) });
          const mine = m.files.filter((f) => f.chunk === c.label);
          let bad = 0;
          for (const f of mine) {
            const p = path.join(stage, ...f.rel.split("/"));
            if (!fs.existsSync(p)) {
              issues.push(`MISSING  ${c.label}  ${f.rel}`);
              bad += 1;
              continue;
            }
            const h = await manifestLib.hashFile(p, { signal: ctx.signal });
            if (f.sha256 && h !== f.sha256) {
              issues.push(`CHANGED  ${c.label}  ${f.rel}`);
              bad += 1;
            }
          }
          lines.push(`${bad ? "BAD" : "OK"}      ${c.label}  ${c.file}: ${mine.length - bad}/${mine.length} files match`);
        } finally {
          fs.rmSync(stage, { recursive: true, force: true });
        }
        ctx.progress({ percent: to });
      }
    } finally {
      if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    }
    lines.push("", issues.length ? `${issues.length} problem(s):` : "Everything matches the manifest.", ...issues);
    const report = path.join(dir, `${safety.safeFileName(m.name)}_${m.id}.verify.txt`);
    fs.writeFileSync(report, `${lines.join("\n")}\n`, "utf8");
    if (issues.length) {
      throw new EngineError({ kind: "corrupt", message: `${issues.length} problem(s), see ${path.basename(report)}: ${issues.slice(0, 3).join("; ")}${issues.length > 3 ? "; …" : ""}` }, "");
    }
    return { output: report };
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
