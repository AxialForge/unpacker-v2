// Builds RELEASE_OVERVIEW.docx and DEVELOPER_GUIDE.md / DEVELOPER_GUIDE.docx.
//   node docs/_tools/build_reports.js [outDir]
// then to_pdf.py on the two .docx files (DEVELOPER_GUIDE.docx exists only to make the PDF).

const fs = require("node:fs");
const path = require("node:path");
const { toDocx, toMarkdown } = require("./doclib");

const ROOT = path.resolve(__dirname, "..", "..");
const pkg = require(path.join(ROOT, "package.json"));
const lock = require(path.join(ROOT, "package-lock.json"));
const OUT = path.resolve(process.argv[2] || path.join(ROOT, "docs", "release-package", pkg.version));
const facts = JSON.parse(fs.readFileSync(path.join(OUT, "runtime_facts.json"), "utf8"));
const lv = (name) => (lock.packages[`node_modules/${name}`] || {}).version || "UNVERIFIED";
const today = new Date().toISOString().slice(0, 10);

function builder() {
  const B = [];
  return { B, h1: (t) => B.push({ h: 1, t }), h2: (t) => B.push({ h: 2, t }), h3: (t) => B.push({ h: 3, t }), p: (t) => B.push({ p: t }), ul: (a) => B.push({ ul: a }), ol: (a) => B.push({ ol: a }), code: (t) => B.push({ code: t }), note: (t) => B.push({ note: t }), table: (head, rows, widths, small = true) => B.push({ table: { head, rows, widths, small } }) };
}

