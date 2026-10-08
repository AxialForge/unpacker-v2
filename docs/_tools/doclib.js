// A tiny block language shared by the three documents, with two renderers:
//   toDocx(doc)      -> .docx via the "docx" package (cover, contents, headers, page numbers)
//   toMarkdown(doc)  -> GitHub-flavoured Markdown
//
// Blocks:
//   { h: 1|2|3, t }                      heading
//   { p: "text with `code` and **bold**" }
//   { ul: [..] } / { ol: [..] }          bullet / numbered list
//   { table: { head: [..], rows: [[..]], widths: [..dxa], small: true } }
//   { img: absPath, caption, widthPx }   picture (PNG)
//   { code: "multi\nline" }              fixed-width block
//   { note: "text" }                     shaded call-out
//   { pb: true }                         page break

const fs = require("node:fs");
const path = require("node:path");
const D = require("docx");

const CONTENT_DXA = 9360; // US Letter, 1 inch margins
const FONT = "Segoe UI";
const MONO = "Consolas";
const ACCENT = "1F4E79";

function pngSize(file) {
  const b = fs.readFileSync(file);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), data: b };
}

function runs(text, base = {}) {
  const out = [];
  const parts = String(text).split(/(`[^`]+`|\*\*[^*]+\*\*)/g).filter((s) => s !== "");
  for (const s of parts) {
    if (s.startsWith("`")) out.push(new D.TextRun({ text: s.slice(1, -1), font: MONO, ...base }));
    else if (s.startsWith("**")) out.push(new D.TextRun({ text: s.slice(2, -2), bold: true, ...base }));
    else out.push(new D.TextRun({ text: s, ...base }));
  }
  return out;
}

function cell(text, width, opts = {}) {
  return new D.TableCell({
    width: { size: width, type: D.WidthType.DXA },
    margins: { top: 50, bottom: 50, left: 80, right: 80 },
    shading: opts.head ? { type: D.ShadingType.CLEAR, color: "auto", fill: "DCE6F1" } : undefined,
    children: String(text == null ? "" : text)
      .split("\n")
      .map((line) => new D.Paragraph({ spacing: { after: 0 }, children: runs(line, { size: opts.small ? 16 : 19, bold: opts.head || undefined }) })),
  });
}

function table(t) {
  const n = t.head.length;
  let widths = t.widths || Array(n).fill(Math.floor(CONTENT_DXA / n));
  const sum = widths.reduce((a, b) => a + b, 0);
  widths = widths.map((w, i) => (i === n - 1 ? w + (CONTENT_DXA - sum) : w));
  const border = { style: D.BorderStyle.SINGLE, size: 4, color: "A6A6A6" };
  return new D.Table({
    width: { size: CONTENT_DXA, type: D.WidthType.DXA },
    columnWidths: widths,
    borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
    rows: [
      new D.TableRow({ tableHeader: true, cantSplit: true, children: t.head.map((h, i) => cell(h, widths[i], { head: true, small: t.small })) }),
      ...t.rows.map((r) => new D.TableRow({ cantSplit: true, children: r.map((c, i) => cell(c, widths[i], { small: t.small })) })),
    ],
  });
}

function blockToDocx(b) {
  if (b.h) return [new D.Paragraph({ heading: [null, D.HeadingLevel.HEADING_1, D.HeadingLevel.HEADING_2, D.HeadingLevel.HEADING_3][b.h], pageBreakBefore: b.h === 1 && !b.noBreak, children: [new D.TextRun({ text: b.t })] })];
  if (b.p != null) return [new D.Paragraph({ spacing: { after: 120 }, children: runs(b.p) })];
  if (b.ul) return b.ul.map((t) => new D.Paragraph({ numbering: { reference: "bullets", level: 0 }, spacing: { after: 40 }, children: runs(t) }));
  if (b.ol) return b.ol.map((t) => new D.Paragraph({ numbering: { reference: b.ref, level: 0 }, spacing: { after: 40 }, children: runs(t) }));
  if (b.table) return [table(b.table), new D.Paragraph({ spacing: { after: 120 }, children: [] })];
  if (b.img) {
    const { w, h, data } = pngSize(b.img);
    const width = Math.min(b.widthPx || 624, 624);
    const out = [new D.Paragraph({ alignment: D.AlignmentType.CENTER, keepNext: !!b.caption, spacing: { before: 80, after: 40 }, children: [new D.ImageRun({ type: "png", data, transformation: { width, height: Math.round((h / w) * width) }, altText: { title: b.caption || path.basename(b.img), description: b.caption || path.basename(b.img), name: path.basename(b.img) } })] })];
    if (b.caption) out.push(new D.Paragraph({ alignment: D.AlignmentType.CENTER, spacing: { after: 160 }, children: [new D.TextRun({ text: b.caption, italics: true, size: 18, color: "595959" })] }));
    return out;
  }
  if (b.code != null)
    return b.code.split("\n").map(
      (line, i, all) =>
        new D.Paragraph({
          spacing: { after: i === all.length - 1 ? 140 : 0 },
          shading: { type: D.ShadingType.CLEAR, color: "auto", fill: "F2F2F2" },
          children: [new D.TextRun({ text: line || " ", font: MONO, size: 17 })],
        })
    );
  if (b.note) return [new D.Paragraph({ spacing: { before: 60, after: 140 }, shading: { type: D.ShadingType.CLEAR, color: "auto", fill: "FFF4CE" }, border: { left: { style: D.BorderStyle.SINGLE, size: 18, color: "BF8F00", space: 6 } }, children: runs(b.note) })];
  if (b.pb) return [new D.Paragraph({ children: [new D.PageBreak()] })];
  throw new Error(`unknown block: ${JSON.stringify(b).slice(0, 80)}`);
}

