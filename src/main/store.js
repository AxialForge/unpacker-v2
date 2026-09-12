// Settings persisted as JSON under Electron's userData folder. Tiny and sync.

const fs = require("node:fs");
const path = require("node:path");

const DEFAULTS = {
  theme: "dark",
  format: "7z", // default creation target (see engine/formats.js TARGETS)
  level: 5, // LEVELS id
  split: "", // SPLIT_SIZES id
  onePerItem: false, // compress each dropped item into its own archive
  outputMode: "beside", // "beside" the source | "folder" (outputDir)
  outputDir: "",
  extractMode: "smart", // "smart" | "subfolder" | "here"
  overwrite: "rename", // "rename" | "overwrite" | "skip"
  verify: true, // run `7z t` after every create/convert
  deleteOriginalAfterConvert: false, // only after a passed verify; goes to Recycle Bin
  convertTarget: "7z",
  concurrency: 2,
  tempDir: "", // "" = OS temp
  allowHighRatio: false, // skip the zip-bomb refusal
  contextMenu: false, // Explorer right-click entries registered?
  autoUpdate: true,
};

class Store {
  constructor(userDataDir) {
    this.dir = userDataDir;
    fs.mkdirSync(userDataDir, { recursive: true });
    this.file = path.join(userDataDir, "settings.json");
    this.settings = this.#load();
  }

  #load() {
    try {
      return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(this.file, "utf8")) };
    } catch {
      return { ...DEFAULTS };
    }
  }

  get() {
    return { ...this.settings };
  }

  set(patch) {
    this.settings = { ...this.settings, ...patch };
    fs.writeFileSync(this.file, JSON.stringify(this.settings, null, 2));
    return this.get();
  }
}

module.exports = { Store, DEFAULTS };
