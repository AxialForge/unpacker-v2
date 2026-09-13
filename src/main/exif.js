// Minimal JPEG EXIF date writer. Pure Node, no dependencies.
//
// Goal: make a photo's "date taken" survive copying, by embedding
// DateTimeOriginal (0x9003) and DateTimeDigitized (0x9004) in the Exif IFD.
//
// Cases handled:
//   * no APP1/Exif segment at all      -> a new minimal Exif segment is inserted after SOI
//   * Exif present, tags present       -> the 20-byte ASCII values are overwritten in place
//   * Exif present, tags missing       -> NOT rewritten (rebuilding IFDs safely is out of
//                                         scope); returns { written:false, reason }
// Only JPEG. HEIC/PNG/MP4 are refused by isJpeg().

const SOI = 0xffd8;

function isJpeg(buf) {
  return buf.length > 4 && buf.readUInt16BE(0) === SOI;
}

/** "2019:07:01 10:00:00" in local time of the machine doing the organizing? No: use UTC
 *  fields of the given Date, which is what Google's timestamp represents once converted. */
function exifDate(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}:${p(date.getUTCMonth() + 1)}:${p(date.getUTCDate())} ${p(date.getUTCHours())}:${p(date.getUTCMinutes())}:${p(date.getUTCSeconds())}`;
}

/** Walk JPEG segments; returns [{ marker, start, length }] up to SOS. */
function segments(buf) {
  const out = [];
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) break;
    const marker = buf[i + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    out.push({ marker, start: i, length: len + 2 });
    if (marker === 0xda) break; // SOS: image data follows
    i += len + 2;
  }
  return out;
}

/**
 * Find the Exif IFD's DateTimeOriginal / DateTimeDigitized value offsets
 * inside an APP1 Exif segment. Returns { offsets: {0x9003, 0x9004} } with
 * absolute buffer offsets of the 20-byte ASCII values (when present).
 */
function findDateTags(buf, seg) {
  const tiff = seg.start + 4 + 6; // marker(2) + len(2) + "Exif\0\0"(6)
  if (buf.toString("ascii", seg.start + 4, seg.start + 10) !== "Exif\0\0") return null;
  const le = buf.toString("ascii", tiff, tiff + 2) === "II";
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  if (u16(tiff + 2) !== 0x2a) return null;
  const ifd0 = tiff + u32(tiff + 4);
  const readIfd = (off) => {
    const n = u16(off);
    const entries = [];
    for (let k = 0; k < n; k += 1) {
      const e = off + 2 + k * 12;
      if (e + 12 > buf.length) break;
      entries.push({ tag: u16(e), type: u16(e + 2), count: u32(e + 4), valueOff: e + 8 });
    }
    return entries;
  };
  const exifPtr = readIfd(ifd0).find((e) => e.tag === 0x8769);
  if (!exifPtr) return { offsets: {} };
  const exifIfd = tiff + u32(exifPtr.valueOff);
  const offsets = {};
  for (const e of readIfd(exifIfd)) {
    if ((e.tag === 0x9003 || e.tag === 0x9004) && e.type === 2 && e.count === 20) offsets[e.tag] = tiff + u32(e.valueOff);
  }
  return { offsets };
}

/** Build a minimal APP1 Exif segment (big-endian TIFF) carrying the two date tags. */
function buildExifSegment(dateStr) {
  const value = Buffer.from(`${dateStr}\0`, "ascii"); // 20 bytes
  // TIFF header (8) + IFD0: count(2) + 1 entry(12) + next(4) = 18 -> Exif IFD at 26
  // Exif IFD: count(2) + 2 entries(24) + next(4) = 30 -> values at 56 and 76
  const tiff = Buffer.alloc(8 + 18 + 30 + 40);
  tiff.write("MM", 0, "ascii");
  tiff.writeUInt16BE(0x2a, 2);
  tiff.writeUInt32BE(8, 4);
  // IFD0
  tiff.writeUInt16BE(1, 8);
  tiff.writeUInt16BE(0x8769, 10); // ExifIFDPointer
  tiff.writeUInt16BE(4, 12); // LONG
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt32BE(26, 18);
  tiff.writeUInt32BE(0, 22); // next IFD
  // Exif IFD at 26
  tiff.writeUInt16BE(2, 26);
  const entry = (at, tag, valOff) => {
    tiff.writeUInt16BE(tag, at);
    tiff.writeUInt16BE(2, at + 2); // ASCII
    tiff.writeUInt32BE(20, at + 4);
    tiff.writeUInt32BE(valOff, at + 8);
  };
  entry(28, 0x9003, 56);
  entry(40, 0x9004, 76);
  tiff.writeUInt32BE(0, 52);
  value.copy(tiff, 56);
  value.copy(tiff, 76);
  const body = Buffer.concat([Buffer.from("Exif\0\0", "ascii"), tiff]);
  const head = Buffer.alloc(4);
  head.writeUInt16BE(0xffe1, 0);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
}

/**
 * Set DateTimeOriginal/Digitized in a JPEG buffer.
 * @returns {{ buf: Buffer, written: boolean, reason?: string, mode?: "insert"|"overwrite" }}
 */
function setDateTaken(buf, date) {
  if (!isJpeg(buf)) return { buf, written: false, reason: "not a JPEG" };
  const dateStr = exifDate(date);
  const segs = segments(buf);
  const app1 = segs.find((s) => s.marker === 0xe1 && buf.toString("ascii", s.start + 4, s.start + 10) === "Exif\0\0");
  if (!app1) {
    // Insert after SOI (and after a JFIF APP0 if present, which spec-wise should come first).
    const app0 = segs.find((s) => s.marker === 0xe0);
    const at = app0 ? app0.start + app0.length : 2;
    const out = Buffer.concat([buf.subarray(0, at), buildExifSegment(dateStr), buf.subarray(at)]);
    return { buf: out, written: true, mode: "insert" };
  }
  const found = findDateTags(buf, app1);
  if (!found) return { buf, written: false, reason: "unreadable Exif" };
  const targets = [found.offsets[0x9003], found.offsets[0x9004]].filter(Boolean);
  if (!targets.length) return { buf, written: false, reason: "Exif present without date tags" };
  const out = Buffer.from(buf);
  for (const off of targets) out.write(`${dateStr}\0`, off, 20, "ascii");
  return { buf: out, written: true, mode: "overwrite" };
}

/** Read DateTimeOriginal if present (for tests and "already has a date" checks). */
function getDateTaken(buf) {
  if (!isJpeg(buf)) return null;
  const app1 = segments(buf).find((s) => s.marker === 0xe1 && buf.toString("ascii", s.start + 4, s.start + 10) === "Exif\0\0");
  if (!app1) return null;
  const found = findDateTags(buf, app1);
  const off = found && found.offsets[0x9003];
  return off ? buf.toString("ascii", off, off + 19) : null;
}

module.exports = { isJpeg, exifDate, setDateTaken, getDateTaken, segments };
