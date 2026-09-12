const test = require("node:test");
const assert = require("node:assert/strict");
const { JobQueue } = require("../src/main/jobs/queue");

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test("runs at most `concurrency` jobs at once, in order", async () => {
  let active = 0;
  let peak = 0;
  const order = [];
  const q = new JobQueue(
    async (job) => {
      active += 1;
      peak = Math.max(peak, active);
      order.push(job.label);
      await tick(15);
      active -= 1;
      return { output: `out-${job.label}` };
    },
    { concurrency: 2 }
  );
  for (const l of ["a", "b", "c", "d"]) q.add({ kind: "test", label: l, inputs: [l] });
  assert.equal(q.running, 2);
  while (q.list().some((j) => j.state !== "done")) await tick();
  assert.equal(peak, 2);
  assert.deepEqual(order, ["a", "b", "c", "d"]);
  assert.equal(q.get(q.list()[0].id).output, "out-a");
});

test("cancel aborts a running job and drops a queued one", async () => {
  const q = new JobQueue(
    (job, ctx) =>
      new Promise((_res, rej) => {
        ctx.signal.addEventListener("abort", () => rej(Object.assign(new Error("Cancelled"), { kind: "cancelled" })));
      }),
    { concurrency: 1 }
  );
  const a = q.add({ kind: "test", label: "a", inputs: [] });
  const b = q.add({ kind: "test", label: "b", inputs: [] });
  assert.equal(q.get(a.id).state, "running");
  assert.equal(q.get(b.id).state, "queued");
  q.cancel(b.id);
  assert.equal(q.get(b.id).state, "cancelled");
  q.cancel(a.id);
  await tick();
  assert.equal(q.get(a.id).state, "cancelled");
});

test("password errors park the job and retry with a patch re-runs it", async () => {
  const seen = [];
  const q = new JobQueue(async (job) => {
    seen.push(job.options.password);
    if (!job.options.password) throw Object.assign(new Error("needs pw"), { kind: "password" });
    return { output: "ok" };
  });
  const j = q.add({ kind: "extract", label: "x", inputs: ["x.zip"], options: {} });
  await tick();
  assert.equal(q.get(j.id).state, "needs-password");
  assert.equal(q.get(j.id).errorKind, "password");
  q.retry(j.id, { password: "hunter2" });
  await tick();
  assert.equal(q.get(j.id).state, "done");
  assert.deepEqual(seen, [undefined, "hunter2"]);
});

test("failures carry the message; clearFinished keeps active jobs", async () => {
  const q = new JobQueue(async (job) => {
    if (job.label === "bad") throw Object.assign(new Error("Headers Error"), { kind: "corrupt" });
    await tick(30);
    return {};
  });
  const bad = q.add({ kind: "test", label: "bad", inputs: [] });
  const slow = q.add({ kind: "test", label: "slow", inputs: [] });
  await tick();
  assert.equal(q.get(bad.id).state, "failed");
  assert.equal(q.get(bad.id).error, "Headers Error");
  q.clearFinished();
  assert.equal(q.get(bad.id), null);
  assert.equal(q.get(slow.id).state, "running");
  assert.equal(q.remove(slow.id), false, "running jobs can't be removed");
});

test("progress and stage updates are emitted as snapshots", async () => {
  const events = [];
  const q = new JobQueue(async (job, ctx) => {
    ctx.stage("Working");
    ctx.progress({ percent: 50, file: "a.txt" });
    ctx.warn("minor");
    return {};
  });
  q.on("change", (j) => events.push({ ...j }));
  q.add({ kind: "test", label: "p", inputs: [] });
  await tick();
  assert.ok(events.some((e) => e.stage === "Working"));
  assert.ok(events.some((e) => e.progress === 50 && e.file === "a.txt"));
  const last = events.at(-1);
  assert.equal(last.state, "done");
  assert.deepEqual(last.warnings, ["minor"]);
});
