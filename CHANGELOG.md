# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
