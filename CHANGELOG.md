# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
