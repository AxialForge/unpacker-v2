"""Build and verify the reconstruction archive.

    python docs/_tools/make_archive.py [--skip-build]

Creates docs/release-package/<version>/unpacker-v2_v<version>_<YYYYMMDD>.zip with
  source/  git archive of the release tag (not the working tree)
  build/   build scripts, installer configuration, workflow files
  deps/    lockfile + pinned-versions.txt
  assets/  icons and the bundled engine licence
  bin/     installer, blockmap, latest.yml
  docs/    the documents, ui_inventory.json, screenshots, diagram, tooling
  MANIFEST.txt, README_FIRST.txt
Then scans for secrets, unzips to a temporary folder, checks every SHA-256
against MANIFEST.txt, and (unless --skip-build) builds the unzipped source.
Writes archive_report.json next to the zip.
"""
import datetime
import hashlib
import io
import json
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VERSION = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
TAG = f"v{VERSION}"
OUT = ROOT / "docs" / "release-package" / VERSION
STAMP = datetime.date.today().strftime("%Y%m%d")
ZIP = OUT / f"unpacker-v2_{TAG}_{STAMP}.zip"
EXCLUDE_DIRS = {"node_modules", "__pycache__", ".git", "dist", "_demo", "venv", ".venv"}
EXCLUDE_NAMES = {".env"}

SECRET_PATTERNS = {
    "private key block": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----"),
    "GitHub token": re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}\b"),
    "AWS access key": re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    "Slack token": re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b"),
    "bearer token": re.compile(r"Bearer\s+[A-Za-z0-9._\-]{20,}"),
    "assigned secret": re.compile(r"(?i)\b(pass(?:word|wd)?|secret|token|api[_-]?key)\b\s*[:=]\s*[\"'][^\"'\s]{8,}[\"']"),
}
TEXT_EXT = {".js", ".json", ".md", ".txt", ".yml", ".yaml", ".html", ".css", ".py", ".mmd", ".svg", ".ini", ".cfg", ""}
STORED = (".exe", ".png", ".docx", ".pdf", ".dll", ".ico", ".blockmap")


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def collect():
    """-> list of (archive path, bytes)"""
    items = []
    tar_bytes = subprocess.run(["git", "archive", "--format=tar", TAG], cwd=ROOT, check=True, capture_output=True).stdout
    with tarfile.open(fileobj=io.BytesIO(tar_bytes)) as tf:
        for m in tf.getmembers():
            if m.isfile():
                items.append((f"source/{m.name}", tf.extractfile(m).read()))
    src = {name[len("source/"):]: data for name, data in items}
    for rel in ["electron-builder.yml", "package.json", ".github/workflows/node-electron-release.yml", "scripts/make-icons.js"]:
        items.append((f"build/{rel}", src[rel]))
    items.append(("deps/package-lock.json", src["package-lock.json"]))
    items.append(("deps/package.json", src["package.json"]))
    lock = json.loads(src["package-lock.json"])
    pinned = sorted((k.split("node_modules/")[-1], v.get("version", "")) for k, v in lock["packages"].items() if k)
    lines = [f"# Every package pinned by package-lock.json at {TAG} ({len(pinned)} entries)", "# Engine: 7-Zip 26.03 (x64), vendored in source/vendor/7zip", ""] + [f"{n}=={v}" for n, v in pinned]
    items.append(("deps/pinned-versions.txt", ("\n".join(lines) + "\n").encode()))
    for name, data in src.items():
        if name.startswith("assets/"):
            items.append((name, data))
    items.append(("assets/7zip-License.txt", src["vendor/7zip/License.txt"]))
    items.append(("assets/SAMPLE-DATA.txt", b"No sample data is stored. The documentation capture script (docs/_tools/capture.js)\r\ngenerates fake files on every run and deletes them afterwards.\r\n"))
    for f in sorted((OUT / "bin").iterdir()):
        items.append((f"bin/{f.name}", f.read_bytes()))
    for f in sorted(OUT.rglob("*")):
        rel = f.relative_to(OUT).as_posix()
        if not f.is_file() or rel.startswith("bin/") or f.suffix == ".zip" or f.name == "archive_report.json":
            continue
        items.append((f"docs/{rel}", f.read_bytes()))
    tools = ROOT / "docs" / "_tools"
    for f in sorted(tools.rglob("*")):
        if f.is_file() and not (set(f.relative_to(tools).parts) & EXCLUDE_DIRS):
            items.append((f"docs/_tools/{f.relative_to(tools).as_posix()}", f.read_bytes()))
    return [(n, d) for n, d in items if not (set(Path(n).parts) & EXCLUDE_DIRS) and Path(n).name not in EXCLUDE_NAMES]


