# Silent auto-update — integration

`updater.js` is the drop-in. It's inert until three build-time facts are true.
`/new-repo` wires all of this automatically for a Node/Electron project; this
file is the manual reference and the explanation of *why* each piece is load-
bearing. There is **no wizard and no prompt** at any point — for the user OR for
whoever sets it up.

## 1. Dependency

```jsonc
// package.json
"dependencies": {
  "electron-updater": "^6.8.9"
}
```

## 2. One call in the main process

```js
// src/main/main.js
const updater = require("./updater");

app.whenReady().then(() => {
  createWindow();
  updater.start(); // checks on launch + every 6h, downloads + installs silently
});
```

That's the whole runtime integration. `start()` no-ops safely when run from
source (`app.isPackaged === false`), so `npm run dev` never errors and never
hits the network. To let the app offer an optional "Restart now" instead of
waiting for the next quit, pass a status sink:

```js
updater.start({
  onStatus: (s) => { if (s.state === "ready") mainWindow.webContents.send("update:ready", s.version); },
});
// ...and, when the user clicks your button: updater.installNow();
```

## 3. `publish` + a one-click (wizardless) installer

```yaml
# electron-builder.yml
publish:
  provider: github
  owner: AxialForge
  # repo is auto-detected from the git remote in CI — nothing to fill in.

win:
  target:
    - nsis        # the updatable target
    # - portable  # optional; a portable .exe can't self-update (nothing installed)
  icon: build/icon.ico

nsis:
  # A one-click installer HAS no wizard, so the silent update has none either.
  # This is the whole "no setup wizard" requirement, in three lines.
  oneClick: true
  perMachine: false                       # per-user install => no UAC prompt on update
  allowToChangeInstallationDirectory: false
  artifactName: ${name}-${version}-setup.${ext}   # no spaces — see the note below
```

Why `oneClick: true` and `perMachine: false` together: a one-click installer
skips the Next/Next/Install UI, and a per-user install writes under the user's
own AppData, so applying an update needs no administrator elevation. Either one
missing reintroduces a dialog on update.

**Artifact name must be space-free.** With a space, three things disagree — the
on-disk file, the URL written into `latest.yml` (which hyphenates), and the
GitHub asset name (spaces become dots on upload) — and the updater's download
URL 404s. `${name}` keeps them identical.

## 4. The release must carry the update metadata

This is the step that's invisible until it bites. `electron-builder` generates
`latest.yml` (version + SHA-512 manifest) and a `.blockmap` (for differential
downloads) into `dist/` at build time. **The updater reads `latest.yml` from the
GitHub Release. If CI uploads only the `.exe`, the app checks, finds no feed, and
silently never updates — with no error the user would ever see.**

The template's `node-electron-release.yml` already uploads all three:

```yaml
- name: Attach to release
  uses: softprops/action-gh-release@v2
  with:
    files: |
      dist/*.exe
      dist/latest.yml
      dist/*.blockmap
    generate_release_notes: true
```

## Turning it off

Set the environment variable `NO_AUTO_UPDATE=1` — an enforced kill-switch for
managed or air-gapped machines. Or pass `updater.start({ enabled: false })` from
a user setting.

## Verifying it actually works

You cannot test this from source — it only runs in the installed app. The real
check:

1. Build and install `vX`. 2. Tag `vX+1`, let CI publish it (confirm the Release
has `latest.yml`). 3. Launch the installed `vX`; within a few seconds it fetches
`vX+1` in the background. 4. Quit and relaunch — you're on `vX+1`, no wizard ever
shown. If nothing happens, open the release and confirm `latest.yml` is attached
(step 4 above is the usual culprit).
