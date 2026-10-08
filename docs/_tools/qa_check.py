"""Quality checks on the generated documentation package.

    python docs/_tools/qa_check.py

Checks, and writes qa_results.json:
  1. every control in ui_inventory.json appears by name in USER_MANUAL.docx
  2. every screenshot callout number has a matching table row (same control name)
  3. each .docx: embedded pictures are present and non-empty; the table of
     contents was filled in; each .pdf exists and its page count is read back
  4. every screenshot exists in all four variants
"""
import json
import re
import subprocess
import zipfile
from pathlib import Path

from docx import Document

ROOT = Path(__file__).resolve().parents[2]
VERSION = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
OUT = ROOT / "docs" / "release-package" / VERSION
SHOTS = OUT / "screenshots"


def pdf_pages(pdf):
    try:
        r = subprocess.run(["gswin64c", "-q", "-dNODISPLAY", "-dNOSAFER", "-c", f"({pdf.as_posix()}) (r) file runpdfbegin pdfpagecount = quit"], capture_output=True, text=True)
        return int(r.stdout.strip())
    except Exception:
        return None


def main():
    inv = json.loads((OUT / "ui_inventory.json").read_text(encoding="utf-8"))
    doc = Document(OUT / "USER_MANUAL.docx")
    tables = [[[c.text.strip() for c in row.cells] for row in t.rows] for t in doc.tables]
    callout_tables = [t for t in tables if t and t[0][:2] == ["Number", "Control name"]]
    names_in_manual = {row[1] for t in callout_tables for row in t[1:]}

    res = {"version": VERSION}
    # 1
    controls = [(s["id"], c["id"], c["name"]) for s in inv["surfaces"] for c in s["controls"]]
    missing = [f"{sid}/{cid} ({name})" for sid, cid, name in controls if name not in names_in_manual]
    res["inventory_controls"] = len(controls)
    res["inventory_surfaces"] = len(inv["surfaces"])
    res["controls_missing_from_manual"] = missing
    res["inventory_lines_unverified"] = [f"{s['id']}/{c['id']}" for s in inv["surfaces"] for c in s["controls"] if c["defined_at"].endswith("UNVERIFIED")]

    # 2
    mismatches = []
    checked = 0
    by_surface = {s["id"]: s for s in inv["surfaces"]}
    for meta in sorted(SHOTS.glob("*.callouts.json")):
        m = json.loads(meta.read_text(encoding="utf-8"))
        s = by_surface[m["surface"]]
        table = next((t for t in callout_tables if {r[1] for r in t[1:]} == {c["name"] for c in s["controls"]}), None)
        if table is None:
            mismatches.append(f"{meta.name}: no table found for surface {m['surface']}")
            continue
        rows = {r[0]: r[1] for r in table[1:]}
        numbers = [c["number"] for c in m["callouts"]]
        if numbers != list(range(1, len(numbers) + 1)):
            mismatches.append(f"{meta.name}: callout numbers are not 1..n")
        for c in m["callouts"]:
            checked += 1
            if rows.get(str(c["number"])) != c["name"]:
                mismatches.append(f"{meta.name}: callout {c['number']} is “{c['name']}” but the table row says “{rows.get(str(c['number']))}”")
    res["callouts_checked"] = checked
    res["callout_mismatches"] = mismatches

    # 3
    docs = {}
    for name in ["USER_MANUAL", "RELEASE_OVERVIEW", "DEVELOPER_GUIDE"]:
        entry = {}
        dx = OUT / f"{name}.docx"
        if dx.exists():
            with zipfile.ZipFile(dx) as z:
                media = [i for i in z.infolist() if i.filename.startswith("word/media/")]
                xml = z.read("word/document.xml").decode("utf-8", errors="ignore")
            toc = re.search(r"Table of contents.*?</w:sdt>|TOC \\\\?", xml, re.S)
            entry["docx_bytes"] = dx.stat().st_size
            entry["pictures"] = len(media)
            entry["empty_pictures"] = [i.filename for i in media if i.file_size == 0]
            entry["contents_links"] = len(re.findall(r'<w:hyperlink w:anchor="', xml))
        md = OUT / f"{name}.md"
        if md.exists():
            entry["md_bytes"] = md.stat().st_size
        pdf = OUT / f"{name}.pdf"
        entry["pdf_bytes"] = pdf.stat().st_size if pdf.exists() else 0
        entry["pdf_pages"] = pdf_pages(pdf) if pdf.exists() else None
        docs[name] = entry
    res["documents"] = docs

    # 4
    shots = sorted({s["screenshot"] for s in inv["surfaces"] if s["screenshot"]})
    absent = [f"{s}{t}_{k}.png" for s in shots for t in ("", "_dark") for k in ("clean", "annotated") if not (SHOTS / f"{s}{t}_{k}.png").exists()]
    res["screenshots_expected"] = len(shots) * 4
    res["screenshots_missing"] = absent
    res["surfaces_without_screenshot"] = [s["name"] for s in inv["surfaces"] if not s["screenshot"]]
    res["capture_report"] = (SHOTS / "capture_report.txt").read_text(encoding="utf-8").strip()

    (OUT / "qa_results.json").write_text(json.dumps(res, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(res, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
