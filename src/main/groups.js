// Mass-extract groups: a batch of extract jobs with one destination policy.
// Electron-free so the whole flow (including the after-all hook) runs under
// plain node in tests. main.js wires `trash` to shell.trashItem.
//
// Jobs of a group run one at a time when `sequential`. When every job in the
// group (including nested children the runner spawned) has finished:
//   * sources go to the Recycle Bin only if EVERY job succeeded and the user
//     asked for it,
//   * a Mass-extract-report.txt is written next to the archives (or in the
//     merge folder).

const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const { volumeSiblings } = require("./jobs/runner");
const { uniquePath } = require("./safety");

class GroupRegistry extends EventEmitter {
  /**
   * @param {object} deps
   * @param {import('./jobs/queue').JobQueue} deps.queue
   * @param {(p:string)=>Promise<void>} deps.trash
   */
  constructor({ queue, trash }) {
    super();
    this.queue = queue;
    this.trash = trash;
    this.groups = new Map();
    this.seq = 0;
    queue.on("change", (job) => {
      if (job.groupId) this.onActivity(job.groupId);
    });
  }

  /** Called by the runner's spawn() so nested children count toward the group. */
  attach(groupId, jobId) {
    const g = this.groups.get(groupId);
    if (g) g.jobIds.add(jobId);
  }

  /**
   * @param {string[]} paths archive entry points
   * @param {object} options { destMode:"own"|"merge"|"here", mergeDir, overwrite, nested, password, sourcesAfter:"keep"|"trash"|"archival", sequential }
   */
  start(paths, options = {}) {
    this.seq += 1;
    const id = `g${Date.now().toString(36)}${this.seq}`;
    const sources = paths.map((p) => path.resolve(String(p)));
    const mode = options.destMode || "own";
    const mergeDir = mode === "merge" ? path.resolve(options.mergeDir || path.join(path.dirname(sources[0]), "Extracted")) : null;
    const g = { id, label: `Mass extract: ${sources.length} archive${sources.length === 1 ? "" : "s"}`, sources, options: { ...options, mergeDir }, jobIds: new Set(), createdAt: Date.now(), finalized: false, report: null };
    this.groups.set(id, g);
    const added = [];
    for (const p of sources) {
      const j = this.queue.add({
        kind: "extract",
        label: path.basename(p),
        inputs: [p],
        options: {
          password: options.password || undefined,
          overwrite: options.overwrite || undefined,
          nested: options.nested || "leave",
          dest: mode === "merge" ? mergeDir : path.dirname(p),
          extractMode: mode === "own" ? "subfolder" : "here",
        },
        groupId: id,
        sequential: options.sequential !== false,
      });
      g.jobIds.add(j.id);
      added.push(j.id);
    }
    this.onActivity(id);
    return { groupId: id, added };
  }

  summary(id) {
    const g = this.groups.get(id);
    if (!g) return null;
    const jobs = [...g.jobIds].map((jid) => this.queue.get(jid)).filter(Boolean);
    const count = (s) => jobs.filter((j) => j.state === s).length;
    const terminal = jobs.filter((j) => ["done", "failed", "cancelled"].includes(j.state)).length;
    return {
      id: g.id,
      label: g.label,
      total: jobs.length,
      sources: g.sources.length,
      done: count("done"),
      failed: count("failed"),
      cancelled: count("cancelled"),
      running: count("running"),
      queued: count("queued"),
      needsPassword: count("needs-password"),
      finished: jobs.length > 0 && terminal === jobs.length,
      allOk: jobs.length > 0 && count("done") === jobs.length,
      report: g.report,
      mergeDir: g.options.mergeDir,
      archivalDir: g.archivalDir || null,
    };
  }

  list() {
    return [...this.groups.keys()].map((id) => this.summary(id));
  }

  cancel(id) {
    const g = this.groups.get(id);
    if (!g) return false;
    for (const jid of g.jobIds) this.queue.cancel(jid);
    return true;
  }

  remove(id) {
    const g = this.groups.get(id);
    if (!g) return false;
    for (const jid of g.jobIds) this.queue.remove(jid);
    this.groups.delete(id);
    this.emit("change", { id, removed: true });
    return true;
  }

  async onActivity(id) {
    const g = this.groups.get(id);
    if (!g) return;
    const s = this.summary(id);
    if (s.finished && !g.finalized) {
      g.finalized = true;
      await this.#finalize(g, s);
    }
    this.emit("change", this.summary(id));
  }

  async #finalize(g, s) {
    const lines = ["Unpacker V2 - mass extract", new Date().toISOString(), `${s.done} of ${s.total} succeeded${s.failed ? `, ${s.failed} failed` : ""}${s.cancelled ? `, ${s.cancelled} cancelled` : ""}`, ""];
    for (const jid of g.jobIds) {
      const j = this.queue.get(jid);
      if (!j) continue;
      lines.push(`${j.state.padEnd(10)} ${"  ".repeat(j.depth || 0)}${j.inputs[0]}${j.state === "done" ? ` -> ${j.output}` : j.error ? `  (${j.error})` : ""}`);
      for (const w of j.warnings) lines.push(`           ! ${w}`);
    }
    // sourcesAfter: "keep" | "trash" | "archival". (trashSources: true is the old spelling of "trash".)
    const after = g.options.sourcesAfter || (g.options.trashSources ? "trash" : "keep");
    if (after !== "keep") {
      if (s.allOk) {
        let n = 0;
        const archDirs = new Set();
        for (const src of g.sources) {
          try {
            for (const v of volumeSiblings(src)) {
              if (after === "trash") await this.trash(v);
              else {
                const dst = archivalDirFor(v, g.options.mergeDir);
                fs.mkdirSync(dst, { recursive: true });
                archDirs.add(dst);
                await moveTo(v, path.join(dst, path.basename(v)));
              }
              n += 1;
            }
          } catch (err) {
            lines.push(`could not ${after === "trash" ? "bin" : "move"} ${src}: ${err.message}`);
          }
        }
        if (after === "trash") lines.push("", `moved ${n} source file(s) to the Recycle Bin`);
        else {
          g.archivalDir = [...archDirs][0] || null;
          lines.push("", `moved ${n} source file(s) into ${[...archDirs].join(", ")}`);
        }
      } else {
        lines.push("", "sources kept: not every archive succeeded");
      }
    }
    const dir = g.options.mergeDir || path.dirname(g.sources[0]);
    try {
      fs.mkdirSync(dir, { recursive: true });
      g.report = path.join(dir, "Mass-extract-report.txt");
      fs.writeFileSync(g.report, `${lines.join("\n")}\n`, "utf8");
    } catch {
      g.report = null;
    }
  }
}

/**
 * Where a source archive goes under the "archival" option:
 *   <extracted folder>/<parent folder name> - archival/
 * The extracted folder is the merge folder when merging, else the folder the
 * archive was in; the parent folder name is that folder's own name.
 */
function archivalDirFor(src, mergeDir) {
  const parent = path.dirname(src);
  const base = mergeDir || parent;
  const name = path.basename(parent) || "Archives";
  return path.join(base, `${name} - archival`);
}

async function moveTo(src, dst) {
  const target = uniquePath(dst, (p) => fs.existsSync(p));
  try {
    await fs.promises.rename(src, target);
  } catch (err) {
    if (err.code !== "EXDEV") throw err;
    await fs.promises.copyFile(src, target);
    await fs.promises.unlink(src);
  }
  return target;
}

module.exports = { GroupRegistry, archivalDirFor };
