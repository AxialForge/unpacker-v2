# Unpacker V2

A drag-and-drop Windows archiver that stays out of your way: drop archives to
extract them, drop anything else to compress it, or point it at a folder and
convert every archive inside to one format. Built on the 7-Zip engine, so
ZIP/ZIP64, 7z, tar, gzip, bzip2, xz, zstd, cab, iso, wim and RAR (extract)
all just work, on files of any size.

## What it does

- **Create** 7z, ZIP (ZIP64, AES-256), tar, tar.gz, tar.xz, tar.bz2 — and RAR
  if you have WinRAR installed.
- **Extract** everything 7-Zip reads, including RAR/RAR5, split volumes
  (`.001`, `.part1.rar`, `.z01`), and encrypted archives (it asks for the
  password instead of failing).
- **Mass convert** — drop a stack of archives, or scan a whole folder, and
  repack them all as 7z/ZIP/tar.*; verified before the original is touched.
- **Test** archive integrity.
- **Google Takeout** — point it at your downloads folder (or drop the parts)
  and it groups the numbered parts into exports, flags missing parts, checks
  every download for damage first, checks disk space for the whole export,
  then merges the parts one at a time into a single folder. Interrupted runs
  resume. Options: skip/overwrite/keep-both on collisions, drop the `Takeout/`
  wrapper, tidy Google Photos JSON sidecars into `_json` folders, Recycle-Bin
  the parts when done. A `Takeout-import-report.txt` lands in the folder.
- Password / AES encryption, split volumes (FAT32-safe 4 GB preset), verify
  after every job, per-job cancel, a bounded parallel queue.
- Optional Explorer right-click entries: *Add to archive*, *Extract here*,
  *Extract to folder…*, *Convert archive…*.

## What it deliberately won't do

- **Create RAR without WinRAR.** Only rar.exe can write RAR and its licence
  forbids bundling it. Extracting RAR needs nothing extra.
- Extract an archive whose entries point outside the destination folder, or
  one that looks like a zip bomb (>1000:1 and >1 GB), unless you turn that
  guard off in Settings.
- Delete anything with `unlink`. "Remove original" means the Recycle Bin, and
  only after the new archive passed an integrity test.

## Run from source

Needs Node 22+ (Node 24 works; there are no native modules).

```bash
npm install
npm run dev
```

The 7-Zip engine is expected at `vendor/7zip/7z.exe` + `7z.dll` (or an installed
7-Zip in Program Files). Get it from <https://www.7-zip.org/download.html>:
install 7-Zip, then copy `7z.exe`, `7z.dll` and `License.txt` from
`C:\Program Files\7-Zip` into `vendor/7zip/`. 7-Zip is LGPL; the RAR
decompression code inside it carries the unRAR restriction (it may not be used
to build a RAR *compressor*), which this app respects.

```bash
npm test          # node --test, pure modules only
npm run dist      # dist/unpacker-v2-<ver>-setup.exe
```

## Install

Grab the latest `unpacker-v2-<version>-setup.exe` from Releases. One-click,
per-user install (no admin), silent auto-update from GitHub Releases.
The build is unsigned; SmartScreen will warn the first time.

## Licence

MIT. Bundled 7-Zip is © Igor Pavlov, LGPL + unRAR restriction; see
`vendor/7zip/License.txt`.