/** doc = { title, subtitle, version, buildDate, documentDate, blocks, coverLines } */
async function toDocx(doc, outFile) {
  // every numbered list gets its own numbering reference so each restarts at 1
  let olCount = 0;
  const numbering = [{ reference: "bullets", levels: [{ level: 0, format: D.LevelFormat.BULLET, text: "•", alignment: D.AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 270 } } } }] }];
  for (const b of doc.blocks) {
    if (b.ol) {
      olCount += 1;
      b.ref = `ol${olCount}`;
      numbering.push({ reference: b.ref, levels: [{ level: 0, format: D.LevelFormat.DECIMAL, text: "%1.", alignment: D.AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 360 } } } }] });
    }
  }
  const cover = [
    new D.Paragraph({ spacing: { before: 2600, after: 200 }, children: [new D.TextRun({ text: doc.title, bold: true, size: 64, color: ACCENT })] }),
    new D.Paragraph({ spacing: { after: 600 }, border: { bottom: { style: D.BorderStyle.SINGLE, size: 12, color: ACCENT, space: 8 } }, children: [new D.TextRun({ text: doc.subtitle, size: 36 })] }),
    ...(doc.coverLines || []).map((l) => new D.Paragraph({ spacing: { after: 80 }, children: runs(l, { size: 24 }) })),
    new D.Paragraph({ children: [new D.PageBreak()] }),
    new D.Paragraph({ spacing: { after: 200 }, children: [new D.TextRun({ text: "Table of contents", bold: true, size: 32, color: ACCENT })] }),
    new D.TableOfContents("Table of contents", { hyperlink: true, headingStyleRange: "1-2" }),
  ];
  const d = new D.Document({
    creator: "AxialForge",
    title: `${doc.title} — ${doc.subtitle}`,
    description: `Version ${doc.version}`,
    features: { updateFields: true },
    numbering: { config: numbering },
    styles: {
      default: { document: { run: { font: FONT, size: 21 } } },
      paragraphStyles: [
        { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true, run: { font: FONT, size: 34, bold: true, color: ACCENT }, paragraph: { spacing: { before: 0, after: 200 }, outlineLevel: 0 } },
        { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true, run: { font: FONT, size: 27, bold: true, color: ACCENT }, paragraph: { spacing: { before: 300, after: 140 }, outlineLevel: 1, keepNext: true } },
        { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true, run: { font: FONT, size: 23, bold: true }, paragraph: { spacing: { before: 220, after: 100 }, outlineLevel: 2, keepNext: true } },
      ],
    },
    sections: [
      {
        properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
        headers: { default: new D.Header({ children: [new D.Paragraph({ alignment: D.AlignmentType.RIGHT, border: { bottom: { style: D.BorderStyle.SINGLE, size: 4, color: "A6A6A6", space: 4 } }, children: [new D.TextRun({ text: `${doc.title} — ${doc.subtitle} — version ${doc.version}`, size: 16, color: "595959" })] })] }) },
        footers: { default: new D.Footer({ children: [new D.Paragraph({ alignment: D.AlignmentType.CENTER, children: [new D.TextRun({ size: 16, color: "595959", children: ["Page ", D.PageNumber.CURRENT, " of ", D.PageNumber.TOTAL_PAGES] })] })] }) },
        children: [...cover, ...doc.blocks.flatMap(blockToDocx)],
      },
    ],
  });
  fs.writeFileSync(outFile, await D.Packer.toBuffer(d));
}

function mdEscape(s) {
  return String(s == null ? "" : s).replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

function toMarkdown(doc, outFile) {
  const rel = (p) => path.relative(path.dirname(outFile), p).replace(/\\/g, "/");
  const L = [`# ${doc.title} — ${doc.subtitle}`, "", ...(doc.coverLines || []).map((l) => `${l}  `), ""];
  L.push("## Contents", "");
  for (const b of doc.blocks) if (b.h === 1) L.push(`- [${b.t}](#${b.t.toLowerCase().replace(/[^a-z0-9 -]/g, "").replace(/ /g, "-")})`);
  L.push("");
  for (const b of doc.blocks) {
    if (b.h) L.push(`${"#".repeat(b.h + 1)} ${b.t}`, "");
    else if (b.p != null) L.push(b.p, "");
    else if (b.ul) L.push(...b.ul.map((t) => `- ${t}`), "");
    else if (b.ol) L.push(...b.ol.map((t, i) => `${i + 1}. ${t}`), "");
    else if (b.table) L.push(`| ${b.table.head.map(mdEscape).join(" | ")} |`, `| ${b.table.head.map(() => "---").join(" | ")} |`, ...b.table.rows.map((r) => `| ${r.map(mdEscape).join(" | ")} |`), "");
    else if (b.img) L.push(`![${b.caption || ""}](${encodeURI(rel(b.img))})`, b.caption ? `*${b.caption}*` : "", "");
    else if (b.code != null) L.push("```", b.code, "```", "");
    else if (b.note) L.push(`> ${b.note}`, "");
  }
  fs.writeFileSync(outFile, L.join("\n"), "utf8");
}

module.exports = { toDocx, toMarkdown, CONTENT_DXA };
