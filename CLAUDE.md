# Unpacker V2 — project guide for Claude Code

Windows desktop app (Electron) for creating, extracting, testing and
mass-converting archives by drag-and-drop or by pointing at a folder. It is a
UI and a job queue around the **7-Zip console engine**, which it bundles. It is
**not** a file manager, not a viewer of archive contents, and not a RAR
creator (see non-negotiables). It is deliberately separate from JDot Utilities.

## Non-negotiables (don't regress these)

- **7-Zip is a child process, never a native module.** `vendor/7zip/7z.exe` +
  `7z.dll` are committed and shipped via `extraResources` (outside the asar).
  No `node-7z`, no `libarchive` bindings. This keeps `npm install` working on
  Node 24 (ClangCL trap) and makes CI trivial.
- **7-Zip must never be able to prompt.** stdin is closed and a `-p` switch is
  always passed (`NO_PASSWORD` placeholder when none). A missing/wrong password
  becomes an `EngineError{kind:"password"}` and the job parks in
  `needs-password`; the UI asks and retries. Never remove the placeholder.
- **RAR is extract-only unless WinRAR is installed.** `rar.exe` is never
  bundled (licence). `engine/rar.js` only *locates* it.
- **Nothing destructive before a verify passes.** "Remove original" after
  convert runs only after `7z t` succeeds on the output and goes through
  `shell.trashItem` (Recycle Bin), never `fs.rm`. Temp dirs are the only thing
  hard-deleted, and only our own `UnpackerV2/<jobId>` folders.
- **Refuse hostile archives up front.** `safety.unsafeEntries` (path
  traversal / rooted paths), `safety.linkEntries` (symlinks, junctions) and
  `safety.bombRisk` run on the listing before extraction. The bomb and link
  guards have user toggles; the traversal guard does not.
- **Passwords stay in the main process.** Queue snapshots and `jobs:list`
  go through `maskSecrets` (`"•"`), and anything that logs a 7-Zip command
  line uses `redactArgs`. They still appear on the 7-Zip/WinRAR command line
  while a job runs (no engine offers another way); that is documented, not
  hidden.
- **Nothing half-written survives a cancel.** Creating jobs register their
  planned outputs before spawning 7-Zip and remove whatever didn't verify in
  `discardUnverified`; verified chunks of a pack are kept on purpose.
- **Renderer has no Node access.** `contextIsolation` + `sandbox`; only
  `window.unpacker` from `preload.js`.
- **Pure modules stay pure.** `engine/formats.js`, `safety.js`, `jobs/queue.js`,
  `cli.js`, and the parsers/arg-builders in `engine/sevenzip.js` /
  `engine/rar.js` must run under plain `node --test` with no Electron.
- **Nothing leaves the machine except the update check** (electron-updater to
  GitHub Releases, user-toggleable).

## Commands

```bash
npm install          # Node 22+; Node 24 fine (no native modules)
npm run dev          # from source; add --devtools for the inspector
npm test             # node --test test/**/*.test.js (pure modules)
npm run dist         # dist/unpacker-v2-<ver>-setup.exe, no publish
node scripts/make-icons.js                              # regenerate assets/icon*.png, icon.ico, tray.png
npx electron . --dev --screenshot docs/screenshots      # real captures for the docs (builds sample data, runs jobs)
```

Explorer verbs from the command line (also what the context menu runs):

```
Unpacker.exe --compress <paths...>     --extract-here <archive>
             --extract-to <archive>    --convert <archive>    --test <archive>
```

## Architecture

Main process owns the engine and the queue. Renderer only renders and asks.

```
renderer/app.js --window.unpacker (preload, IPC invoke)--> main.js
   drop zone, options panel,                               ├─ cli.js               argv -> {flag, paths}; single-instance coalescing
   queue rows, password/convert/                           ├─ jobs/queue.js        bounded concurrency, cancel, retry(patch), snapshots
   settings modals                                         ├─ jobs/runner.js       compress/extract/convert/test: inspect → check → work → verify → cleanup
                                                           ├─ engine/formats.js    detectArchive(), TARGETS, LEVELS, SPLIT_SIZES
                                                           ├─ engine/sevenzip.js   locate, spawn, progress parser, classify, parseList, add/extract/test/list
                                                           ├─ engine/rar.js        optional WinRAR creation (locate + add only)
                                                           ├─ takeout.js           Takeout part grouping, flatten, sidecar tidy, resume state (pure-ish)
                                                           ├─ analyze.js           enumerate inputs, classify by bucket, deflate probe, suggest()
                                                           ├─ chunker.js           bin-pack files under a size limit (deepest folders that fit stay whole)
                                                           ├─ manifest.js          8-char ID, render/parse manifest, streaming SHA-256
                                                           ├─ organize.js          Takeout tree -> per-service libraries (Photos dates/EXIF/YearMonth/dedupe)
                                                           ├─ exif.js              minimal JPEG EXIF DateTimeOriginal writer (insert or overwrite in place)
                                                           ├─ scan.js              scanFolder / collectArchives (shared by mass convert, mass extract, nested)
                                                           ├─ groups.js            GroupRegistry: mass-extract batches, sequential run, after-all hook, report
                                                           ├─ safety.js            traversal, bomb ratio, long paths, uniquePath, safeFileName
                                                           ├─ shell-integration.js HKCU context-menu verbs via reg.exe
                                                           ├─ store.js             settings.json in userData
                                                           └─ updater.js           silent electron-updater (template drop-in)
vendor/7zip/                            7z.exe, 7z.dll, License.txt (committed; shipped as resources/7zip)
```

