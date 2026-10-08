"""Refresh the table of contents of a .docx and export it to PDF with LibreOffice.

Run with LibreOffice's own Python (it ships the UNO bridge):

    "C:\\Program Files\\LibreOffice\\program\\python.exe" docs/_tools/to_pdf.py file1.docx [file2.docx ...]

For each file: opens it hidden, updates every index (the table of contents is
written by the builder as an empty field), saves the .docx back with the
contents filled in, and writes <name>.pdf next to it.
"""
import os
import subprocess
import sys
import time

import uno
from com.sun.star.beans import PropertyValue

SOFFICE = os.path.join(os.path.dirname(sys.executable), "soffice.exe")
PORT = 2002


def prop(name, value):
    p = PropertyValue()
    p.Name = name
    p.Value = value
    return p


def connect():
    local = uno.getComponentContext()
    resolver = local.ServiceManager.createInstanceWithContext("com.sun.star.bridge.UnoUrlResolver", local)
    for _ in range(60):
        try:
            return resolver.resolve(f"uno:socket,host=127.0.0.1,port={PORT};urp;StarOffice.ComponentContext")
        except Exception:
            time.sleep(0.5)
    raise RuntimeError("could not connect to LibreOffice")


def main(files):
    profile = os.path.join(os.environ.get("TEMP", "."), "unpacker-docs-lo-profile")
    proc = subprocess.Popen([SOFFICE, "--headless", "--invisible", "--norestore", "--nologo", f"-env:UserInstallation={uno.systemPathToFileUrl(profile)}", f"--accept=socket,host=127.0.0.1,port={PORT};urp;"])
    try:
        ctx = connect()
        desktop = ctx.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)
        for f in files:
            f = os.path.abspath(f)
            doc = desktop.loadComponentFromURL(uno.systemPathToFileUrl(f), "_blank", 0, (prop("Hidden", True),))
            indexes = doc.getDocumentIndexes()
            for i in range(indexes.getCount()):
                indexes.getByIndex(i).update()
            doc.refresh()
            for i in range(indexes.getCount()):  # second pass: page numbers settle after layout
                indexes.getByIndex(i).update()
            doc.storeToURL(uno.systemPathToFileUrl(f), (prop("FilterName", "MS Word 2007 XML"),))
            pdf = os.path.splitext(f)[0] + ".pdf"
            doc.storeToURL(uno.systemPathToFileUrl(pdf), (prop("FilterName", "writer_pdf_Export"),))
            pages = doc.getCurrentController().getPropertyValue("PageCount")
            count = indexes.getCount()
            doc.close(True)
            print(f"{os.path.basename(pdf)}: {pages} pages, {count} index updated")
        try:
            desktop.terminate()
        except Exception:
            pass
    finally:
        time.sleep(1)
        if proc.poll() is None:
            proc.terminate()


if __name__ == "__main__":
    main(sys.argv[1:])
