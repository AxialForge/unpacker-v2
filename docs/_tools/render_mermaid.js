// Renders a Mermaid source file to PNG using the Electron already installed for
// the application (no extra browser download).
//   node docs/_tools/render_mermaid.js <in.mmd> <out.png>
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { _electron } = require("playwright-core");
const ROOT = path.resolve(__dirname, "..", "..");
(async () => {
  const [src, out] = process.argv.slice(2).map((p) => path.resolve(p));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "unp-mmd-"));
  fs.writeFileSync(path.join(work, "main.js"), `const {app,BrowserWindow}=require("electron");app.whenReady().then(()=>{const w=new BrowserWindow({width:1700,height:1500,show:true,enableLargerThanScreen:true});w.loadFile(${JSON.stringify(path.join(work, "index.html"))});});app.on("window-all-closed",()=>app.quit());`);
  fs.copyFileSync(path.join(__dirname, "node_modules", "mermaid", "dist", "mermaid.min.js"), path.join(work, "mermaid.min.js"));
  fs.writeFileSync(path.join(work, "index.html"), `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#fff;font-family:Segoe UI;overflow:hidden"><pre class="mermaid" id="d">${fs.readFileSync(src, "utf8").replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre><script src="mermaid.min.js"></script><script>mermaid.initialize({startOnLoad:true,theme:"neutral",flowchart:{useMaxWidth:false,htmlLabels:true},themeVariables:{fontFamily:"Segoe UI",fontSize:"15px"}});</script></body>`);
  const app = await _electron.launch({ executablePath: require(path.join(ROOT, "node_modules", "electron")), args: [path.join(work, "main.js"), "--force-device-scale-factor=2"] });
  const page = await app.firstWindow();
  await page.waitForSelector("#d svg", { timeout: 30000 });
  await page.waitForTimeout(500);
  const box = await page.evaluate(() => { const r = document.querySelector("#d svg").getBoundingClientRect(); return { w: Math.ceil(r.right) + 8, h: Math.ceil(r.bottom) + 8 }; });
  await app.evaluate(({ BrowserWindow }, b) => BrowserWindow.getAllWindows()[0].setContentSize(b.w, b.h), box);
  await page.waitForTimeout(400);
  const img = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString("base64"));
  fs.writeFileSync(out, Buffer.from(img, "base64"));
  await app.close();
  fs.rmSync(work, { recursive: true, force: true });
  console.log("rendered", out);
})().catch((e) => { console.error(e); process.exit(1); });
