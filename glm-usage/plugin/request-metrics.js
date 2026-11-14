// A zero input in ZCode's usage table is also the default for failed/running
// requests with no reported usage. It must not look like context compression.
function calculateInputDeltas(steps) {
  let previous = null;
  return steps.map(step => {
    const input = Number(step.input);
    if (!Number.isFinite(input) || input <= 0) return null;
    const delta = previous === null ? null : input - previous;
    previous = input;
    return delta;
  });
}
if (typeof module !== 'undefined' && module.exports) module.exports = { calculateInputDeltas };
