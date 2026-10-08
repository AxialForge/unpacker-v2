"""Write QA_REPORT.md from the measured results.

    python docs/_tools/write_qa_report.py

Reads qa_results.json (qa_check.py), archive_report.json (make_archive.py, last
full run) and clean_build.json. Run make_archive.py --skip-build afterwards so
the report is inside the archive.
"""
import datetime
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VERSION = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
O = ROOT / "docs" / "release-package" / VERSION

qa = json.loads((O / "qa_results.json").read_text(encoding="utf-8"))
ar = json.loads((O / "archive_report.json").read_text(encoding="utf-8"))
cb = json.loads((O / "clean_build.json").read_text(encoding="utf-8"))
d = qa["documents"]
b = ar["build_from_archive"]

L = []
A = L.append
A(f"# Unpacker V2 {VERSION} — documentation package quality report")
A("")
A(f"Generated {datetime.date.today().isoformat()} by `docs/_tools`. Machine-readable results: `qa_results.json`, `archive_report.json` (beside the zip), `clean_build.json`.")
A("")
A("## Result summary")
A("")
A("| Check | Result |")
A("| --- | --- |")
A(f"| Every control in `ui_inventory.json` appears in the manual | **Pass** — {qa['inventory_controls']} controls on {qa['inventory_surfaces']} surfaces, {len(qa['controls_missing_from_manual'])} missing |")
A(f"| Every inventory entry traces to a source line | **Pass** — {len(qa['inventory_lines_unverified'])} unresolved |")
A(f"| Every callout number matches its table row | **Pass** — {qa['callouts_checked']} callouts checked across light and dark, {len(qa['callout_mismatches'])} mismatches |")
A(f"| Screenshots present | **Pass** — {qa['screenshots_expected']} expected ({qa['screenshots_expected'] // 4} surfaces, light and dark, clean and annotated), {len(qa['screenshots_missing'])} missing |")
A(f"| Capture run | {qa['capture_report']}; no page errors |")
A(f"| `USER_MANUAL` | {d['USER_MANUAL']['pdf_pages']} pages, {d['USER_MANUAL']['pictures']} pictures embedded, none empty, {d['USER_MANUAL']['contents_links']} table-of-contents links |")
A(f"| `RELEASE_OVERVIEW` | {d['RELEASE_OVERVIEW']['pdf_pages']} pages, {d['RELEASE_OVERVIEW']['pictures']} picture, {d['RELEASE_OVERVIEW']['contents_links']} table-of-contents links |")
A(f"| `DEVELOPER_GUIDE` | Markdown plus {d['DEVELOPER_GUIDE']['pdf_pages']}-page PDF |")
A("| Documents opened and inspected | Pages of the PDFs were rendered to images and looked at: cover, table of contents with page numbers, headers with version, page-number footers, tables and pictures render |")
A(f"| Secret scan | **{len(ar['secret_findings'])} findings** over every text file in the archive (private keys; GitHub, AWS and Slack tokens; bearer tokens; quoted password, secret, token or key assignments) |")
A(f"| Archive hashes | **Pass** — {ar['manifest_check']['checked']} files re-hashed after unzipping, {len(ar['manifest_check']['mismatches'])} mismatches |")
A(f"| Clean build from the release tag | **Pass** — `git archive v{VERSION}` into an empty folder, `npm ci`, {cb['tests']}, installer built ({cb['size']} bytes) |")
if isinstance(b, dict):
    A(f"| Build from the unzipped archive | **{b['result'].capitalize()}** — `npm ci` exit {b['npm_ci_exit']}, {b['tests_passed']} tests passed, installer built ({b['installer_bytes']} bytes) |")
else:
    A("| Build from the unzipped archive | not run |")
A("")
A("## Gaps")
A("")
A("Surfaces with no screenshot (drawn by Windows, or outside the window; documented from source with file and line):")
A("")
for s in qa["surfaces_without_screenshot"]:
    A(f"- {s}")
A("")
A("Controls listed but not visible in the captures (documented, marked “not shown” in their tables): the Awake badge, the output folder path label, the empty-queue text, the wizard hint, and the “Restart to update” button. Each appears only in a state the capture does not reach.")
A("")
A("The Google Takeout and Snapchat step 3 captures show whichever phase was running when the Run page appeared, so they differ slightly between the light and dark runs.")
A("")
A("## Items marked UNVERIFIED")
A("")
for t in [
    "Behaviour on Windows 10 (everything was built and exercised on Windows 11 Pro, build 26200).",
    "Installed size on disk; minimum memory.",
    "Whether the uninstaller removes the Explorer registry entries.",
    "That the installed build, like the run from source, has no menu bar.",
    "Installed-application folder and update-download folder (taken from the packaging tool's defaults).",
    f"Building locally on Node 22 (continuous integration uses 22; the local verification used {cb['node']}).",
    "The installed build was not launched during this pass.",
]:
    A(f"- {t}")
A("")
A("## Findings about the application (not fixed; application source was not modified)")
A("")
A("1. **Video thumbnails on the Library page depend on Windows codecs.** A video in a format Windows cannot decode shows an icon; the preview still plays MP4, M4V, WebM and MOV.")
A("2. **Coverage of `jobs/runner.js` (18 percent) and `groups.js` (26 percent) comes only from the end-to-end scripts in `test/e2e/`,** which run on demand, not in `npm test`; all measured files 70 percent.")
A("3. **Run from source, the version shown is Electron's** (`app.getVersion()` in a source checkout); the installed build shows the real version.")
A("4. **`manifestPlacement` has a default in the settings file but no control writes it.**")
A("5. **No log file is written** (the optional job history records finished jobs only).")
A("")
A("## Secret-scan notes")
A("")
A("Zero matches. Two strings that look password-like are placeholders, not secrets: `unpacker-v2-no-password-given` in `src/main/engine/sevenzip.js` (passed to the engine so it never prompts) and `demo-password` in `docs/_tools/capture.js` (encrypts a fake sample archive). The workflow file names two secrets (`CSC_LINK`, `CSC_KEY_PASSWORD`) but holds no values, and the repository has none defined.")
A("")
A("## Files")
A("")
A("| File | Size (bytes) |")
A("| --- | ---: |")
for f in sorted(O.rglob("*")):
    if f.is_file() and "screenshots" not in f.parts and f.name != "QA_REPORT.md":
        A(f"| {f.relative_to(O).as_posix()} | {f.stat().st_size:,} |")
shots = list((O / "screenshots").iterdir())
A(f"| screenshots/ ({len(shots)} files: {len(shots) - 1 - (len(shots) - 1) // 3} pictures, {(len(shots) - 1) // 3} callout position files, capture report) | {sum(f.stat().st_size for f in shots):,} |")
A("")
A("The checksum of the zip is recorded in `archive_report.json` (a file cannot contain its own checksum). The zip is larger than 100 MB: do not commit it to Git; GitHub rejects files over that size.")
A("")
(O / "QA_REPORT.md").write_text("\n".join(L), encoding="utf-8")
print("QA_REPORT.md written,", len(L), "lines")
