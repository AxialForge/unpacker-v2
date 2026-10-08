// Builds ui_inventory.json from ui_spec.js, resolving a verified file:line for
// every surface and control by searching the application source. Fails loudly
// when something in the spec no longer exists in the code.
//
//   node docs/_tools/build_inventory.js <outDir>

const fs = require("node:fs");
const path = require("node:path");
const spec = require("./ui_spec");

const ROOT = path.resolve(__dirname, "..", "..");
const outDir = path.resolve(process.argv[2] || path.join(ROOT, "docs", "release-package", require(path.join(ROOT, "package.json")).version));
const cache = new Map();
const lines = (file) => {
  if (!cache.has(file)) cache.set(file, fs.readFileSync(path.join(ROOT, file), "utf8").split(/\r?\n/));
  return cache.get(file);
};
const missing = [];
function locate(file, find, what) {
  const i = lines(file).findIndex((l) => l.includes(find));
  if (i < 0) {
    missing.push(`${what}: "${find}" not found in ${file}`);
    return `${file}:UNVERIFIED`;
  }
  return `${file}:${i + 1}`;
}

// ids present in the page that the spec does not mention (would be a documentation gap)
const html = fs.readFileSync(path.join(ROOT, "src/renderer/index.html"), "utf8");
const htmlIds = [...html.matchAll(/\bid="([A-Za-z0-9_]+)"/g)].map((m) => m[1]);
const specIds = new Set(spec.flatMap((s) => s.controls.map((c) => c.id)));
const CONTAINERS = new Set(["tabs", "tabTakeout", "tabArchives", "pageSettings", "pageAbout", "pwModal", "convModal", "pkModal", "meModal", "tkModal", "actionSeg", "pkPreset", "queue", "groups", "notices", "archivesActions", "wzDestRow", "wzExtractPanel", "wzPhotoOpts", "wzServiceOpts", "meMergeRow", "pkHashRow", "pkPlaceRow", "pkTitle"]);
const undocumented = htmlIds.filter((id) => !specIds.has(id) && !CONTAINERS.has(id));

const inventory = {
  project: "Unpacker V2",
  version: require(path.join(ROOT, "package.json")).version,
  generated: new Date().toISOString(),
  generator: "docs/_tools/build_inventory.js",
  surfaces: spec.map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.kind,
    parent: s.parent,
    defined_at: locate(s.file, s.find, `surface ${s.id}`),
    screenshot: s.shot,
    purpose: s.purpose,
    controls: s.controls.map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      selector: c.sel,
      defined_at: locate(c.file, c.find, `control ${s.id}/${c.id}`),
      what_it_does: c.does,
      inputs_and_limits: c.inputs,
      default: c.def,
      notes: c.notes,
    })),
  })),
  containers_not_listed_as_controls: [...CONTAINERS].sort(),
  element_ids_without_a_spec_entry: undocumented,
};
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "ui_inventory.json"), JSON.stringify(inventory, null, 2));
const n = inventory.surfaces.reduce((a, s) => a + s.controls.length, 0);
console.log(`${inventory.surfaces.length} surfaces, ${n} controls -> ${path.join(outDir, "ui_inventory.json")}`);
if (undocumented.length) console.log("element ids with no spec entry:", undocumented.join(", "));
if (missing.length) {
  console.error(missing.join("\n"));
  process.exit(1);
}
