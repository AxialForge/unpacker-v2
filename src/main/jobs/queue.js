// A small job queue with bounded concurrency, cancellation and retry.
// Pure (no Electron, no fs): the actual work is an injected `runJob(job, ctx)`.
//
// Job shape (the renderer receives snapshots of these):
//   { id, kind, label, inputs, options, state, progress, stage, file,
//     error, errorKind, output, warnings, createdAt, startedAt, endedAt }
// states: queued | running | done | failed | cancelled | needs-password

const { EventEmitter } = require("node:events");

let seq = 0;

class JobQueue extends EventEmitter {
  /**
   * @param {(job, ctx:{signal, progress(p), stage(s)}) => Promise<any>} runJob
   * @param {{ concurrency?: number }} opts
   */
  constructor(runJob, opts = {}) {
    super();
    this.runJob = runJob;
    this.concurrency = Math.max(1, opts.concurrency || 2);
    this.jobs = new Map();
    this.controllers = new Map();
    this.order = [];
  }

  setConcurrency(n) {
    this.concurrency = Math.max(1, Number(n) || 1);
    this.#pump();
  }

  /**
   * groupId ties jobs into a batch (mass extract); sequential: true means at
   * most one job of that group runs at a time, whatever the global concurrency.
   */
  /**
   * after: id of a job this one waits for. It starts only when that job is
   * "done" (and inherits its output as input when inputs is empty); if that
   * job fails or is cancelled, this one is cancelled too.
   */
  add({ kind, label, inputs, options = {}, groupId = null, sequential = false, depth = 0, after = null }) {
    seq += 1;
    const id = `j${Date.now().toString(36)}${seq}`;
    const job = {
      id,
      kind,
      label,
      inputs,
      options,
      groupId,
      sequential: !!sequential,
      depth,
      after,
      state: "queued",
      progress: 0,
      stage: "Queued",
      file: "",
      error: "",
      errorKind: "",
      output: "",
      warnings: [],
      createdAt: Date.now(),
      startedAt: null,
      endedAt: null,
    };
    this.jobs.set(id, job);
    this.order.push(id);
    this.#emit(job);
    this.#pump();
    return job;
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.state === "queued" || job.state === "needs-password") {
      this.#finish(job, { state: "cancelled", stage: "Cancelled" });
      return true;
    }
    if (job.state === "running") {
      const c = this.controllers.get(id);
      if (c) c.abort();
      return true;
    }
    return false;
  }

  /** Re-queue a finished/failed job, optionally patching its options (e.g. a password). */
  retry(id, patch = {}) {
    const job = this.jobs.get(id);
    if (!job || job.state === "running" || job.state === "queued") return null;
    Object.assign(job, {
      options: { ...job.options, ...patch },
      state: "queued",
      progress: 0,
      stage: "Queued",
      file: "",
      error: "",
      errorKind: "",
      output: "",
      warnings: [],
      startedAt: null,
      endedAt: null,
    });
    this.#emit(job);
    this.#pump();
    return job;
  }

  remove(id) {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.state === "running") return false;
    this.jobs.delete(id);
    this.order = this.order.filter((x) => x !== id);
    this.emit("removed", id);
    return true;
  }

  clearFinished() {
    for (const id of [...this.order]) {
      const j = this.jobs.get(id);
      if (j && (j.state === "done" || j.state === "failed" || j.state === "cancelled")) this.remove(id);
    }
  }

  list() {
    return this.order.map((id) => this.jobs.get(id)).filter(Boolean);
  }

  get(id) {
    return this.jobs.get(id) || null;
  }

  get running() {
    return this.list().filter((j) => j.state === "running").length;
  }

  get pending() {
    return this.list().filter((j) => j.state === "queued").length;
  }

  #pump() {
    while (this.running < this.concurrency) {
      const runningGroups = new Set(this.list().filter((j) => j.state === "running" && j.sequential && j.groupId).map((j) => j.groupId));
      // resolve dependencies first: cancel dependents of failed/cancelled jobs
      for (const j of this.list()) {
        if (j.state !== "queued" || !j.after) continue;
        const dep = this.jobs.get(j.after);
        if (!dep || dep.state === "failed" || dep.state === "cancelled") this.#finish(j, { state: "cancelled", stage: dep ? `Skipped: "${dep.label}" ${dep.state}` : "Skipped: dependency missing" });
      }
      const next = this.list().find((j) => {
        if (j.state !== "queued") return false;
        if (j.sequential && j.groupId && runningGroups.has(j.groupId)) return false;
        if (j.after) {
          const dep = this.jobs.get(j.after);
          if (!dep || dep.state !== "done") return false;
          if (!j.inputs || !j.inputs.length) j.inputs = [dep.output];
        }
        return true;
      });
      if (!next) break;
      this.#start(next);
    }
  }

  /** Jobs belonging to a group, in queue order. */
  group(groupId) {
    return this.list().filter((j) => j.groupId === groupId);
  }

  #start(job) {
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    job.state = "running";
    job.startedAt = Date.now();
    job.stage = "Starting";
    this.#emit(job);

    let lastEmit = 0;
    const ctx = {
      signal: controller.signal,
      progress: ({ percent, file } = {}) => {
        if (percent != null) job.progress = Math.max(0, Math.min(100, percent));
        if (file != null) job.file = file;
        const now = Date.now();
        if (now - lastEmit > 80 || job.progress >= 100) {
          lastEmit = now;
          this.#emit(job);
        }
      },
      stage: (s) => {
        job.stage = s;
        job.file = "";
        this.#emit(job);
      },
      warn: (msg) => {
        job.warnings.push(String(msg));
      },
    };

    // Start the runner synchronously so its abort listener exists before any
    // caller can cancel() in the same tick.
    let work;
    try {
      work = Promise.resolve(this.runJob(job, ctx));
    } catch (err) {
      work = Promise.reject(err);
    }
    work
      .then((result) => {
        if (controller.signal.aborted) return this.#finish(job, { state: "cancelled", stage: "Cancelled" });
        this.#finish(job, { state: "done", stage: "Done", progress: 100, output: result && result.output ? result.output : job.output });
      })
      .catch((err) => {
        if (controller.signal.aborted || (err && err.kind === "cancelled")) {
          return this.#finish(job, { state: "cancelled", stage: "Cancelled" });
        }
        if (err && err.kind === "password") {
          return this.#finish(job, { state: "needs-password", stage: "Password needed", error: err.message, errorKind: "password" });
        }
        this.#finish(job, {
          state: "failed",
          stage: "Failed",
          error: (err && err.message) || String(err),
          errorKind: (err && err.kind) || "fatal",
        });
      });
  }

  #finish(job, patch) {
    this.controllers.delete(job.id);
    Object.assign(job, patch, { endedAt: Date.now(), file: "" });
    this.#emit(job);
    this.#pump();
  }

  /** Snapshot safe to send anywhere: secrets masked, arrays copied. */
  snapshot(job) {
    return { ...job, options: maskSecrets(job.options), warnings: [...job.warnings] };
  }

  /** list() for the renderer: masked snapshots. */
  listSafe() {
    return this.list().map((j) => this.snapshot(j));
  }

  #emit(job) {
    this.emit("change", this.snapshot(job));
  }
}

const SECRET_KEYS = ["password", "outPassword"];

/** Replace secret option values with "•" (present) or leave absent. */
function maskSecrets(options) {
  const out = { ...(options || {}) };
  for (const k of SECRET_KEYS) if (out[k]) out[k] = "•";
  return out;
}

module.exports = { JobQueue, maskSecrets, SECRET_KEYS };
