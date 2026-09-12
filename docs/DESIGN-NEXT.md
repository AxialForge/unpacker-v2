# Unpacker V2 — design for the next passes

Status: proposal for review, 2026-09-12.
**Built 2026-09-12:** Phase 1 (1.1–1.10), 2.1 mass extract, 2.5 duplicate
detection, 3.1 icon.
Deviations from the text below: 1.8 keeps state `done` and marks the job
`warned` (amber) instead of a new state; 1.7's long-path wrapping was not
needed (Node's fs already uses extended-length paths on Windows) — only the
UNC free-space fallback via `fsutil` was added.
Each item states the problem, the design (which module, what data, what the
user sees), the edge cases that decide the design, how it's tested, and a
size. Sizes: S = under an hour, M = a few hours, L = a day or more.

Phases are a suggested order, not a dependency chain, except where noted.

---

## Phase 1 — protect long jobs (all S/M, no new UI surface)

### 1.1 Scrub passwords from job snapshots

**Problem.** `JobQueue.#emit` sends `{...job}` including `options.password`
and `options.outPassword` to the renderer on every progress tick. The renderer
never needs them; it only ever *sends* them.

**Design.** `queue.js`: emit a snapshot with `options` filtered through a
`SECRET_KEYS = ["password", "outPassword"]` mask, replaced by `"•"` when set so
the UI can still show "encrypted". `jobs:list` uses the same mask. Retry keeps
the real value inside the queue's own job object. Also stop logging argv in
dev mode when a `-p` argument is present (`sevenzip.run` gets a `redactArgs()`
used by any debug output).

**Edge cases.** Retry-with-password must still work (it patches the internal
job, not the snapshot). The `needs-password` state must not echo a wrong
password back.

**Test.** Unit: a job with a password emits snapshots with `password: "•"`;
retry patch is applied internally; `redactArgs` masks `-pfoo` to `-p•`.

**Size.** S.

### 1.2 Refuse symlink / junction entries by default

**Problem.** The traversal guard checks paths, not entry *types*. An archive
can carry a symlink entry `photos -> C:\Users\me\Documents`, then a file
`photos\evil.txt`. Whether 7-Zip follows it depends on version and privilege;
we shouldn't depend on that.

**Design.** `parseList` already reads `Attributes`; also read the `Symbolic
Link` and `Hard Link` keys 7-Zip prints in `-slt`. Add `entry.link = target |
null` and `totals.links`. `safety.linkEntries(entries)` returns them.
`runner.inspect` refuses with `kind:"unsafe"` and message "contains N link
entries" unless `options.allowLinks || settings.allowLinks`. New Settings
toggle "Allow archives that contain symbolic links (advanced)", off.

On *creation* we already pass `-snl` (store links as links, never follow), so
our own archives can contain links; extracting them later would trip this
guard, which is the correct default — the user opts in.

**Edge cases.** tar archives from Linux commonly carry links; the refusal
message should say the toggle exists. Junctions appear as reparse points with
the `L` attribute in some 7-Zip versions; treat any `L`-attribute entry as a
link.

**Test.** Unit: `parseList` on a fixture with `Symbolic Link = ../x` sets
`link`; `linkEntries` finds it. E2E: build a tar with a symlink (7-Zip can
create one from a real link) and confirm refusal, then success with the toggle.

**Size.** S.

### 1.3 Delete partial outputs on cancel or failure

**Problem.** Cancelling a pack, compress or convert leaves a truncated
archive on disk with a valid-looking name. A later "verify a manifest" would
flag it, but nothing else would.

**Design.** Runner tracks `job.produced = []` (paths it created this run,
including every volume of a split set, using `volumeSiblings`). A `finally`
in each creating job checks `ctx.signal.aborted || failed` and removes every
produced path that was not verified. For chunked packs, chunks that already
passed verify are *kept* and listed in the job's warnings ("kept 3 verified
chunks; removed 1 partial"), because re-running from scratch would waste
hours. The manifest is only written to the output folder after every chunk
verified, so a partial set never has a manifest claiming completeness.

**Edge cases.** Never delete a path that existed before the job started —
`uniquePath` already guarantees we don't overwrite, so "produced" is exactly
"created". With verify off, nothing is "verified", so on cancel everything
produced is removed (documented in the message).

**Test.** E2E: cancel a pack mid-way; assert only verified chunks remain and
no manifest exists; assert a pre-existing file with a colliding name is
untouched.

**Size.** M.

### 1.4 Close confirmation and tray

**Problem.** `window-all-closed` cancels every running job silently.

**Design.** `main.js`: on the window `close` event, if `queue.running > 0`,
`event.preventDefault()` and show a native `dialog.showMessageBox` with
"Keep running in the background / Cancel jobs and quit / Stay". "Background"
hides the window and shows a tray icon (Electron `Tray`) with a tooltip of
running/queued counts and a menu: Open, Cancel all, Quit. When the queue
drains while hidden, a completion toast (item 2.3) fires and the tray stays
until the user opens or quits. New setting "Close button minimizes to tray
while jobs run" that skips the dialog and defaults to Background.

**Edge cases.** Second-instance launches (Explorer verbs) while hidden must
restore the window. `app.quit()` from the tray must cancel jobs first and wait
for 7-Zip children to exit (they die with the parent anyway, but the partial
cleanup of 1.3 must run).

**Test.** Manual (Electron UI). Unit for the tiny "what should close do" state
function.

**Size.** M.

### 1.5 Keep the machine awake during jobs

**Design.** `main.js`: `powerSaveBlocker.start("prevent-app-suspension")`
when the first job starts, `stop()` when the queue drains. Setting "Prevent
sleep while jobs run", default on. Display is allowed to turn off; only
system sleep is blocked.

**Edge cases.** Laptop on battery: still block (the user chose to run the
job) but note it in the queue header ("keeping the PC awake").

**Test.** Manual. Unit: the start/stop decision from queue transitions.

**Size.** S.

### 1.6 Detect cloud-only placeholders (OneDrive / Google Drive Files On Demand)

**Problem.** A placeholder file reads fine but triggers a network download of
the whole file on first byte. Hashing or probing 200 GB of placeholders looks
like a hang.

**Design.** During `analyze.enumerate` and the runner's `sizeOf`, read the
Windows attribute bits: `FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS (0x400000)`,
`RECALL_ON_OPEN (0x40000)`, `OFFLINE (0x1000)`. Node's `fs.stat` doesn't
expose them; use one PowerShell call per job over the *input roots* only
(`Get-ChildItem -Recurse -Attributes Offline,ReparsePoint` is slow) — better:
a tiny probe with `fsutil file queryEA`? Neither is clean. Practical design:
detect the *root* being under a known sync folder (`%OneDrive%`,
`%OneDriveCommercial%`, Google Drive's mounted drive letter via
`GoogleDriveFS` in the volume name) and warn once per job: "This folder is
synced with OneDrive; cloud-only files will download as they are read, which
can take a long time. Mark the folder 'Always keep on this device' first."
Job proceeds. Exact per-file detection is deferred (see Later).

**Test.** Unit: root classification from env vars and a fake volume-name
lookup.

**Size.** S.

### 1.7 UNC and long-path hardening

**Design.** (a) `freeBytes` on a UNC path: test `fsp.statfs("\\\\nas\\share")`
on the real NAS; if it throws, fall back to
`Get-CimInstance Win32_Volume`-free approach: `fsutil volume diskfree <path>`
parsed. (b) Wrap every Node fs call in `takeout.flattenRoot`,
`tidyPhotoSidecars`, `verifyManifest` and `chunker`-fed enumeration with
`safety.longPath()`. (c) Add an integration test that builds a 300-character
nested path and runs extract → flatten → verify.

**Size.** S–M.

### 1.8 Make warnings visible

**Design.** Job state gains `done-with-warnings` (bar amber, badge
"⚠ 3 warnings"). The row's warning block is always expanded in that state.
The queue stats line counts them. `classify` warnings that matter most get
human text: "1 file skipped: it was locked by another program (antivirus?)".

**Test.** Unit: queue transitions to `done-with-warnings` when `ctx.warn` was
called; renderer class mapping.

**Size.** S.

### 1.9 Takeout tgz temp-space check

**Design.** In `runner.takeout`, when `det0.inner` is set, call
`ensureSpace(tempDir, largestPartSize + margin, "unpacking a .tgz part")`
before the loop. **Size.** S.

### 1.10 Manifest privacy option

**Design.** Pack dialog gains "Manifest location: beside the archives and
inside / inside the archives only". With a password and "inside only", the
plain-text file is never written to the output folder; the ID still appears
in the archive names so a later extraction reveals the manifest. Verify a
manifest can then be started from an *archive* instead of a manifest: it
extracts the manifest entry first (7-Zip can extract a single entry by name)
and proceeds. **Size.** M.

---

## Phase 2 — flows

### 2.1 Mass extract dialog

**Problem.** Extracting a mixed folder of ZIP/RAR/7z today means dropping
them and accepting the global extract mode. No nested handling, no cleanup.

**Design.**
- Button "Mass extract a folder…" and an `--extract-all <folder>` Explorer
  verb on Directory. Also offered when a drop contains more than N archives
  in Auto mode ("Extract 14 archives… / just queue them").
- Scan: `scanFolder` (exists) returns entry points; the dialog shows count,
  total size, and a breakdown by type.
- Options:
  - Destination: *each into its own folder next to the archive* (default),
    *all into one folder* (merge, with the Takeout collision policy), *next
    to each archive, no folder* ("here").
  - Nested archives: *leave*, *extract and keep*, *extract and remove*
    (depth cap 3; each nested one becomes its own child job).
  - After success: *keep sources*, *move sources to the Recycle Bin*.
  - Password: one for all (retry still asks per archive).
  - Run sequentially (default on: same disk).
- Implementation: one `extract` job per archive with `options.dest` and a
  `groupId`; the queue gains a *group* concept: `concurrencyOverride: 1` for
  the group, a group summary row ("Mass extract: 9 of 14 done, 1 needs
  password"), and a group-level "after all succeed" hook (Recycle-Bin
  sources, then a `Mass-extract-report.txt`). Nested extraction is a
  post-step of each extract job: `scanFolder(dest)` → child jobs with
  `depth+1`.

**Edge cases.** Sources that failed are never binned. Merge mode with two
archives holding the same path: policy applies (skip/overwrite/keep-both).
A nested archive that is *also* a top-level input (already queued) is
deduped by resolved path (see 2.5).

**Test.** E2E: folder with zip+rar+7z, one containing a nested zip; all three
destination modes; nested on; bin on; one archive corrupted → sources kept.

**Size.** L.

### 2.2 Job history

**Design.** `store.js` gains `history/` (JSON lines, one file per month,
capped at 5 000 entries). On every terminal state the queue appends
`{ id, kind, label, inputs, output, state, startedAt, endedAt, bytes,
warnings, error }` — no passwords. A "History" panel (side sheet) lists
recent jobs with "Show in folder", "Re-run", "Verify" (for packs with a
manifest), and a search box. Export as CSV.

**Test.** Unit: append/rotate/cap; a history entry never contains a secret.

**Size.** M.

### 2.3 Completion notifications

**Design.** Electron `Notification` when (a) a job over 5 minutes finishes,
(b) the queue drains after any job over 1 minute, (c) a job needs a password
while the window is hidden. Click focuses the window. Setting to disable.

**Size.** S. (Depends on nothing; pairs with 1.4.)

### 2.4 Pause

**Design.** Windows has no SIGSTOP; use `NtSuspendProcess` via… no native
code allowed. Practical design: *pause the queue* (don't start new jobs) plus
*pause the running job* by cancelling it and re-queuing it at the front with
`resume` semantics where the job supports it: Takeout resumes by part; mass
extract by archive; pack by verified chunk (1.3 keeps them). Plain
compress/extract restart from scratch and the UI says so before pausing.

**Size.** M.

### 2.5 Duplicate detection

**Design.** `addPaths` keeps a set of resolved, lower-cased input paths for
jobs in `queued`/`running`/`needs-password`; a duplicate is reported as
skipped ("already in the queue"). Finished jobs don't block a re-run.

**Size.** S.

---

## Phase 3 — interface

### 3.1 App icon
Render `assets/icon.svg` to 256/128/64/48/32/16 PNGs and an `.ico` (Node
script using `sharp`? no — keep dev deps native-free: use a tiny pure-JS
ICO writer over PNGs produced once by a browser canvas, checked in). Set
`win.icon` in `electron-builder.yml` and `BrowserWindow.icon`. **S.**

### 3.2 Rate and time remaining
`ctx.progress` already carries percent; the queue records `(t, percent)`
samples and exposes `rateBytesPerSec` (from job `bytes` × Δpercent) and
`etaSeconds` (median of the last 10 rates). Renderer shows "1.2 GB/s · 4 min
left". Hidden until 3 samples exist. **S.**

### 3.3 File associations
Settings toggle "Open archives with Unpacker V2 by double-click": HKCU
`Software\Classes\UnpackerV2.Archive` ProgId + `Applications\Unpacker V2.exe`
+ per-extension `OpenWithProgids`. Never set as *default* silently — Windows
10/11 require the user to confirm defaults via Settings; we register the
ProgId so it appears in "Open with", and open the app's "extract to…"
dialog. **M.**

### 3.4 Keyboard and focus
Escape closes the top modal; Enter triggers its primary button; focus is
trapped inside an open modal and returned to the opener; `Ctrl+O` open
archives, `Ctrl+Shift+O` add folder, `Delete` removes a selected finished
row. Queue rows become focusable with arrow keys. **S.**

### 3.5 Virtualized queue
Above 200 rows, render only visible rows (simple windowing on scroll; no
library). Group rows (2.1) collapse their children by default. **M.**

---

## Later / optional

### 4.1 Recovery data
- **RAR recovery records:** when WinRAR is present and target is RAR, the
  Archival preset adds `-rr5%` (configurable). Verify uses `rar r` to repair.
- **PAR2 for any format:** ship `par2j64.exe` (MultiPar's engine, GPL) or
  `par2cmdline` (GPL) under `vendor/par2`; Archival preset adds "5% recovery
  data" producing `<stem>_<ID>.par2` + volumes beside the set; verify runs
  `par2 verify`, and a "Repair" button runs `par2 repair`. Manifest records
  the par2 file names. **L.**

### 4.2 Duplicate finder from manifests
Pack already hashes; a "Find duplicates" job reads one or more manifests,
groups by sha256, and reports duplicates with sizes and where they live.
Optional: skip duplicates at pack time ("store once, list twice"). **M.**

### 4.3 Headless command line
`--pack <folder> --format 7z --limit 4g --manifest --hash --out <dir>
--quiet`, exit code 0/1, progress on stdout as JSON lines. Runs without a
window (`app.dock`-less, no BrowserWindow) so Task Scheduler can use it.
Needs 1.1's redaction because passwords would appear in scheduler logs.
**M.**

### 4.4 Watch folder
A folder the app watches (chokidar-free: `fs.watch` + debounce); anything
that settles for 60 s gets packed with a saved profile and moved to a
"done" subfolder. Runs only while the app is open (tray). **M.**

### 4.5 Exact cloud-placeholder detection
Per-file attribute read via a PowerShell batch (`[IO.File]::GetAttributes`)
over the enumerated list, chunked 500 paths per call; cost ~1 s per 5 000
files. Only worth it if 1.6's folder-level warning proves insufficient.

---

## Cross-cutting

- **Settings additions** (all in `store.js DEFAULTS`): `allowLinks`,
  `closeToTray`, `preventSleep`, `notify`, `manifestPlacement`,
  `massExtract*` last-used options, `history` cap.
- **Queue schema additions:** `state: done-with-warnings`, `groupId`,
  `produced[]`, rate samples. Snapshots masked (1.1).
- **Docs:** each shipped item adds to CLAUDE.md's lifecycle block and, when
  something bites, to Gotchas.
- **Testing rule stays:** pure logic in `node --test`; engine behaviour in the
  scratch e2e scripts (which should move into `test/e2e/` and run in CI on a
  self-hosted or scheduled job, since GitHub's runner has no WinRAR but does
  have the vendored 7-Zip).

## Suggested order

1. Phase 1 in one pass (about a day): 1.1, 1.2, 1.3, 1.5, 1.8, 1.9, 2.5 are
   small and mechanical; 1.4 and 1.6 follow.
2. 2.1 mass extract (a day), then 2.2 history and 2.3 notifications.
3. 3.1 icon and 3.2 rate/ETA, then tag **v0.1.0** and cut the first release.
4. Everything else on demand.
