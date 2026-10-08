// Builds USER_MANUAL.docx from ui_spec.js (controls), the callout files written
// by capture.js (numbers), manual_content.js (prose) and runtime_facts.json.
//
//   node docs/_tools/build_manual.js [outDir]
// then: "<LibreOffice>\program\python.exe" docs/_tools/to_pdf.py <outDir>/USER_MANUAL.docx

const fs = require("node:fs");
const path = require("node:path");
const spec = require("./ui_spec");
const content = require("./manual_content");
const { toDocx } = require("./doclib");

const ROOT = path.resolve(__dirname, "..", "..");
const pkg = require(path.join(ROOT, "package.json"));
const OUT = path.resolve(process.argv[2] || path.join(ROOT, "docs", "release-package", pkg.version));
const SHOTS = path.join(OUT, "screenshots");
const facts = JSON.parse(fs.readFileSync(path.join(OUT, "runtime_facts.json"), "utf8"));
const shot = (name, kind = "annotated") => path.join(SHOTS, `${name}_${kind}.png`);
const callouts = (name) => JSON.parse(fs.readFileSync(path.join(SHOTS, `${name}.callouts.json`), "utf8"));

const B = [];
const h1 = (t) => B.push({ h: 1, t });
const h2 = (t) => B.push({ h: 2, t });
const h3 = (t) => B.push({ h: 3, t });
const p = (t) => B.push({ p: t });
const ul = (a) => a.length && B.push({ ul: a });
const ol = (a) => a.length && B.push({ ol: a });
const CALLOUT_WIDTHS = [760, 1400, 900, 2480, 1420, 1050, 1350];
const gaps = [];

function controlTable(s) {
  const head = ["Number", "Control name", "Type", "What it does", "Inputs and limits", "Default", "Notes"];
  let rows;
  if (s.shot) {
    const co = callouts(s.shot);
    const byId = new Map(co.callouts.map((c) => [c.id, c.number]));
    rows = s.controls.map((c) => [byId.has(c.id) ? String(byId.get(c.id)) : "not shown", c.name, c.type, c.does, c.inputs, c.def, c.notes]);
    for (const c of co.callouts) if (!s.controls.some((x) => x.id === c.id)) gaps.push(`${s.shot}: callout ${c.number} (${c.id}) has no table row`);
    rows.sort((a, b) => (a[0] === "not shown") - (b[0] === "not shown") || Number(a[0]) - Number(b[0]));
  } else {
    rows = s.controls.map((c) => ["–", c.name, c.type, c.does, c.inputs, c.def, c.notes]);
  }
  B.push({ table: { head, rows, widths: CALLOUT_WIDTHS, small: true } });
}

function surfaceSection(s, number) {
  h2(`${number} ${s.name}`);
  p(s.purpose);
  if (s.shot) B.push({ img: shot(s.shot), caption: `${s.name} — numbers match the table below` });
  else B.push({ note: "This surface is drawn by Windows (or exists only outside the window), so it cannot be captured by the automated screenshot script. It is documented from the source code." });
  controlTable(s);
  const c = content.surfaces[s.id];
  if (!c) return;
  if (c.workflow.length) {
    h3("Typical workflow");
    ol(c.workflow);
  }
  if (c.features.length) {
    h3("Features");
    ul(c.features);
  }
  if (c.edge.length) {
    h3("Edge cases");
    ul(c.edge);
  }
  if (c.messages.length) {
    h3("Messages on this surface");
    B.push({ table: { head: ["Message", "What it means", "What to do"], rows: c.messages, widths: [3400, 3160, 2800], small: true } });
  }
}