// ═════════════ RELEASE & SYSTEM OVERVIEW ═════════════
function overview() {
  const { B, h1, h2, p, ul, ol, code, note, table } = builder();

  h1("1. What the software is");
  p("Unpacker V2 is a Windows desktop application for creating, extracting, testing and converting archive files, built as a job queue and user interface around the 7-Zip command-line engine, which it bundles.");
  h2("1.1 Who it is for");
  p("A single person on their own Windows computer who handles large or numerous archives and wants the work to be safe to walk away from: someone downloading a Google Takeout export of several hundred gigabytes, cleaning up a folder of mixed ZIP and RAR files, or packing photo, video and document collections for long-term storage.");
  h2("1.2 The problem it solves");
  ul([
    "**Bulk work.** Extracting or converting dozens of archives one at a time by hand is slow and error-prone. Mass extract and Mass convert handle a whole folder with one set of choices, a report, and a rule that sources are only removed when everything succeeded.",
    "**Google Takeout.** Google delivers an export as many independent archives that share one folder, repeats photos across albums, and stores dates in separate JSON files. The Takeout wizard checks the downloads, merges them, and reorganises the result into per-service libraries with dates applied and duplicates removed.",
    "**Archival.** Smart compress suggests a format from the actual content, splits output into independent archives under a size limit, and writes a manifest with checksums so the set can be verified years later.",
    "**Safety.** Hostile archives (path traversal, links, extreme ratios) are refused before extraction; nothing is deleted outright (the Recycle Bin is used); half-written archives are removed on cancel; the computer is kept awake during long jobs.",
  ]);
  h2("1.3 What it deliberately is not");
  ul(["Not a file manager and not a viewer of archive contents.", "Not a creator of RAR files on its own: RAR creation is offered only through an installed WinRAR, whose licence forbids bundling.", "Not a networked product: there are no accounts, no telemetry and no server. The only network use is the update check."]);

  h1("2. Architecture");
  p("Two processes. The main process (Node) owns the engines, the queue and every file operation. The renderer process is a sandboxed page with no Node access; it talks to the main process only through the `window.unpacker` bridge defined in `preload.js`.");
  B.push({ img: path.join(OUT, "architecture.png"), caption: "Modules, data flow, storage and external services (source: architecture.mmd)" });
  h2("2.1 Modules");
  table(
    ["Module", "Responsibility"],
    [
      ["src/main/main.js", "Window, 43 request handlers, the unp:// media protocol for the Library page, finished-job notification and history, command-line dispatch, tray, close question, sleep blocker, development screenshot mode"],
      ["src/main/preload.js", "The only bridge to the page: `window.unpacker`"],
      ["src/main/jobs/queue.js", "Job queue: bounded concurrency, cancel, retry, sequential groups, job dependencies, password masking in snapshots"],
      ["src/main/jobs/runner.js", "Executes each job kind: compress, extract, convert, test, takeout, organize, pack, verify-manifest, snapchat; cleans up partial output; per-file cloud placeholder check"],
      ["src/main/groups.js", "Mass-extract batches: summary, clean-up of sources, report"],
      ["src/main/organize.js, exif.js", "Google Takeout library organiser with a resumable checkpoint; JPEG EXIF date and position writer"],
      ["src/main/snapchat.js, snapchat-account.js", "Snapchat My Data: part grouping, record matching by timestamp, Memories library; chats, chat media, snaps, friends, stories, location, account sections merged across exports"],
      ["src/main/library.js", "Library page data: roots by id, safe path resolution, folder listing, text reading, name search"],
      ["src/main/exportlog.js", "Optional What's in here.txt and Contents.csv for a mass result"],
      ["src/main/engine/sevenzip.js", "Locates and runs 7z.exe; parses progress and listings; classifies errors"],
      ["src/main/engine/rar.js", "Locates and runs the user's Rar.exe for RAR creation"],
      ["src/main/engine/formats.js", "Archive type detection and the list of creation targets, levels and split sizes"],
      ["src/main/analyze.js, chunker.js, manifest.js", "Content analysis and suggestion; size-limited grouping; manifest and checksums"],
      ["src/main/takeout.js, scan.js, safety.js", "Takeout part grouping and resume state; folder scan; safety guards and path helpers"],
      ["src/main/store.js", "Settings file"],
      ["src/main/shell-integration.js", "Explorer right-click entries (registry)"],
      ["src/main/updater.js", "Silent update from GitHub Releases"],
      ["src/renderer/", "index.html, styles.css, app.js, takeout-tab.js, snapchat-tab.js, library-tab.js: plain HTML, CSS and JavaScript with no build step"],
    ],
    [3200, 6160]
  );
  h2("2.2 Data flow of one job");
  ol(["The page sends a request (for example `jobs:addPaths`) through the bridge.", "`main.js` turns paths into job descriptions and adds them to the queue.", "The queue starts a job when a slot is free and hands it to the runner with a cancel signal and progress callbacks.", "The runner lists the archive, applies the safety checks and free-space check, then starts `7z.exe` as a child process.", "Progress text from the engine is parsed and sent to the page as job snapshots (`jobs:change`), with passwords masked.", "On success the output path is recorded; on cancel or failure anything half-written is removed."]);
  h2("2.3 Storage");
  table(["What", "Where", "Format"], [["Settings", "%APPDATA%\\Unpacker V2\\settings.json", "JSON, one object"], ["Scratch space", "<temporary folder>\\UnpackerV2\\<job id>", "Files; removed when the job ends"], ["Takeout resume state", "<destination>\\.unpacker-takeout.json", "JSON; removed when the export completes"], ["Organize checkpoint", "<library>\\.unpacker-organize.json", "JSON (placed-file hashes, album index, counts); removed when organising completes"], ["Job history (optional)", "%APPDATA%\\Unpacker V2\\history.jsonl", "One JSON object per line; off by default"], ["Reports", "Next to the results", "Text files: Mass-extract-report.txt, Takeout-import-report.txt, Takeout-organize-report.txt, Snapchat library report.txt, What's in here.txt + Contents.csv, <name>_<ID>.verify.txt"], ["Manifests", "Next to and inside archives", "Tab-separated text"], ["Explorer entries", "Registry, HKEY_CURRENT_USER\\Software\\Classes", "Registry keys"], ["Job queue", "Memory only", "Lost on exit"]], [2200, 3900, 3260]);
  p("There is no database.");
  h2("2.4 External services");
  table(["Service", "Used for", "When"], [["GitHub Releases (github.com/AxialForge/unpacker-v2)", "Update check and download", "At start-up, every six hours, and on “Check for updates now”; never when run from source or when NO_AUTO_UPDATE is set"], ["Default web browser", "Opening the five links on the About page", "On click; https only"]], [3600, 2600, 3160]);

  h1("3. Technology and dependencies");
  table(
    ["Component", "Version", "Role", "Source of the version"],
    [
      ["Electron", lv("electron"), "Application shell (Chromium " + facts.versions.chrome + ", Node " + facts.versions.node + ")", "package-lock.json; running application"],
      ["electron-builder", lv("electron-builder"), "Packaging and NSIS installer (development dependency)", "package-lock.json"],
      ["electron-updater", lv("electron-updater"), "Update client (the only runtime dependency)", "package-lock.json"],
      ["7-Zip", "26.03 (x64)", "Compression engine, bundled as vendor/7zip/7z.exe and 7z.dll", "7z.exe banner; About page"],
      ["WinRAR", "not bundled", "Optional, for RAR creation only", "Detected at run time"],
      ["Node.js for building", "22 in continuous integration; 24.18.0 on the build machine", "Tooling", ".github/workflows; node -v"],
      ["Language", "JavaScript (CommonJS), HTML, CSS", "No TypeScript, no bundler, no native modules", "Source"],
    ],
    [1900, 1900, 3400, 2160]
  );
  p("Full pinned list of every package: `deps/pinned-versions.txt` in the reconstruction archive, generated from `package-lock.json`.");

  h1("4. Release process as it works today");
  h2("4.1 Versioning and branches");
  ul(["Semantic versioning. The version lives in one place: `package.json`.", "One branch, `main`. Work is committed straight to it.", "A release is a commit titled “Release X.Y.Z: …” that bumps `package.json` and `CHANGELOG.md` together, followed by a tag `vX.Y.Z` on that commit.", "Commit messages are imperative with no prefixes; authored as AxialForge."]);
  h2("4.2 Steps");
  code(["# 1. bump the version and the changelog in one commit", `git commit -am "Release ${pkg.version}: <summary>"`, "# 2. tag and push", `git tag v${pkg.version}`, "git push origin main", `git push origin v${pkg.version}`].join("\n"));
  h2("4.3 Continuous integration");
  p("GitHub Actions, workflow `.github/workflows/node-electron-release.yml`, triggered by a pushed tag matching `v*` or manually. One job on `windows-latest`:");
  ol(["Check out the repository.", "Set up Node 22 with the npm cache.", "`npm ci`", "`npm test` — the build stops here if a test fails.", "`npm run build:win -- --publish never` — electron-builder produces the installer.", "Upload `dist/*.exe` as a workflow artifact.", "On a tag only: attach `dist/*.exe`, `dist/latest.yml` and `dist/*.blockmap` to a GitHub Release with generated notes."]);
  h2("4.4 Packaging");
  ul(["electron-builder, configuration in `electron-builder.yml`. Target: NSIS, x64.", "One-click, per-user installer (`oneClick: true`, `perMachine: false`): no wizard, no administrator prompt, desktop and Start menu shortcuts.", "Artifact name: `unpacker-v2-<version>-setup.exe`.", "The 7-Zip engine is copied outside the application archive to `resources/7zip` (`extraResources`) so it can be started as a process.", "Application files packed: `src/**`, `assets/icon.png`, `assets/tray.png`, `package.json`."]);
  h2("4.5 Signing");
  p("None. The workflow passes `CSC_LINK` and `CSC_KEY_PASSWORD` secrets to the build step, but the repository has no secrets defined (verified with `gh secret list`), so the installer is unsigned and Windows SmartScreen warns on first run.");
  h2("4.6 Publication and updates");
  ul(["Artifacts are published on the GitHub Releases page of the public repository AxialForge/unpacker-v2.", "The project site (GitHub Pages, served from `docs/`) links to the latest release.", "Update mechanism: electron-updater reads `latest.yml` from the latest release, downloads the installer in the background, verifies its SHA-512 against `latest.yml`, and installs silently when the application quits. Downgrades and pre-releases are not accepted.", "The three files `latest.yml`, the installer and its `.blockmap` must all be present in a release or the updater finds nothing."]);

  h1("5. Version history");
  p("Dates are the publication time of each GitHub Release (Coordinated Universal Time). The changelog file dates 0.2.0 to 0.2.3 as 13 September 2026 and 0.1.0 as 12 September 2026; the tags were created on 12 and 13 September local time. 0.3.0 and 0.4.0 are dated as in the changelog.");
  table(
    ["Version", "Date", "Highlights", "Breaking changes"],
    [
      ["0.1.0", "2026-09-13", "First public build: create, extract, test and mass convert; 7z, ZIP, tar formats and RAR through WinRAR; Google Takeout quick merge; Smart compress with size limits and manifests; verify a manifest; long-job protection (close question, tray, sleep blocker, partial-output clean-up); security guards; mass extract; Explorer entries; silent updates", "None (first release)"],
      ["0.2.0", "2026-09-13", "Google Takeout page with a four-step wizard and the library organiser (dates from JSON, EXIF dates, Year/Month folders, duplicate removal, per-service libraries); multi-set part names and re-downloads recognised; job dependencies in the queue", "None"],
      ["0.2.1", "2026-09-13", "Sidebar layout replaces the top tabs; Settings becomes a page with an Updates section; About page", "None for data. The Settings dialog no longer exists; settings moved to a page."],
      ["0.2.2", "2026-09-13", "Mass extract: sources can be moved into a “<folder name> - archival” folder", "None. The option name changed internally from `trashSources` to `sourcesAfter`; the old name is still accepted."],
      ["0.2.3", "2026-09-13", "Progress, elapsed time and current file for every phase of Takeout organising; cancel works during service moves", "None"],
      ["0.3.0", "2026-10-06", "Snapchat page: a four-step wizard for “My Data” exports; several exports of one account combined; Memories library with EXIF date and position; chats, chat media, snaps, friends, stories, location and account sections organised; optional export log (What's in here.txt, Contents.csv) for mass results; installer packs every icon", "None"],
      ["0.4.0", "2026-10-08", "Library page (read-only visual directory with thumbnails and a preview); Takeout organise resumes after a cancel; Settings, Privacy: finish notifications and job history, both off; per-file cloud placeholder check; wrapped option labels fixed; no hidden Alt menu; Escape, Enter and focus in dialogs", "None"],
    ],
    [900, 1200, 5260, 2000]
  );

  h1("6. Known limitations");
  h2("6.1 Defects found while preparing this package");
  table(
    ["Finding", "Evidence", "Effect"],
    [
      ["Video thumbnails depend on Windows codecs", "The Library page asks Windows for thumbnails (`nativeImage.createThumbnailFromPath`). A video in a format Windows has no decoder for shows an icon instead.", "Cosmetic. The preview still plays MP4, M4V, WebM and MOV through Chromium's own decoders."],
      ["Version shown as the Electron version when run from source", "`app.getVersion()` returns Electron's version in a source checkout; the sidebar and Settings read 44.3.0 in the screenshots.", "Source runs only. The installed build shows the real version."],
    ],
    [2400, 4160, 2800]
  );
  h2("6.2 By design or not yet built");
  ul([
    "Passwords are passed to the engine on its command line, so they are visible to other programs on the same computer that can list processes, for the duration of a job. Neither 7-Zip nor WinRAR offers another way.",
    "The job queue is not saved; closing the application forgets the list of finished jobs.",
    "No pause; a job can only be cancelled. Takeout extraction and organising resume; other jobs start again.",
    "The per-file cloud placeholder check runs through PowerShell and only for inputs inside a known sync folder; if PowerShell is unavailable the older folder-level warning is shown.",
    "A position is not written into Snapchat video files; overlays are kept beside their photo, not burned into it.",
    "The job history, when on, records input and output paths in plain text in the profile folder.",
    "On Windows 11 the Explorer entries appear only under “Show more options”.",
    "No code signing.",
    "tar.zst is extract-only; legacy code pages for old ZIP file names are not selectable.",
    "EXIF dates are written only into JPEG files, and only when the file has no EXIF block or already has the date fields.",
    "The hidden Electron menu (Alt) exposes Reload and Developer Tools to end users.",
  ]);
  h2("6.3 Roadmap items recorded in the repository");
  p("From `docs/DESIGN-NEXT.md` and the roadmap section of `CLAUDE.md`. There are no open GitHub issues and no TODO or FIXME comments in the source (searched).");
  ul(["Job history that survives a restart; completion notifications; pause.", "Rate and time remaining on jobs; keyboard handling in dialogs; file associations; a virtualised queue for very long lists.", "Recovery data (WinRAR recovery records or PAR2); duplicate finder across manifests; headless command line; watch folder.", "Browse archive contents before extracting; tar.zst creation; modern Windows 11 context menu; portable build."]);

  h1("7. Open questions");
  ul(["UNVERIFIED: behaviour on Windows 10.", "UNVERIFIED: whether continuous integration and a local build produce byte-identical installers (not expected; no reproducible-build settings).", "UNVERIFIED: the installed build was not launched during this documentation pass; the missing-image finding is from the packed file list, not from a screenshot of the installed application.", "The publication dates above come from the GitHub Releases listing; the changelog and tag dates differ by time zone."]);

  return { title: "Unpacker V2", subtitle: "Release and System Overview", version: pkg.version, coverLines: [`**Version** ${pkg.version}`, "**Release tag** v" + pkg.version + " (commit aca332e)", `**Document date** ${today}`, "**Repository** https://github.com/AxialForge/unpacker-v2"], blocks: B };
}