| Path | Purpose |
| --- | --- |
| `src/main/main.js` | Window, IPC handlers, `addPaths()` (paths → jobs), folder scan, CLI dispatch |
| `src/main/jobs/runner.js` | The whole job lifecycle; `volumeSiblings()` for split-set cleanup |
| `src/main/engine/sevenzip.js` | Only place that builds 7-Zip command lines |
| `src/renderer/` | `index.html`, `styles.css`, `app.js` — vanilla, no build step |
| `test/` | One file per pure module |

### Job lifecycle (runner.js)

```
compress: measure inputs → pick output name (uniquePath) → free-space check →
          7z a (@listfile, -snl -ssw) [→ tar then outer for tar.*] → verify → done
extract:  7z l -slt → encrypted? → traversal/bomb guard → dest (smart/subfolder/here)
          → free-space → 7z x [-aou|-aoa|-aos] [compound: two passes] → done
convert:  inspect → extract to <temp>/stage → 7z a from cwd=stage → verify
          → (optional) Recycle-Bin every volume of the source → done
test:     7z t
takeout:  parts (inputs, sorted) → skip parts recorded in <dest>/.unpacker-takeout.json
          → [verifyFirst: 7z t every part, fail by NAME before writing anything]
          → list every part, one free-space check for the whole export
          → 7z x each part into the SAME dest, in order, -aos|-aoa|-aou, state file after each
          → [flatten Takeout/] → [tidy Photos JSON] → [Recycle-Bin parts] → report, clear state
pack:     enumerate (rel to common root) → plan: none | chunks (planChunks, oversized→volumes) | volumes
          → [hash every file] → render manifest to temp → per chunk: 7z a with cwd=root,
          relative paths + the manifest's ABSOLUTE path (lands at archive root) → verify each
          → copy manifest beside the archives. Names: <stem>_<ID>-NNofMM.<ext>, <stem>_<ID>.manifest.txt
verify-manifest: per chunk: exists → 7z t → [deep: extract to temp, SHA-256 every listed file]
          → <stem>_<ID>.verify.txt; fails with a MISSING/DAMAGED/CHANGED summary
```

Mass extract (`groups.js`): `GroupRegistry.start(paths, options)` queues one
`extract` job per archive with `groupId` and `sequential`; the queue's pump
never runs two sequential jobs of one group at once. `runner.afterExtract`
scans the output for nested archives (options.nested `keep|remove`, depth
cap 3) and `spawn`s children into the same group; `removeSelf` bins a nested
archive after its own extraction. When every job (children included) is
terminal the registry bins sources only if ALL succeeded and writes
`Mass-extract-report.txt` in the merge folder or beside the archives.
Dropping three or more archives in Auto mode opens the mass-extract dialog
(`cli:request` type `extract-all`), as does the Explorer folder verb.

Chunks are packed by RAW size with a 0.5% margin; the deepest folder that
fits under the cap travels as one unit (`chunker.planChunks`). Don't group by
the first path segment: for a single dropped folder that segment IS the
folder, and everything gets split file by file (this bit once).

Takeout parts are independent archives that share a `Takeout/` root, NOT a
split set; `takeout.groupTakeout` groups them by the timestamp in the name.
Dropping only Takeout parts in Auto mode opens the Takeout dialog
(`addPaths` sends a `cli:request` of type `takeout`).

Progress is mapped into a 0–100 job bar with `scale(ctx, from, to)`.

### Format detection (engine/formats.js)

`detectArchive(name)` → `{ type, inner?, ext, entryPoint, split, baseName }`.
Continuation volumes (`.002`, `.part2.rar`, `.r00`, `.z01`) are recognised but
`entryPoint:false`, so dropping a whole set opens it once. Compound suffixes
(`.tar.gz` → outer `gzip`, inner `tar`) are matched before bare extensions.

## The extension point: adding a creation target

1. Add an entry to `TARGETS` in `engine/formats.js` (`type` = 7-Zip `-t` name;
   set `inner:"tar"` for stream compressors; flag `encrypt/split/levels`).
2. If the type needs special switches, add them in `sevenzip.addArgs()` — that
   is the only place command lines are built.
