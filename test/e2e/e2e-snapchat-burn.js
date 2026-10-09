// Real compositor check: run the Snapchat wizard in the app (via shot:open) on a fake export
// with real PNG photos and a real overlay, burn on; then inspect the burned file.
const fs = require("node:fs"); const path = require("node:path"); const os = require("node:os");
const { execFileSync } = require("node:child_process");
const ROOT = require("node:path").resolve(__dirname, "..", "..");
const { _electron } = require(path.join(ROOT, "docs/_tools/node_modules/playwright-core"));
const ELECTRON = require(path.join(ROOT, "node_modules", "electron"));
const exif = require(path.join(ROOT, "src/main/exif"));
const Z = path.join(ROOT, "vendor/7zip/7z.exe");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "unp-burn-"));
const dl = path.join(work, "dl"); fs.mkdirSync(dl);
const st = path.join(work, "st");
const t = Date.UTC(2024, 6, 1, 15, 30, 45) / 1000;
const uuid = "00000000-0000-4000-8000-000000000007";
const put = (rel, data) => { const p = path.join(st, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); fs.utimesSync(p, new Date(t * 1000), new Date(t * 1000)); };
// photo: a real JPEG? we only have PNGs handy -> name it .jpg anyway? No: use a PNG photo named .png (type jpg by ext rule?) -> check MEDIA_RX type: ext png => "jpg" type only if the organiser maps non-mp4 to jpg.
const png = fs.readFileSync(path.join(ROOT, "docs/screenshots", fs.readdirSync(path.join(ROOT, "docs/screenshots")).find((n) => n.endsWith(".png"))));
// a red 2x2 PNG overlay with alpha (hand-made)
const overlay = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVQImWP4z8DwnwEKGBgYGP7//w8AJ6ID/3rJtQ4AAAAASUVORK5CYII=", "base64");
put(`memories/2024-07-01_${uuid}-main.png`, png);
put(`memories/2024-07-01_${uuid}-overlay.png`, overlay);
put("json/memories_history.json", JSON.stringify({ "Saved Media": [{ Date: "2024-07-01 15:30:45 UTC", "Media Type": "Image", Location: "Latitude, Longitude: 41.5, -81.6" }] }));
put("index.html", "<html></html>");
execFileSync(Z, ["a", "-tzip", path.join(dl, "mydata~1759900000009.zip"), "*"], { cwd: st, windowsHide: true, stdio: "ignore" });
(async () => {
  const app = await _electron.launch({ executablePath: ELECTRON, args: [path.join(ROOT, "src/main/main.js"), "--dev", `--user-data-dir=${path.join(work, "profile")}`], cwd: ROOT });
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.waitForLoadState("domcontentloaded"); await page.waitForTimeout(800);
  await app.evaluate(({ BrowserWindow }, a) => BrowserWindow.getAllWindows()[0].webContents.send("shot:open", a), { which: "snapchatTab", paths: [dl] });
  await page.waitForSelector("#scFound .tk-export");
  await page.click("#scNext");
  await page.waitForSelector('.wz-page[data-sc-page="2"]:not([hidden])');
  await page.check("#scBurn");
  await page.click("#scNext");
  await page.waitForSelector('.wz-page[data-sc-page="4"]:not([hidden])', { timeout: 120000 });
  const summary = await page.textContent("#scSummary");
  console.log(summary.trim().split("\n").slice(0, 3).join("\n"));
  const lib = path.join(dl, "Snapchat-export", "Snapchat Library", "Memories", "2024", "07");
  const files = fs.readdirSync(lib);
  console.log("files:", files.join(", "));
  const burned = files.find((n) => n.includes("with overlay"));
  if (burned) {
    const b = fs.readFileSync(path.join(lib, burned));
    console.log("burned bytes:", b.length, "jpeg:", b[0] === 0xff && b[1] === 0xd8, "exif date:", exif.getDateTaken(b), "gps:", JSON.stringify(exif.getGps(b)));
    fs.copyFileSync(path.join(lib, burned), path.join(os.tmpdir(), "unpacker-burned-sample.jpg"));
  }
  console.log("report:", fs.readFileSync(path.join(dl, "Snapchat-export", "Snapchat Library", "Snapchat library report.txt"), "utf8").split("\r\n").find((l) => l.includes("overlays")));
  console.log("errors:", errors.length ? errors : "none");
  await app.close();
  fs.rmSync(work, { recursive: true, force: true });
})().catch((e) => { console.error("CRASH", e); fs.rmSync(work, { recursive: true, force: true }); process.exit(2); });
