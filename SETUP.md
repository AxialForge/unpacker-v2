# Setup checklist — delete this file when you're done

You made a repo from `AxialForge/project-template`. Work down this list, then
`git rm SETUP.md`.

## 1. Git identity (do this before the first commit)

```bash
git config --local --get-regexp "^user\."
```

Expect **no output**. Anything printed is a stale local override shadowing the
global `AxialForge <37514365+AxialForge@users.noreply.github.com>` identity, and
your commits will be credited to the wrong person (or nobody). Clear it:

```bash
git config --local --unset user.name; git config --local --unset user.email
```

Verify what the next commit will actually say:

```bash
git var GIT_AUTHOR_IDENT
```

## 2. Pick a CI workflow

Nothing in `.github/workflows/` runs until you put it there. Move exactly one:

```bash
git mv .github/workflows-available/node-electron-release.yml .github/workflows/
```

| File | For |
| --- | --- |
| `node-electron-release.yml` | Electron / Node desktop apps that ship a Windows `.exe` |
| `python-release.yml` | Python apps — pytest on push, PyInstaller `.exe` on a tag |
| `platformio-release.yml` | ESP32 / PlatformIO firmware, `.bin` attached to the release |

Delete `.github/workflows-available/` once you've chosen.

## 3. Replace the placeholders

`{{PROJECT_NAME}}`, `{{TAGLINE}}`, `{{DESCRIPTION}}`, `{{YEAR}}` appear in
`README.md`, `LICENSE`, `CLAUDE.md`, and `docs/index.html`. Find them all:

```bash
git grep -n "{{"
```

## 4. Write `CLAUDE.md` for real

The shipped one is a skeleton. It is worth doing properly — read
`CONVENTIONS.md` for what a good one contains. Leave the **Gotchas** section
empty until something actually bites you; invented gotchas are worse than none.

## 5. Repo settings

```bash
gh repo edit --description "{{DESCRIPTION}}" --add-topic <topic> --add-topic <topic>
```

If you're publishing a landing page: Settings → Pages → `main` / `docs`.

## 6. Delete this file

```bash
git rm SETUP.md && git commit -m "Remove template setup checklist"
```