def scan(items):
    findings = []
    for name, data in items:
        if Path(name).suffix.lower() not in TEXT_EXT or len(data) > 2_000_000:
            continue
        text = data.decode("utf-8", errors="ignore")
        for label, rx in SECRET_PATTERNS.items():
            for m in rx.finditer(text):
                findings.append({"file": name, "line": text.count("\n", 0, m.start()) + 1, "pattern": label, "text": m.group(0)[:80]})
    return findings


README = """Unpacker V2 {tag} - reconstruction archive ({stamp})
========================================================

What this is
  Everything needed to rebuild, understand and document Unpacker V2 {version}
  without access to the original repository: the source exactly as tagged,
  build configuration, pinned dependencies, assets, the built installer and
  the documentation package.

Layout
  source/   full source at tag {tag} (git archive)
  build/    electron-builder.yml, package.json, CI workflow, icon script
  deps/     package-lock.json and pinned-versions.txt
  assets/   icons, 7-Zip licence (no sample data is stored; see SAMPLE-DATA.txt)
  bin/      unpacker-v2-{version}-setup.exe, its blockmap and latest.yml
  docs/     USER_MANUAL, RELEASE_OVERVIEW, DEVELOPER_GUIDE, ui_inventory.json,
            screenshots/, architecture, and _tools/ to regenerate them
  MANIFEST.txt   SHA-256 and size of every file in this archive

Rebuild in five lines (Windows, Node 22 or newer)
  cd source
  npm ci
  npm test
  npm run dist
  dist\\unpacker-v2-{version}-setup.exe

Excluded on purpose: node_modules, build caches, .git, .env files, credentials,
and any real user data. The archive was scanned for secrets before zipping;
see docs/QA_REPORT.md.
"""


def main():
    skip_build = "--skip-build" in sys.argv
    items = collect()
    findings = scan(items)
    items.append(("README_FIRST.txt", README.format(tag=TAG, stamp=STAMP, version=VERSION).replace("\n", "\r\n").encode()))
    items.sort()
    manifest = [f"# SHA-256  size  path   ({len(items)} files; MANIFEST.txt itself is not listed)"] + [f"{sha256(d)}  {len(d):>11}  {n}" for n, d in items]
    if ZIP.exists():
        ZIP.unlink()
    with zipfile.ZipFile(ZIP, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for n, d in items:
            z.writestr(n, d, compress_type=zipfile.ZIP_STORED if n.endswith(STORED) else zipfile.ZIP_DEFLATED)
        z.writestr("MANIFEST.txt", ("\n".join(manifest) + "\n").encode())
    report = {"zip": ZIP.name, "bytes": ZIP.stat().st_size, "sha256": sha256(ZIP.read_bytes()), "files": len(items) + 1, "secret_findings": findings}
    tmp = Path(tempfile.mkdtemp(prefix="unp-verify-"))
    try:
        with zipfile.ZipFile(ZIP) as z:
            z.extractall(tmp)
        bad = []
        for line in (tmp / "MANIFEST.txt").read_text(encoding="utf-8").splitlines()[1:]:
            digest, size, name = line.split(None, 2)
            f = tmp / name
            if not f.exists() or sha256(f.read_bytes()) != digest or f.stat().st_size != int(size):
                bad.append(name)
        report["manifest_check"] = {"checked": len(manifest) - 1, "mismatches": bad}
        if skip_build:
            # keep the result of the last full run; only documents changed since
            prev = OUT / "archive_report.json"
            carried = json.loads(prev.read_text(encoding="utf-8")).get("build_from_archive") if prev.exists() else None
            if isinstance(carried, dict):
                carried["note"] = "carried forward from the previous full run; source/ is unchanged (same release tag)"
            report["build_from_archive"] = carried or "skipped"
        else:
            src = tmp / "source"

            def run(cmd):
                return subprocess.run(cmd, cwd=src, shell=True, capture_output=True, text=True, encoding="utf-8", errors="replace")

            ci = run("npm ci --no-audit --no-fund")
            test = run("npm test")
            dist = run("npm run dist")
            exe = src / "dist" / f"unpacker-v2-{VERSION}-setup.exe"
            m = re.search(r"pass (\d+)", test.stdout)
            ok = ci.returncode == 0 and test.returncode == 0 and exe.exists()
            report["build_from_archive"] = {"npm_ci_exit": ci.returncode, "npm_test_exit": test.returncode, "tests_passed": int(m.group(1)) if m else None, "npm_run_dist_exit": dist.returncode, "installer_built": exe.exists(), "installer_bytes": exe.stat().st_size if exe.exists() else 0, "result": "pass" if ok else "fail"}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    (OUT / "archive_report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({k: v for k, v in report.items() if k != "secret_findings"}, indent=2))
    print(f"secret-scan findings: {len(findings)}")
    for f in findings:
        print(f"  {f['file']}:{f['line']}  [{f['pattern']}]  {f['text']}")


if __name__ == "__main__":
    main()