3. Add a detection extension in `SINGLE`/`COMPOUND` so the result is recognised
   as an archive.
4. Add a test in `test/formats.test.js`.

Nothing else needs to change: the renderer reads `targets` from `app:info`.

## Gotchas

- **Explorer multi-select launches one process per item.** Handled by the
  single-instance lock + a 400 ms coalescing window in `main.js handleCli()`
  so ten selected files become one archive. Don't shorten the window.
- **7-Zip progress is redrawn with backspaces, not newlines.** Split chunks on
  `[\r\n\b]` and carry the tail; a percentage can be cut in half by the pipe.
  See `createProgressParser` and its test.
- **Exit code 1 is a warning, not a failure.** A file that vanished mid-scan
  yields code 1 with "cannot find the file"; classify() checks the code
  before the not-found regex for exactly this reason.
- **`-v` split output is named `<out>.001`.** `createArchive` returns the first
  volume's real path; verify and the UI link use that.
- **`-snl` only on 7z/zip/tar.** Passing it to gzip/xz single-file passes is
  rejected.
- **Windows 11 shows the entries under "Show more options".** The modern menu
  needs an MSIX-packaged extension; out of scope. HKCU keys, so no admin.
- **A tar.gz extracted into a double-nested, lower-cased folder.** Two causes
  that looked like one: `detectArchive` lower-cases the name for matching and
  used to slice `baseName` from the lower-cased copy; and `7z l x.tar.gz` lists
  the *gzip* layer (one `.tar` member), so the smart single-root check could
  never see the real tree. Fix: `baseName` slices from the original name, and
  `SevenZip.list({inner})` pipes `7z x -so | 7z l -slt -si -ttar` to list the
  inner tar (`runPiped`). Don't "simplify" list() back to a single process.
- **Compress jobs showed no progress at all.** 7-Zip prints `NN% + name`
  while adding and `NN% - name` while extracting; the progress regex only
  accepted `-`, so `a` runs never matched and every e2e "cancel mid-compress"
  quietly relied on a fixed timer. The regex accepts `- + U T A` now; the
  unit test feeds an add line. If progress bars stop moving for one job kind,
  suspect this first.
- **Cleanup on cancel must register outputs BEFORE 7-Zip starts.** A cancel
  kills 7-Zip mid-write, so the "produced" list never receives the return
  value. `compress`/`convert`/`pack` push the planned path (and `<out>.001`)
  before `createArchive`, and `discardUnverified` retries `rm` briefly because
  the handle closes a beat after the kill.
- **A "cancel after 600 ms" test proves nothing.** 16 MB compresses in less
  than that. Cancel on the first progress event of the stage you mean, and
  give the fixture enough bytes to still be running.
- **Link entries in tar/7z.** `parseList` reads `Symbolic Link =` /
  `Hard Link =` and the `L` attribute into `entry.link`; `inspect` refuses
  unless `settings.allowLinks`. Our own tar files carry links because we add
  with `-snl`, so this bites on round-trips too. That is intended.
- **Real Takeout part names carry a set number.** Google writes
  `takeout-<stamp>-2-001.zip` for multi-set exports, and browsers add
  ` (1)` on a re-download. The first regex only matched `-001.zip` and would
  have found nothing in a real download folder. `PART_RX` handles both;
  `groupTakeout` keys by stamp+set and folds re-downloads into `duplicates`.
- **One sidecar can serve several files.** `IMG-edited.JPG` uses
  `IMG.JPG`'s sidecar, so disposing the sidecar per file crashed on the second
  use. Sidecars are collected in a Map and disposed once after the loop.
- **Sidecars whose media isn't there are normal.** Media and its JSON often
  sit in different parts; the organizer must run on the fully merged tree,
  and "orphan sidecars" in the report usually means a part is missing.
- **`--screenshot` (or any dev launch) silently does nothing.** A packaged
  `Unpacker V2.exe` was still running, hidden in the tray, and the
  single-instance lock handed the new launch's argv to it and quit. Dev and
  packaged builds share the lock. `tasklist | findstr /i "electron Unpacker"`
  before wondering why nothing happens.
- **`hidden` did not hide a tab pane.** `.layout { display: grid }` outranks
  the UA `[hidden] { display: none }`, so both tabs rendered at once.
  `styles.css` now has `[hidden] { display: none !important }`; keep it.
- **`.gitignore` ignores `*.exe`.** `vendor/7zip/*.exe|*.dll` are explicitly
  un-ignored at the bottom; don't move those lines above the `*.exe` rule.

## Roadmap (deliberately unbuilt)

- Browse/preview archive contents before extracting.
- `tar.zst` as a creation target (7-Zip creates zstd only in newer builds;
  extraction already works).
- Legacy code-page override for old ZIPs with non-UTF-8 names (`-mcp=`).
- Modern Windows 11 context menu (needs MSIX packaging).
- Portable (no-install) build.
