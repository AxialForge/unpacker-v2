# {{PROJECT_NAME}} — project guide for Claude Code

<!-- Skeleton. Fill it from the real code, delete what doesn't apply, and don't
     leave placeholder prose in place — a CLAUDE.md full of generic filler is
     worse than no CLAUDE.md. See CONVENTIONS.md for what each section is for. -->

{{DESCRIPTION}}

<!-- One paragraph: what this is, how it's shipped, and what it deliberately
     isn't. -->

## Non-negotiables (don't regress these)

<!-- The invariants. Constraints, not aspirations. Examples from other projects:
- **Fully offline.** No network calls at runtime, no telemetry, no accounts.
- **Extensible by one file.** New capability = one self-describing file; never a
  central switchboard someone has to remember to edit.
- **Ships as a single Windows `.exe`.** -->

## Commands

```bash
# install
# run
# test
# build
```

<!-- Note the version floors that actually matter and why, e.g. "Node 22+ — the
     test glob needs 21+". -->

## Architecture

<!-- Module boundaries first, then the map. What runs where, what talks to what,
     and through which single surface. -->

### Directory map

```
src/
  <file>    one line: what it owns
```

## The extension point

<!-- If there's a "how to add a thing" path, document it as the ONLY supported
     path, with the contract the new thing must satisfy. -->

## Gotchas / constraints

<!-- The payload of this file. Leave it EMPTY until something actually bites.
     Then write it as: symptom → cause → why the obvious fix is wrong.
     Especially the ones that look like somebody else's bug. -->

## Roadmap (unbuilt)

<!-- What's deliberately not built yet, and what it would take. -->

## Release

Bump the version and update `CHANGELOG.md` in one commit, then:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

CI builds the artifact and attaches it to the GitHub Release.