// ── 2. install ────────────────────────────────────────────────────
h1("1. Install, first launch and system requirements");
h2("1.1 System requirements");
B.push({
  table: {
    head: ["Item", "Requirement", "Status"],
    rows: [
      ["Operating system", "Windows 10 or Windows 11, 64-bit", "Built and exercised on Windows 11 Pro (build 26200). Windows 10: UNVERIFIED, not tested."],
      ["Processor architecture", "x64", "The installer is built for x64 only (electron-builder log: archs=x64)."],
      ["Disk space", "About 110 MB for the installer; more once installed", "Installer size measured: 112 MB. Installed size: UNVERIFIED."],
      ["Memory", "No stated minimum", "UNVERIFIED. High compression levels on large inputs use more memory."],
      ["Other software", "None required", "The 7-Zip engine is bundled. WinRAR is optional and only needed to create RAR files."],
      ["Network", "Not required", "Used only for the update check against GitHub Releases."],
      ["Administrator rights", "Not required", "Per-user installation; the Explorer menu entries are written to the current user's registry."],
    ],
    widths: [2000, 3200, 4160],
    small: true,
  },
});
h2("1.2 Install");
ol([
  "Download `unpacker-v2-" + pkg.version + "-setup.exe` from https://github.com/AxialForge/unpacker-v2/releases/latest.",
  "Run it. The build is not code-signed, so Windows SmartScreen shows a warning: click “More info”, then “Run anyway”.",
  "The installer has no questions. It installs for the current user, creates a desktop shortcut and a Start menu shortcut named “Unpacker V2”, and starts the application.",
]);
h2("1.3 First launch");
ul([
  "The Archives page is shown, with an empty queue.",
  "The engine line under the name in the sidebar should read “7-Zip 26.03”, followed by “+ WinRAR” when WinRAR is installed.",
  "The Explorer right-click entries are off until switched on in Settings.",
  "The application checks GitHub Releases for a newer version at start-up and every six hours, and installs it silently when the application closes. This can be switched off in Settings.",
]);
h2("1.4 Uninstall");
p("Use Windows Settings, Apps, Installed apps, “Unpacker V2”, Uninstall. If the Explorer entries were switched on, switch them off in Settings first so the registry keys are removed. The settings file in the data folder (see the Settings reference) is left behind and can be deleted by hand. Whether the uninstaller removes the registry keys itself: UNVERIFIED.");

// ── 3. interface overview ────────────────────────────────────────
h1("2. Interface overview");
const main = spec.find((s) => s.id === "main_window");
p(main.purpose);
B.push({ img: shot(main.shot), caption: "Main window (light theme) — numbers match the table below" });
controlTable(main);
h3("Typical workflow");
ol(content.surfaces.main_window.workflow);
h3("Features");
ul(content.surfaces.main_window.features);
h3("Edge cases");
ul(content.surfaces.main_window.edge);
B.push({ img: shot(`${main.shot}_dark`, "clean"), caption: "The same window in the dark theme (the default)" });
p("Every screenshot in this manual exists in four files in the `screenshots` folder of the release package: light and dark, each annotated and clean.");

// ── 4. per-surface sections ──────────────────────────────────────
h1("3. Pages and dialogs");
p("One section per page, dialog, menu and other surface. Each control in the tables below is recorded in `ui_inventory.json` with the source file and line where it is defined.");
let n = 0;
for (const s of spec) {
  if (s.id === "main_window") continue;
  n += 1;
  surfaceSection(s, `3.${n}`);
}
h2(`3.${n + 1} Messages shown on job rows`);
p("These appear in red (errors) or amber (warnings) on a job row in the queue, whichever page or dialog started the job.");
B.push({ table: { head: ["Message", "What it means", "What to do"], rows: content.jobMessages, widths: [3400, 3160, 2800], small: true } });

