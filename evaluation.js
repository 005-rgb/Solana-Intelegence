const crypto = require("crypto");

const EVALUATION_VERSION = "phase6a-v1";
const EVALUATION_CONFIG = Object.freeze({
  version: EVALUATION_VERSION,
  horizon: "T+1H",
  minimumSample: 30,
  minimumWindowDays: 7,
  embargoMs: 60 * 60 * 1000,
  bootstrapReplicates: 500,
  bootstrapSeed: "phase6a-v1"
});

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

const CONFIGURATION_HASH = crypto.createHash("sha256").update(stable(EVALUATION_CONFIG)).digest("hex");

function finite(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function timeOf(row) {
  const parsed = Date.parse(String(row?.signalTime || row?.observedAt || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function scoreOf(row) {
  return finite(row?.radarScore ?? row?.score ?? row?.decisionScore);
}

function positiveOf(row) {
  if (typeof row?.positiveLabel === "boolean") return row.positiveLabel;
  const value = finite(row?.executableReturnPercent ?? row?.forwardReturnPercent);
  const mae = finite(row?.maePercent);
  return value != null && value >= 5 && (mae == null || mae > -5);
}

function normalizeRows(labels, horizon = EVALUATION_CONFIG.horizon) {
  const rows = (Array.isArray(labels) ? labels : [])
    .filter(row => String(row.checkpoint || "") === horizon)
    .map(row => ({
      ...row,
      time: timeOf(row),
      score: scoreOf(row),
      positive: positiveOf(row),
      priceReturnPercent: finite(row.forwardReturnPercent),
      executableReturnPercent: finite(row.executableReturnPercent),
      returnPercent: finite(row.forwardReturnPercent),
      maePercent: finite(row.maePercent),
      mint: row.mint || row.metadata?.mint || "UNKNOWN",
      discoveryClass: row.discoveryClass || row.metadata?.discoveryClass || "UNKNOWN",
      complete: row.completionState === "FOUND",
      pricePositive: finite(row.forwardReturnPercent) != null && Number(row.forwardReturnPercent) >= 5,
      executablePositive: finite(row.executableReturnPercent) != null && Number(row.executableReturnPercent) >= 5
    }))
    .filter(row => row.time != null && row.complete && row.score != null && row.returnPercent != null);
  return rows.sort((a, b) => a.time - b.time || String(a.mint).localeCompare(String(b.mint)));
}

function distinctByMint(rows) {
  const seen = new Set();
  return rows.filter(row => {
    if (seen.has(row.mint)) return false;
    seen.add(row.mint);
    return true;
  });
}

function median(values) {
  const sorted = values.filter(value => finite(value) != null).map(Number).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function wilson(successes, total) {
  if (!total) return { lower: null, upper: null };
  const z = 1.959963984540054;
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denominator;
  const spread = z * Math.sqrt((p * (1 - p) / total) + (z * z) / (4 * total * total)) / denominator;
  return { lower: Number(Math.max(0, center - spread).toFixed(6)), upper: Number(Math.min(1, center + spread).toFixed(6)) };
}

function precisionAt(rows, k, mode = "price") {
  const candidates = mode === "executable"
    ? rows.filter(row => row.executableReturnPercent != null)
    : rows.filter(row => row.priceReturnPercent != null);
  const selected = distinctByMint([...candidates].sort((a, b) => b.score - a.score || a.time - b.time).slice(0, k));
  if (!selected.length) return null;
  return selected.filter(row => mode === "executable" ? row.executablePositive : row.pricePositive).length / selected.length;
}

function metricSet(rows, mode = "price") {
  const returnField = mode === "executable" ? "executableReturnPercent" : "priceReturnPercent";
  const positiveField = mode === "executable" ? "executablePositive" : "pricePositive";
  const eligibleRows = rows.filter(row => row[returnField] != null);
  const positives = eligibleRows.filter(row => row[positiveField]).length;
  const precision = {};
  for (const k of [1, 3, 5, 10]) precision[`precisionAt${k}`] = precisionAt(eligibleRows, k, mode);
  const winRate = eligibleRows.length ? positives / eligibleRows.length : null;
  const ci = wilson(positives, eligibleRows.length);
  return {
    sampleSize: eligibleRows.length,
    precisionAt1: precision.precisionAt1,
    precisionAt3: precision.precisionAt3,
    precisionAt5: precision.precisionAt5,
    precisionAt10: precision.precisionAt10,
    medianForwardReturnPercent: median(eligibleRows.map(row => row[returnField])),
    winRate,
    winRate95Ci: ci,
    falsePositiveRate: eligibleRows.length ? (eligibleRows.length - positives) / eligibleRows.length : null,
    medianMaximumAdverseExcursionPercent: median(eligibleRows.map(row => row.maePercent)),
    tradabilityRate: eligibleRows.length ? eligibleRows.filter(row => row.tradabilityState === "TRADABLE").length / eligibleRows.length : null
  };
}

function seededRandom(seed) {
  let state = crypto.createHash("sha256").update(String(seed)).digest().readUInt32BE(0);
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function bootstrapByToken(rows, metric, replicates = EVALUATION_CONFIG.bootstrapReplicates, seed = EVALUATION_CONFIG.bootstrapSeed) {
  const groups = [...new Map(rows.reduce((map, row) => {
    if (!map.has(row.mint)) map.set(row.mint, []);
    map.get(row.mint).push(row);
    return map;
  }, new Map())).values()];
  if (!groups.length) return { lower: null, upper: null, replicates: 0, unit: "TOKEN_BLOCK" };
  const random = seededRandom(seed);
  const values = [];
  for (let i = 0; i < replicates; i += 1) {
    const sample = [];
    for (let j = 0; j < groups.length; j += 1) sample.push(...groups[Math.floor(random() * groups.length)]);
    const result = metricSet(sample)[metric];
    if (result != null) values.push(result);
  }
  values.sort((a, b) => a - b);
  return {
    lower: values.length ? values[Math.floor(values.length * 0.025)] : null,
    upper: values.length ? values[Math.min(values.length - 1, Math.floor(values.length * 0.975))] : null,
    replicates: values.length,
    unit: "TOKEN_BLOCK"
  };
}

function splitWalkForward(rows, embargoMs = EVALUATION_CONFIG.embargoMs) {
  const normalized = (Array.isArray(rows) ? rows : [])
    .map(row => ({ row, time: row.time ?? timeOf(row) }))
    .filter(item => item.time != null)
    .sort((a, b) => a.time - b.time)
    .map(item => ({ ...item.row, time: item.time }));
  if (!normalized.length) return { training: [], validation: [], temporalHoldout: [], embargoMs, boundaries: null };
  const start = normalized[0].time;
  const end = normalized[normalized.length - 1].time;
  const duration = Math.max(1, end - start);
  const firstBoundary = start + duration / 2;
  const secondBoundary = start + duration * 0.75;
  return {
    training: normalized.filter(row => row.time < firstBoundary),
    validation: normalized.filter(row => row.time >= firstBoundary + embargoMs && row.time < secondBoundary),
    temporalHoldout: normalized.filter(row => row.time >= secondBoundary + embargoMs),
    embargoMs,
    boundaries: {
      start: new Date(start).toISOString(),
      trainingEnd: new Date(firstBoundary).toISOString(),
      validationEnd: new Date(secondBoundary).toISOString(),
      end: new Date(end).toISOString()
    }
  };
}

function calibration(rows) {
  const probabilities = rows.filter(row => finite(row.predictedProbability) != null);
  if (!probabilities.length) {
    return { status: "NOT_APPLICABLE_SCORE_IS_NOT_PROBABILITY", sampleSize: 0, brierScore: null, logLoss: null, expectedCalibrationError: null };
  }
  const bins = Array.from({ length: 10 }, () => []);
  let brier = 0;
  let logLoss = 0;
  for (const row of probabilities) {
    const probability = Math.max(0, Math.min(1, Number(row.predictedProbability)));
    const outcome = row.positive ? 1 : 0;
    bins[Math.min(9, Math.floor(probability * 10))].push({ probability, outcome });
    brier += (probability - outcome) ** 2;
    logLoss -= outcome ? Math.log(Math.max(probability, 1e-12)) : Math.log(Math.max(1 - probability, 1e-12));
  }
  const ece = bins.reduce((sum, bin) => {
    if (!bin.length) return sum;
    const avgProbability = bin.reduce((total, row) => total + row.probability, 0) / bin.length;
    const avgOutcome = bin.reduce((total, row) => total + row.outcome, 0) / bin.length;
    return sum + (bin.length / probabilities.length) * Math.abs(avgProbability - avgOutcome);
  }, 0);
  return {
    status: "AVAILABLE",
    sampleSize: probabilities.length,
    brierScore: brier / probabilities.length,
    logLoss: logLoss / probabilities.length,
    expectedCalibrationError: ece
  };
}

function discoveryBias(rows) {
  const classes = ["BOOSTED", "NON_BOOSTED", "COMBINED"];
  return Object.fromEntries(classes.map(discoveryClass => {
    const subset = discoveryClass === "COMBINED"
      ? rows
      : rows.filter(row => String(row.discoveryClass).toUpperCase() === discoveryClass);
    return [discoveryClass, { ...metricSet(subset), discoveryClass }];
  }));
}

function evaluateOutcomes(labels, options = {}) {
  const config = { ...EVALUATION_CONFIG, ...options };
  const allRows = normalizeRows(labels, config.horizon);
  const timestamps = allRows.map(row => row.time);
  const windowDays = timestamps.length > 1 ? (Math.max(...timestamps) - Math.min(...timestamps)) / (24 * 60 * 60 * 1000) : 0;
  const split = splitWalkForward(allRows, config.embargoMs);
  const holdout = metricSet(split.temporalHoldout);
  const executableHoldout = metricSet(split.temporalHoldout, "executable");
  const scoreVersions = [...new Set(allRows.map(row => row.decisionVersion || "UNKNOWN"))];
  const eligibility = allRows.length >= config.minimumSample && windowDays >= config.minimumWindowDays;
  const report = {
    version: EVALUATION_VERSION,
    configurationHash: CONFIGURATION_HASH,
    horizon: config.horizon,
    generatedAt: new Date().toISOString(),
    claimStatus: eligibility ? "DESCRIPTIVE_ONLY_UNTIL_GOVERNANCE_APPROVAL" : "INSUFFICIENT_SAMPLE_OR_TIME_WINDOW",
    efficacyClaimAllowed: false,
    minimumRequirements: {
      sampleSize: config.minimumSample,
      windowDays: config.minimumWindowDays,
      observedSampleSize: allRows.length,
      observedWindowDays: Number(windowDays.toFixed(4)),
      met: eligibility
    },
    noLookAhead: {
      droppedRows: Array.isArray(labels) ? labels.filter(row => {
        const signal = timeOf(row);
        const observed = Date.parse(String(row.observedAt || ""));
        return signal != null && Number.isFinite(observed) && observed < signal;
      }).length : 0,
      rule: "Only observations at or after signal time enter a label."
    },
    walkForward: {
      embargoMs: split.embargoMs,
      boundaries: split.boundaries,
      training: metricSet(split.training),
      validation: metricSet(split.validation),
      temporalHoldout: holdout,
      executableTemporalHoldout: executableHoldout
    },
    metrics: {
      ...metricSet(allRows),
      priceReturnCoverage: allRows.filter(row => row.priceReturnPercent != null).length,
      executableReturnCoverage: allRows.filter(row => row.executableReturnPercent != null).length,
      executableCoverageRate: allRows.length ? allRows.filter(row => row.executableReturnPercent != null).length / allRows.length : null
    },
    priceMetrics: metricSet(allRows, "price"),
    executableMetrics: metricSet(allRows, "executable"),
    uncertainty: {
      precisionAt1: bootstrapByToken(allRows, "precisionAt1", config.bootstrapReplicates, config.bootstrapSeed),
      precisionAt3: bootstrapByToken(allRows, "precisionAt3", config.bootstrapReplicates, `${config.bootstrapSeed}:3`),
      precisionAt5: bootstrapByToken(allRows, "precisionAt5", config.bootstrapReplicates, `${config.bootstrapSeed}:5`),
      precisionAt10: bootstrapByToken(allRows, "precisionAt10", config.bootstrapReplicates, `${config.bootstrapSeed}:10`),
      winRate: bootstrapByToken(allRows, "winRate", config.bootstrapReplicates, `${config.bootstrapSeed}:win`)
    },
    discoveryBias: discoveryBias(allRows),
    calibration: calibration(allRows),
    scoreVersions,
    dataQuality: {
      completedRows: allRows.length,
      censoredRows: (Array.isArray(labels) ? labels : []).filter(row => row.completionState === "CENSORED").length,
      unknownTradabilityRows: allRows.filter(row => row.tradabilityState === "UNKNOWN").length,
      untradableRows: allRows.filter(row => row.tradabilityState === "UNTRADABLE").length,
      distinctTokens: new Set(allRows.map(row => row.mint)).size
    }
  };
  return report;
}

module.exports = {
  EVALUATION_VERSION,
  EVALUATION_CONFIG,
  CONFIGURATION_HASH,
  normalizeRows,
  splitWalkForward,
  evaluateOutcomes
};