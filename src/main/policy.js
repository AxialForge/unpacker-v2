// Small pure decisions that main.js acts on. Kept Electron-free so they can be tested.

/**
 * What the close button should do while jobs may be running.
 * @returns {"quit"|"hide"|"ask"}
 */
function closeDecision({ busy, closeToTray }) {
  if (!busy) return "quit";
  return closeToTray ? "hide" : "ask";
}

/** Should the sleep blocker be held right now? */
function wantAwake({ running, pending, preventSleep }) {
  return (running > 0 || pending > 0) && preventSleep !== false;
}

module.exports = { closeDecision, wantAwake };