// ── 5. workflows ─────────────────────────────────────────────────
h1("4. Common workflows from start to finish");
h2("4.1 Extract one archive");
ol(["Open the Archives page.", "Drop the archive on the window (or click “Open archives…”).", "The job appears in the queue and runs. With the default “Smart” extract setting the files land in a new folder named after the archive, next to it, unless the archive already contains a single top-level folder.", "Click the blue path on the finished row to open the folder."]);
B.push({ img: shot("03_archives_queue", "clean"), caption: "Finished and failed jobs in the queue, with a batch card at the top and a notice at the bottom" });
h2("4.2 Extract an encrypted archive");
ol(["Drop the archive.", "The Password needed dialog opens. Type the password and press Enter.", "If the password was wrong, the dialog returns. Click Skip to leave the job waiting."]);
B.push({ img: shot("04_dialog_password", "clean"), caption: "Password needed dialog", widthPx: 520 });
h2("4.3 Compress a folder with a suggestion");
ol(["Leave “Smart compress” ticked.", "Drop the folder.", "Read the suggestion, keep the Everyday preset, click Pack.", "The archive is written next to the folder and tested."]);
h2("4.4 Build an archival set with a size limit and a manifest, and verify it later");
ol(["Drop the folder with “Smart compress” ticked.", "Click the Archival preset. The manifest and SHA-256 are switched on.", "Set “Size limit per archive” (for example 4 GB) and leave “Independent archives”.", "Click Pack. The result is a set such as `Album_K7M3Q9XZ-01of03.zip` … plus `Album_K7M3Q9XZ.manifest.txt`.", "Later, click “Verify a manifest…” and choose the manifest (or any archive of the set). A `.verify.txt` report is written and the job fails if anything is missing, damaged or changed."]);
B.push({ img: shot("05_dialog_smart_compress", "clean"), caption: "Smart compress with the Archival preset, a 4 GB limit and a password" });
h2("4.5 Extract a folder full of mixed archives");
ol(["Click “Mass extract a folder…” and choose the folder.", "Choose “Each archive into its own folder”, or “All into one folder (merged)” and a merge folder.", "Choose what to do with nested archives and with the sources.", "Click Extract and watch the batch card.", "When finished, click Report on the card."]);
B.push({ img: shot("07_dialog_mass_extract", "clean"), caption: "Mass extract in merge mode" });
h2("4.6 Convert a folder of archives to another format");
ol(["Click “Mass convert a folder…” and choose the folder.", "Choose the target format and level.", "Optionally tick “Move originals to the Recycle Bin after a passed verify”.", "Click Start."]);
B.push({ img: shot("06_dialog_convert", "clean"), caption: "Convert archives dialog" });
h2("4.7 Turn a Google Takeout export into organised libraries");
ol(["Open the Google Takeout page.", "Click “Choose the downloads folder…” and pick the folder with the takeout parts.", "Check for red missing-part warnings, then click Next.", "Leave the defaults and click Start.", "Wait for the Run step to finish; the Done step shows the summary.", "Click “Open the library”."]);
B.push({ img: shot("09_takeout_step1_select", "clean"), caption: "Step 1: an export with a missing part and an ignored re-download, plus an already-extracted folder" });
B.push({ img: shot("11_takeout_step3_run", "clean"), caption: "Step 3: live progress" });
B.push({ img: shot("12_takeout_step4_done", "clean"), caption: "Step 4: summary" });
h2("4.8 Use the Explorer right-click menu");
ol(["Open Settings and tick “Add … to the Explorer right-click menu”.", "In Explorer, right-click a file, folder or archive. On Windows 11 click “Show more options” first.", "Choose an entry. The window opens (or comes forward) and the job is queued."]);

