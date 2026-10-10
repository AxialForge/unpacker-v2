# End-to-end scripts

Manual scripts that drive the real engine (bundled 7-Zip, WinRAR if present)
and, for two of them, the real application window through Playwright. They
are not part of `npm test`: they take minutes, write to the system temp
folder, and two of them read a real export.

    node test/e2e/e2e.js                 # create / extract / convert / test against 7-Zip
    node test/e2e/e2e-pack.js            # smart compress, chunks, manifests, verify
    node test/e2e/e2e-phase1.js          # safety: traversal, bombs, links, cancel cleanup
    node test/e2e/e2e-massextract.js     # mass extract, nested archives, source cleanup
    node test/e2e/e2e-exportlog.js       # export log on a mass result
    node test/e2e/e2e-takeout.js         # fake 3-part Takeout export through the takeout job
    node test/e2e/e2e-organize.js        # Takeout organiser on a fake tree
    node test/e2e/e2e-snapchat.js        # fake Snapchat export (A) + a slice of a real one (B)
    node test/e2e/e2e-snapchat-real.js   # BOTH real Snapchat exports, combined (counts only)
    node test/e2e/e2e-library.js         # Library page screenshots (needs docs/_tools npm install)
    node test/e2e/e2e-snapchat-burn.js   # overlay burn-in through the real app window (needs docs/_tools npm install)

Real-data scripts read `UNP_SNAPCHAT_DIR` / `UNP_TAKEOUT_DIR` (defaults are
the author's drives). They open the sources read-only, work in a temp copy,
print counts only, and delete the temp output at the end.
    node test/e2e/e2e-zone-and-tar-password.js   # Mark-of-the-Web propagation; tar + password refused
