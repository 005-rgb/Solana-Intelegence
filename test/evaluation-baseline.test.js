const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeRows, evaluateBaselineComparison } = require("../evaluation");

function rows() {
  return Array.from({ length: 12 }, (_, index) => {
    const positive = index < 6;
    return {
      checkpoint: "T+1H",
      signalTime: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
      completionState: "FOUND",
      mint: `baseline-mint-${index}`,
      score: positive ? 100 - index : 10 - index,
      baselineScore: positive ? 10 - index : 100 - index,
      baselineAccepted: true,
      forwardReturnPercent: positive ? 8 : -3,
      maePercent: positive ? -2 : -8
    };
  });
}

test("baseline comparison uses the same candidate set and detects precision lift", () => {
  const normalized = normalizeRows(rows());
  const comparison = evaluateBaselineComparison(normalized, {
    minimumSample: 10,
    minimumUniqueTokens: 10,
    minimumTemporalWindows: 3
  });
  assert.equal(comparison.status, "ELIGIBLE");
  assert.equal(comparison.claimAllowed, true);
  assert.equal(comparison.baseline.sampleSize, 12);
  assert.equal(comparison.challenger.sampleSize, 12);
  assert.equal(comparison.delta.precisionAt10, 0.2);
  assert.equal(comparison.checks.precisionLift, true);
});

test("baseline comparison is fail-closed when baseline lineage is absent", () => {
  const incomplete = rows().map(row => ({ ...row, baselineScore: null }));
  const comparison = evaluateBaselineComparison(normalizeRows(incomplete), {
    minimumSample: 10,
    minimumUniqueTokens: 10,
    minimumTemporalWindows: 3
  });
  assert.equal(comparison.status, "INSUFFICIENT_SAMPLE");
  assert.equal(comparison.claimAllowed, false);
  assert.ok(comparison.failedChecks.includes("sampleSize"));
});