// ── 6. settings reference ────────────────────────────────────────
h1("5. Settings reference");
p("All settings are stored as one JSON file: `%APPDATA%\\Unpacker V2\\settings.json`. It is written whenever a control changes. Deleting the file restores every default. The Explorer menu entries are the only setting also stored elsewhere: in the registry under `HKEY_CURRENT_USER\\Software\\Classes`.");
B.push({
  table: {
    head: ["Setting key", "Control", "Values", "Default", "Where it is set"],
    small: true,
    widths: [2000, 2500, 2060, 1000, 1800],
    rows: [
      ["theme", "Theme", "dark, light", "dark", "Settings"],
      ["format", "Format", "7z, zip, tar, tar.gz, tar.xz, tar.bz2, rar", "7z", "Archives page"],
      ["level", "Compression", "0 Store, 1 Fastest, 3 Fast, 5 Normal, 7 Maximum, 9 Ultra", "5", "Archives page"],
      ["split", "Split into volumes", "blank, 100m, 700m, 1000m, 2000m, 4000m, 8000m", "blank", "Archives page"],
      ["onePerItem", "One archive per dropped item", "true, false", "false", "Archives page"],
      ["outputMode", "Output", "beside, folder", "beside", "Archives page"],
      ["outputDir", "choose… (output folder)", "a folder path", "blank", "Archives page"],
      ["deleteOriginalAfterConvert", "After converting, move the original to the Recycle Bin", "true, false", "false", "Archives page; Convert dialog starts from it"],
      ["convertTarget", "Convert to", "same as format", "7z", "Convert archives dialog (saved on Start)"],
      ["extractMode", "Extract into", "smart, subfolder, here", "smart", "Settings"],
      ["overwrite", "If a file already exists", "rename, overwrite, skip", "rename", "Settings"],
      ["concurrency", "Jobs at the same time", "1 to 4", "2", "Settings"],
      ["tempDir", "Temporary folder for conversions", "a folder path; blank is the Windows temporary folder", "blank", "Settings"],
      ["verify", "Test every archive after creating or converting it", "true, false", "true", "Settings"],
      ["allowHighRatio", "Allow extreme compression ratios", "true, false", "false", "Settings"],
      ["allowLinks", "Allow archives that contain links", "true, false", "false", "Settings"],
      ["preventSleep", "Keep the PC awake while jobs run", "true, false", "true", "Settings"],
      ["closeToTray", "The close button hides to the tray while jobs run", "true, false", "false", "Settings"],
      ["contextMenu", "Add entries to the Explorer right-click menu", "true, false", "false", "Settings (also writes the registry)"],
      ["autoUpdate", "Update automatically from GitHub Releases", "true, false", "true", "Settings"],
      ["manifestPlacement", "Manifest text file (fallback)", "beside, inside", "beside", "No control writes this key; the Smart compress dialog passes its own choice per job"],
    ],
  },
});
p("Not stored: passwords, the Smart compress tick box, everything in the dialogs except “Convert to”, and all Google Takeout wizard choices.");
h2("5.1 Environment variable");
p("`NO_AUTO_UPDATE` — when set to any value, updates are disabled regardless of the setting, and “Check for updates now” reports that updates are disabled on this machine.");

// ── 7. keyboard ──────────────────────────────────────────────────
h1("6. Keyboard shortcuts");
p("The application defines these keys of its own:");
B.push({ table: { head: ["Key", "Where", "Action"], rows: [["Enter", "Any dialog (except in a multi-line field)", "Presses the dialog's main button: Retry, Start, Pack, Extract or Merge"], ["Escape", "Any dialog", "Presses the dialog's cancel button: Skip or Cancel"], ["Escape", "Library page, preview open", "Closes the preview"], ["Backspace", "Library page (outside the search field)", "Goes up one folder"], ["Enter", "Library page, a focused item", "Opens a folder or previews a file"]], widths: [1800, 4000, 3560] } });
p("When a dialog opens, focus moves to its first field or its main button. Standard Windows keys work as usual: Tab and Shift+Tab move between controls, Space toggles a tick box or presses the focused button, and the arrow keys change a drop-down list.");
p("The application has no menu bar: Electron's standard menu is removed at start-up (version " + facts.versions.electron + " of Electron), so Alt does nothing and there are no menu shortcuts such as Ctrl+R or Developer Tools in the window." + (facts.menu ? " UNVERIFIED: the capture script still read a menu from the running application." : " The capture script confirmed no menu is present."));