// ═════════════ DEVELOPER & REBUILD GUIDE ═════════════
function devguide(build) {
  const { B, h1, h2, p, ul, ol, code, note, table } = builder();

  h1("1. Rebuild on a clean machine");
  p("Verified on " + today + " by exporting the release tag into an empty folder and running the commands below. Result: " + build.result + ".");
  table(["Requirement", "Version used in the verification", "Notes"], [["Operating system", "Windows 11 Pro, build 26200, x64", "The installer target is Windows only"], ["Node.js", build.node, "`package.json` requires 22 or newer; continuous integration uses 22"], ["npm", build.npm, "Ships with Node"], ["Git", "2.53", "Only to fetch the source"], ["Compiler toolchain", "none", "There are no native modules, so no Visual Studio build tools are needed"], ["Network", "required once", "`npm ci` downloads packages and the Electron binary; electron-builder downloads NSIS on first use"]], [2200, 3200, 3960]);
  code(["git clone https://github.com/AxialForge/unpacker-v2.git", "cd unpacker-v2", "git checkout v" + pkg.version, "npm ci          # installs exactly what package-lock.json pins", "npm test        # " + build.tests, "npm run dev     # run from source", "npm run dist    # dist\\unpacker-v2-" + pkg.version + "-setup.exe"].join("\n"));
  ul(["From the reconstruction archive instead of Git: unzip, change into `source`, and run the same commands from `npm ci` onward.", "The 7-Zip engine is part of the source tree (`vendor/7zip`); nothing needs to be installed for it.", "Keep the checkout path short. NSIS can fail in very deep folders.", "Clean build output measured: `" + build.exe + "`, " + build.size + " bytes, SHA-256 `" + build.sha + "`. Builds are not byte-reproducible; expect a different checksum."]);

  h1("2. Repository layout");
  table(
    ["Path", "Purpose"],
    [
      ["package.json, package-lock.json", "Version, scripts, pinned dependencies"],
      ["electron-builder.yml", "Packaging and installer configuration, update feed"],
      [".github/workflows/node-electron-release.yml", "Build and release workflow"],
      [".github/ISSUE_TEMPLATE, pull_request_template.md", "GitHub templates"],
      ["src/main/", "Main process (see the module table in the Release and System Overview)"],
      ["src/main/engine/", "7-Zip and WinRAR wrappers, format table"],
      ["src/main/jobs/", "Queue and runner"],
      ["src/renderer/", "The page: index.html, styles.css, app.js, takeout-tab.js"],
      ["vendor/7zip/", "7z.exe, 7z.dll, License.txt (committed; shipped as resources/7zip)"],
      ["assets/", "Icons: icon.svg (source), icon-16 … icon-256.png, icon.png, icon.ico, tray.png"],
      ["scripts/make-icons.js", "Regenerates every icon file with no dependencies"],
      ["test/", "Unit tests, one file per area (10 files)"],
      ["docs/", "Project site (index.html), USER-GUIDE.md, DESIGN-NEXT.md, screenshots for the site"],
      ["docs/_tools/", "Documentation tooling (this package)"],
      ["docs/release-package/<version>/", "Generated documentation package"],
      ["CLAUDE.md, CONVENTIONS.md, CHANGELOG.md, README.md, LICENSE", "Project guide with invariants and pitfalls; house conventions; history; overview; MIT licence"],
      ["dist/, node_modules/", "Build output and packages; not in version control"],
    ],
    [3600, 5760]
  );

  h1("3. Data model");
  p("There is no database and there are no migrations. Persistent and exchanged data are plain files and in-memory objects.");
  h2("3.1 settings.json");
  p("One JSON object; missing keys take their defaults (`src/main/store.js`). Keys, values and defaults are listed in the Settings reference of the User Manual. New keys need no migration: add a default.");
  h2("3.2 Job (memory; sent to the page as snapshots)");
  table(["Field", "Type", "Meaning"], [["id", "text", "Unique within the session"], ["kind", "text", "compress, extract, convert, test, takeout, pack, verify-manifest, organize, snapchat"], ["label", "text", "Shown name"], ["inputs", "list of paths", "What the job works on"], ["options", "object", "Per-kind options; `password` and `outPassword` are replaced by a dot in snapshots"], ["groupId, sequential, depth", "text, true or false, number", "Batch membership; one-at-a-time flag; nesting level of nested archives"], ["after", "job id or empty", "Dependency: starts when that job is done and inherits its output as input; cancelled if it fails"], ["state", "text", "queued, running, done, failed, cancelled, needs-password"], ["progress, stage, file", "number 0–100, text, text", "Live status"], ["error, errorKind", "text", "Message and class: password, corrupt, unsupported, notfound, diskfull, unsafe, cancelled, fatal"], ["output", "path", "Result"], ["warnings", "list of text", "Non-fatal notes"], ["createdAt, startedAt, endedAt", "milliseconds", "Timestamps"]], [2600, 2400, 4360]);
  h2("3.3 Batch (memory)");
  p("`{ id, label, sources, options, jobIds, finalized, report, archivalDir }` in `src/main/groups.js`. The summary sent to the page adds counts per state, `finished` and `allOk`.");
  h2("3.4 Manifest file");
  code(["# Unpacker V2 manifest", "id: K7M3Q9XZ", "name: Album", "created: 2026-09-12T14:01:02Z", `tool: Unpacker V2 ${pkg.version}`, "format: zip", "chunk-limit: 4g (chunks)", "chunks: 3", "files: 1250", "bytes: 11811160064", "hashed: sha256", "", "# archives", "01of03<TAB>Album_K7M3Q9XZ-01of03.zip<TAB>3999000000", "", "#chunk<TAB>path<TAB>size<TAB>modified<TAB>sha256", "01of03<TAB>2019 Trip/IMG_1.jpg<TAB>4123456<TAB>2019-07-01T10:00:00Z<TAB>ab12…"].join("\n"));
  h2("3.5 Takeout resume state");
  p("`<destination>/.unpacker-takeout.json`: `{ done: { \"<part file name>\": { size, mtimeMs, at } } }`. A part is skipped when its name, size and modified time match. The file is deleted when the export completes.");
  p("`<library>/.unpacker-organize.json`: `{ library, photos: {counts}, hashes: { \"<sha256>\": \"<placed path>\" }, albums: { \"<album>\": [paths] } }`, written every 250 placed files and on cancel. A rerun loads it so duplicates are still recognised and the album index is complete, then deletes it when organising finishes.");
  h2("3.5a Job history (optional)");
  p("`%APPDATA%/Unpacker V2/history.jsonl`, one object per line: `{ time, kind, label, state, started, ended, inputs, output, error, warnings }`. Written only when the Privacy setting is on; passwords are never included.");
  h2("3.6 Relationships");
  ul(["A batch has many jobs; a job belongs to at most one batch.", "A job may depend on one other job (`after`).", "A manifest lists many archives and many files; each file belongs to one archive."]);

  h1("4. Configuration and environment");
  table(["Name", "Kind", "Purpose"], [["electron-builder.yml", "File", "Packaging, installer and update feed"], ["package.json", "File", "Version, scripts, engines"], ["settings.json", "File (run time)", "User preferences"], ["NO_AUTO_UPDATE", "Environment variable", "When set, disables updates regardless of the setting"], ["CSC_LINK, CSC_KEY_PASSWORD", "Continuous-integration secrets (names only)", "Optional code-signing certificate; not defined in the repository today"], ["GITHUB_TOKEN", "Provided by GitHub Actions", "Lets the workflow create the release"], ["ProgramFiles, ProgramFiles(x86), PATH", "Environment variables", "Searched for 7z.exe and Rar.exe"], ["OneDrive, OneDriveConsumer, OneDriveCommercial", "Environment variables", "Used to recognise cloud-synchronised folders"], ["TEMP", "Environment variable", "Default scratch location"]], [3000, 2800, 3560]);
  p("The application reads no secrets and stores none.");

  h1("5. Run-time locations");
  table(["What", "Location"], [["Installed application", "%LOCALAPPDATA%\\Programs\\unpacker-v2 (electron-builder per-user default; UNVERIFIED on this machine)"], ["Engine in the installed application", "<install>\\resources\\7zip\\7z.exe"], ["Settings", "%APPDATA%\\Unpacker V2\\settings.json"], ["Chromium profile and caches", "%APPDATA%\\Unpacker V2\\ (managed by Electron)"], ["Update downloads", "%LOCALAPPDATA%\\unpacker-v2-updater (electron-updater default; UNVERIFIED)"], ["Scratch", "<tempDir setting or %TEMP%>\\UnpackerV2\\<job id>\\"], ["Logs", "None. The application writes no log file. With `--dev`, page errors are echoed to the terminal."], ["Reports", "Next to the results (see the Release and System Overview, Storage)"]], [3000, 6360]);

  h1("6. Tests");
  code("npm test                                             # node --test \"test/**/*.test.js\"\nnode --test --experimental-test-coverage \"test/**/*.test.js\"   # with coverage");
  p("Status at the release tag: " + build.tests + ". The tests are unit tests of the Electron-free modules; they need no Electron and no engine.");
  h2("6.1 Coverage (measured with Node's built-in coverage)");
  table(
    ["File", "Lines covered (percent)", "Branches (percent)", "Functions (percent)"],
    [
      ["All files", "70.39", "79.71", "77.21"],
      ["cli.js, policy.js, engine/formats.js", "100", "89 to 100", "100"],
      ["takeout.js, exif.js, exportlog.js, manifest.js, snapchat-account.js, chunker.js", "96 to 99", "72 to 93", "83 to 100"],
      ["jobs/queue.js, snapchat.js, scan.js, library.js", "90 to 95", "69 to 82", "83 to 100"],
      ["analyze.js, safety.js", "82 to 83", "74 to 91", "82 to 92"],
      ["organize.js", "72.66", "74.68", "74.19"],
      ["engine/sevenzip.js", "67.28", "78.33", "60.71"],
      ["shell-integration.js", "60.67", "100", "37.50"],
      ["engine/rar.js", "47.12", "78.57", "42.86"],
      ["groups.js", "26.27", "75.00", "9.09"],
      ["jobs/runner.js", "17.82", "86.67", "3.85"],
      ["main.js, preload.js, store.js, updater.js, renderer", "not measured", "not measured", "not measured"],
    ],
    [4200, 1900, 1630, 1630]
  );
  note("The low figures for runner.js and groups.js reflect that those modules are exercised by the end-to-end scripts in `test/e2e/` against the real engine, which run on demand and are not part of `npm test` or the coverage run.");

  h1("7. Regenerate the documentation");
  code(["cd docs\\_tools", "npm install                               # playwright-core, mermaid, docx (once)", "cd ..\\..", "node docs/_tools/build_inventory.js       # ui_inventory.json; fails if a control vanished from the source", "node docs/_tools/capture.js               # 38 clean screenshots + callout positions, light and dark", "python docs/_tools/annotate.py docs/release-package/<version>/screenshots", "node docs/_tools/render_mermaid.js docs/_tools/architecture.mmd docs/release-package/<version>/architecture.png", "node docs/_tools/build_manual.js", "node docs/_tools/build_reports.js", '"C:\\Program Files\\LibreOffice\\program\\python.exe" docs/_tools/to_pdf.py <the three .docx files>', "python docs/_tools/make_archive.py        # reconstruction archive, manifest, secret scan, verification"].join("\n"));
  ul(["`ui_spec.js` is the single list of surfaces and controls. Add a control there and it appears in the inventory, gets a callout, and gets a table row.", "The capture uses fake data generated under `docs/_tools/_demo` and an isolated profile; it never reads real user data and deletes its data afterwards.", "Needs: Python 3 with Pillow; LibreOffice (for PDF export and the table of contents); the application's own `node_modules`.", "The application also has its own `--screenshot` mode (`npx electron . --dev --screenshot docs/screenshots`) that produces the images for the project site; it is separate from this tooling."]);

  h1("8. Extension points");
  h2("8.1 Add a page");
  ol(["Add a `<button class=\"nav-item\" data-tab=\"name\">` to the sidebar and a `<main id=\"…\" hidden>` container in `src/renderer/index.html`.", "Register it in the `PAGES` map in `src/renderer/app.js`; `showTab()` does the rest. Route drops to it in the window's drop handler if the page accepts them.", "Put page logic in its own script file (as `takeout-tab.js`, `snapchat-tab.js` and `library-tab.js` do) and add a `<script>` tag.", "Add a `shot:open` case in `app.js` so the documentation capture can open it, then add the surface and its controls to `docs/_tools/ui_spec.js` and its prose to `manual_content.js`."]);
  h2("8.2 Add a feature that does work (a job kind)");
  ol(["Add a method to `Runner` in `src/main/jobs/runner.js` and a `case` in `run()`. Take `(job, ctx)`; report with `ctx.stage`, `ctx.progress`, `ctx.warn`; honour `ctx.signal`.", "If it creates archives, register planned outputs before starting the engine and call `discardUnverified` in `finally`.", "Add a request handler in `src/main/main.js` that calls `queue.add({ kind, label, inputs, options })`.", "Expose it in `src/main/preload.js` under `window.unpacker`.", "Call it from the page. The queue row needs no changes.", "Add unit tests for any pure logic."]);
  h2("8.3 Add a file format");
  ol(["To recognise it for extraction: add the extension to `SINGLE` (or `COMPOUND` for tar wrappers) in `src/main/engine/formats.js`.", "To create it: add an entry to `TARGETS` with the 7-Zip type name and its capabilities (`encrypt`, `split`, `levels`, `inner`).", "If the type needs special switches, add them in `addArgs()` in `src/main/engine/sevenzip.js` — the only place command lines are built.", "Add a case to `test/formats.test.js`. The page reads the target list at start-up; no interface change is needed."]);
  h2("8.4 Rules that must not be broken");
  p("From `CLAUDE.md`: the engine is always a child process, never a native module; the engine must never be able to prompt (a password switch is always passed); nothing destructive happens before a verify passes, and removal means the Recycle Bin; hostile archives are refused before extraction; the page has no Node access; passwords stay in the main process.");

  h1("9. Open questions");
  ul(["UNVERIFIED: installed-application and update-download locations (taken from the packaging tool's defaults, not observed).", "UNVERIFIED: build on Node 22 locally (continuous integration uses it; the local verification used " + build.node + ").", "End-to-end scripts need to be recovered or rewritten into the repository."]);

  return { title: "Unpacker V2", subtitle: "Developer and Rebuild Guide", version: pkg.version, coverLines: [`**Version** ${pkg.version}`, `**Document date** ${today}`, "**Repository** https://github.com/AxialForge/unpacker-v2"], blocks: B };
}

(async () => {
  const build = JSON.parse(fs.readFileSync(path.join(OUT, "clean_build.json"), "utf8"));
  await toDocx(overview(), path.join(OUT, "RELEASE_OVERVIEW.docx"));
  const dg = devguide(build);
  toMarkdown(dg, path.join(OUT, "DEVELOPER_GUIDE.md"));
  await toDocx(dg, path.join(OUT, "DEVELOPER_GUIDE.docx"));
  console.log("RELEASE_OVERVIEW.docx, DEVELOPER_GUIDE.md, DEVELOPER_GUIDE.docx written");
})();
