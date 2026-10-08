# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.4.0] - 2026-10-08

### Added

- Library page: a read-only visual directory of a result folder (Takeout,
  Snapchat or any folder). Folder tree, grid or list with real thumbnails,
  and a preview pane for photos, video, audio, text, chat transcripts and CSV
  tables; whole-library name search; the folder's `What's in here.txt` or
  report shown at the top. Wizards get a "Browse it here" button when done.
  Media is served through an app-private `unp://` scheme that only reaches
  folders opened on the page.

- Takeout organize resumes after a cancel or crash: the hashes of placed
  files and the album index are checkpointed in the library, so a rerun
  still removes duplicates and lists every album in full.
- Settings > Privacy (both off by default): a Windows notification when a
  job finishes while the window is not in front (job name only), and a
  history of finished jobs in `history.jsonl` with Open and Clear buttons.
  The section also states that the archive password is visible on the
  engine's command line while a job runs.
- Cloud placeholders are detected per file: a job whose inputs sit in a
  OneDrive, Google Drive, Dropbox or iCloud folder says how many files are
  cloud-only and names the first few, instead of a blanket warning.

### Fixed

- Option labels with inline file names (for example the export-log tick box)
  wrapped into columns.
- Tapping Alt no longer reveals Electron's default File/View/DevTools menu.
- Dialogs: Escape cancels, Enter presses the main button, focus moves into
  the dialog when it opens.

## [0.3.0] - 2026-10-06

### Added

- Snapchat page (scaffold): a four-step wizard for Snapchat "My Data"
  exports (`mydata~<id>[-N].zip`). Extracts the parts, then builds a
  Memories library: Year/Month folders, files renamed to the time taken,
  file dates set, EXIF taken time and position written into photos, overlays
  kept with their photo or video, a `Memories index.csv`, and a
  `Missing memories.csv` listing memories Snapchat lists but did not deliver.
  Other export sections are kept untouched in `Account data`. Dropping
  Snapchat parts in Auto mode opens the page.
- Snapchat: several exports of one account (for example a Memories-only export
  and a full account export) are combined into one folder and one library;
  their memory lists are merged. The full account export is organised too:
  a readable transcript per chat plus `All chats.csv`, chat pictures and
  videos placed with their conversation when a message names them (otherwise
  by date), a snap log, friend lists, story views and location history as
  spreadsheets, and every other section as readable text in `Account data`
  with the originals kept.
- Export log (optional): `What's in here.txt` (a short summary: counts and
  sizes per folder, kinds of files, which archives failed, where the sources
  went) and `Contents.csv` (every file with folder, size, date, kind and
  source archive), written at the top of a Mass extract, Google Takeout or
  Snapchat result. Folders are left exactly as the archives had them. Ticked
  automatically in Mass extract for more than five archives.
- EXIF writer can now write a GPS position (JPEG without an existing EXIF
  block).

### Fixed

- Installer packed only `icon.png` and `tray.png`, so the About and Settings
  pages showed broken icons in the installed build; every `assets/*.png` is
  packed now.

## [0.2.3] - 2026-09-13

### Fixed

- Takeout wizard, Run step: the Organize phase reported progress only while
  placing photos, so scanning a large library, filing sidecars and moving
  Drive/Mail looked frozen. Every phase now reports a percentage and the
  current file, the stage line shows elapsed time, and the bar pulses when
  nothing has changed for a few seconds.

## [0.2.2] - 2026-09-13

### Added

- Mass extract: source archives can be moved into a `<folder name> -
  archival` folder inside the extracted location once every archive
  succeeded, as an alternative to keeping them or binning them. The group
  card gets an "Open archival folder" button.

## [0.2.1] - 2026-09-13

### Changed

- Sidebar layout (Archives, Google Takeout, Settings, About) in place of the
  top tabs and the Settings dialog; version and engine shown in the sidebar.
- Settings is a page with a new **Updates** section: installed version,
  "Check for updates now", live status, and "Restart to update".

### Added

- About page: version, engine paths and versions, WinRAR status, links to the
  site, guide, releases, changelog and issues, and licence notes.

## [0.2.0] - 2026-09-13

### Added

- Google Takeout tab: a four-step wizard (Select, Options, Run, Done) that
  finds exports in a downloads folder or an already-extracted tree, checks and
  extracts the parts, then organizes the result into per-service libraries.
- Organizer: Photos dated from JSON sidecars, EXIF DateTimeOriginal written
  into JPEGs that lack it, Year/Month folders with `Albums.txt`, duplicate
  removal by hash, sidecar handling (park/keep/bin); Drive, Mail, Contacts,
  Calendar, YouTube and other services merged into one folder each; report.
- Takeout part matching for multi-set exports (`-2-001`) and browser
  re-downloads (`-028 (1).zip`), which are ignored with a size check.
- Queue jobs can depend on another job (`after`); Organize waits for Extract
  and is skipped if extraction fails or is cancelled.

## [0.1.0] - 2026-09-12

### Added

- Drag-and-drop create / extract / test, auto-detected by file type.
- Mass convert: drop many archives or scan a folder, repack as 7z/ZIP/tar.*.
- Targets: 7z, ZIP (ZIP64, AES-256), tar, tar.gz, tar.xz, tar.bz2; RAR when
  WinRAR is installed.
- Extraction of everything 7-Zip reads, including RAR/RAR5, split sets and
  encrypted archives (password prompt with retry).
- Split volumes, verify after every job, bounded parallel queue with cancel.
- Traversal and zip-bomb guards; free-disk-space checks before work starts.
- Explorer right-click entries (HKCU, no admin) with multi-select coalescing.
- Silent auto-update from GitHub Releases.
- Google Takeout flow: groups numbered parts into exports, reports missing
  parts, verifies downloads first, checks space for the whole export, merges
  parts sequentially into one folder with skip/overwrite/keep-both, resumes
  interrupted runs, optional wrapper removal, JSON sidecar tidy, and
  Recycle-Bin cleanup of the parts. Dropping Takeout parts opens this flow.
- Smart compress: content analysis with a deflate probe suggests format and
  level with a reason; Everyday / Archival / Custom presets.
- Size limits per archive (1–50 GB) as independent chunk archives (deepest
  folders that fit stay together) or as volumes; oversized single files fall
  back to volumes automatically.
- Manifests with an 8-character ID shared by archives and the manifest file,
  optional SHA-256 per file, a copy inside every archive, and a
  "Verify a manifest" job that writes a .verify.txt report.
- Solid block cap for 7z (`-ms`) so a damaged block stays local.
- Long-job protection: close confirmation with tray mode, sleep blocker while
  the queue is busy, partial outputs removed on cancel/failure (verified
  chunks kept), Takeout tgz temp-space check, cloud-sync folder warning.
- Security: passwords masked in queue snapshots and logs; archives with
  symlink/junction entries refused unless allowed in Settings.
- Manifest placement "inside the archives only"; Verify a manifest accepts an
  archive and reads the copy inside it.
- Warnings shown amber on finished jobs; duplicate inputs skipped; app icon.
- Mass extract: scan a folder (or drop several archives, or the Explorer
  "Extract all archives in here" verb) and extract each into its own folder,
  merge into one folder, or beside each archive; nested archives extracted
  (kept or binned) up to three levels; sequential by default; sources binned
  only if everything succeeded; group summary row and report.

### Fixed

- Compress jobs reported no progress: 7-Zip prints `+ name` while adding and
  the parser only accepted `- name`.