// ── 8. troubleshooting ───────────────────────────────────────────
h1("7. Troubleshooting and frequently asked questions");
B.push({
  table: {
    head: ["Question or symptom", "Answer"],
    small: true,
    widths: [3200, 6160],
    rows: [
      ["Windows says “Windows protected your PC” when installing.", "The installer is not code-signed. Click “More info”, then “Run anyway”."],
      ["Can it create RAR files?", "Only when WinRAR is installed; the RAR format can only be written by WinRAR's own program. Extracting RAR needs nothing extra."],
      ["The progress bar is not moving.", "Look at the stage line and the elapsed time. Hashing and testing large files produce no percentage change for a while; in the Takeout wizard the bar shows moving stripes during such steps."],
      ["I closed the window and the job stopped.", "Closing while jobs run asks what to do. Choose “Keep running in the background”, or tick “The close button hides to the tray while jobs run” in Settings."],
      ["Where did my files go after extraction?", "Click the blue path on the finished job row. With the Smart setting they are in a folder named after the archive, next to the archive."],
      ["A name has “(2)” added.", "A file or folder with that name already existed and the “Keep both” choice was active."],
      ["The Explorer entries are missing on Windows 11.", "They are under “Show more options” (Shift+F10)."],
      ["The job list is empty after restarting.", "The queue is kept in memory only. Reports written by batch jobs remain on disk."],
      ["An archive is “Refused”.", "See the messages table in section 3: the archive has unsafe paths, links, or an extreme compression ratio."],
      ["The engine line says “engine missing”.", "Reinstall the application. As a stop-gap, an installed copy of 7-Zip in Program Files is also used."],
      ["Is my password stored?", "No. It is passed to the engine for the job and kept only until the job row is removed. While a job runs it is visible on the engine's command line to programs on the same PC that can list processes."],
      ["Organising a Takeout export is slow.", "With “Remove duplicates” on, every photo and video is read in full to compare contents. Untick it for a faster run."],
      ["Something is in the Recycle Bin I did not expect.", "The application only bins what an option told it to: converted originals, extracted nested archives, mass-extract sources, Takeout parts, duplicate photos and sidecars. Restore from the Recycle Bin."],
      ["Where are settings kept?", "`%APPDATA%\\Unpacker V2\\settings.json`."],
      ["Does it send anything to the internet?", "Only the update check to GitHub. No usage data is collected."],
    ],
  },
});

// ── 9. glossary ──────────────────────────────────────────────────
h1("8. Glossary");
B.push({ table: { head: ["Term", "Meaning"], rows: content.glossary, widths: [2600, 6760], small: true } });

h1("9. Open questions");
ul([
  "UNVERIFIED: behaviour on Windows 10 (all testing was on Windows 11).",
  "UNVERIFIED: installed size on disk, and minimum memory.",
  "UNVERIFIED: whether the uninstaller removes the Explorer registry entries.",
  "UNVERIFIED: that the installed build, like the run from source, has no menu bar.",
  "Not captured as screenshots: Windows file pickers, the “Jobs are still running” question, the notification-area icon and menu, the Explorer entries. They are documented from source.",
]);

(async () => {
  const doc = {
    title: "Unpacker V2",
    subtitle: "User Manual",
    version: pkg.version,
    coverLines: [`**Version** ${pkg.version}`, "**Build date** 13 September 2026 (release tag v" + pkg.version + ")", "**Document date** " + new Date().toISOString().slice(0, 10), "**Publisher** AxialForge", "**Platform** Windows 10 and Windows 11, 64-bit"],
    blocks: B,
  };
  const out = path.join(OUT, "USER_MANUAL.docx");
  await toDocx(doc, out);
  fs.writeFileSync(path.join(OUT, "manual_build_report.txt"), gaps.length ? `${gaps.join("\n")}\n` : "every callout has a table row\n");
  console.log(`${out}  (${B.length} blocks)${gaps.length ? `  GAPS: ${gaps.length}` : ""}`);
})();
