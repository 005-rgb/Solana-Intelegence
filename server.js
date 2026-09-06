const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");
const {
  readState,
  persistState,
  recordTrade,
  recordWatchlistEvent,
  recordWhaleActivity,
  recordAlert,
  recordAlertsAtomic,
  createScanRun,
  finishScanRun,
  recordTokenObservations,
  acquireScanLease,
  releaseScanLease,
  acquireMutationLease,
  releaseMutationLease,
  recordSkippedScan,
  findScanByIdempotencyKey,
  findTradeByIdempotencyKey,
  persistPatterns,
  disconnectDb
} = require("./db");
const {
  PHASE2_DECISION_VERSION,
  PHASE2_FILTER_CONFIG,
  buildAccountTaxonomy,
  MAX_TOP_HOLDER_PERCENT,
  MIN_LIQUIDITY_USD,
  dedupePairs,
  dedupeMintEntries,
  evaluateMarketQuality,
  evaluatePhase2Candidate,
  normalizeDiscoveryUniverse,
  normalizePoolEvidence,
  selectBoardTokens,
  selectPrimaryPair,
  summarizePhase2Candidates,
  validateProviderFeed,
  validateProviderPair,
  PROVIDER_SCHEMA_VERSION
} = require("./radar-core");

const PORT = Number(process.env.PORT || 5000);
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, ".data");
const STATE_FILE = path.join(DATA_DIR, "radar-state.json");
const AUTO_SCAN_MS = 15_000;
const LIVE_SCAN_TIMEOUT_MS = 20_000;
const ANALYSIS_MS = 6 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 100_000;
const BODY_TIMEOUT_MS = 5_000;
const RATE_WINDOW_MS = 60_000;
const API_RATE_LIMIT = 120;
const MUTATION_RATE_LIMIT = 20;
const MAX_TAXONOMY_HOLDERS_PER_TOKEN = 10;
const MAX_TAXONOMY_ACCOUNT_REQUESTS = 120;
const PROVIDER_MAX_CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.PROVIDER_MAX_CONCURRENCY || 4)));
const PROVIDER_MAX_RETRIES = 2;
const PROVIDER_RETRY_BASE_MS = 250;
const PROVIDER_CIRCUIT_FAILURE_THRESHOLD = 3;
const PROVIDER_CIRCUIT_COOLDOWN_MS = 30_000;
const rateBuckets = new Map();
const providerHealth = new Map();
let lastFilterReport = {
  checked: 0, accepted: 0, rejected: 0, unresolved: 0, reasons: [],
  providerRecords: 0, pairRequests: 0, pairFailures: 0, providerAgeMs: null,
  rpcStatus: "NOT RUN", rpcFreshnessMs: null, rpcCommitment: "confirmed",
  qualityStatus: "NOT RUN", filterConfig: PHASE2_FILTER_CONFIG, tokensPersisted: 0,
  discoveryUniverseSize: 0, providerRecordsWithPair: 0,
  providerRecordsWithPrice: 0, providerRecordsWithLiquidity: 0,
  securityVerified: 0, securityUnknown: 0, securityRejected: 0,
  liquidityRejected: 0, momentumRejected: 0, ctoRejected: 0,
  sourceMetrics: {}
};

function token(symbol, name, price, marketCap, liquidity, radar, opportunity, smartMoney, momentum, hype, risk, confidence, priceChange, whaleFlow, holderGrowth, status, age, rationale, riskLabel, dataQuality, potential) {
  const mint = `${symbol.toLowerCase()}${"7".repeat(28)}${symbol.length}`;
  return {
    mint, symbol, name, price, marketCap, liquidity, radar, opportunity, smartMoney, momentum, hype, risk, confidence,
    priceChange, whaleFlow, holderGrowth, status, age, rationale, riskLabel, dataQuality, potential,
    updatedAt: new Date().toISOString(),
    details: {
      holders: null, top10: null, volume24h: null, liquidityQuality: null, earlyness: null, patternMatch: null,
      consensus: "UNKNOWN", social: "UNKNOWN",
      authorities: { mint: "UNKNOWN", freeze: "UNKNOWN", metadata: "UNKNOWN" },
      security: { verified: false, status: "PENDING", reasons: ["Mint authority, freeze authority, and holder concentration have not been verified."] },
      evidence: ["Awaiting independent Solana RPC security verification."]
    }
  };
}

function freshState() {
  return {
    mode: "live",
    provider: "DexScreener",
    lastScan: null,
    nextScanAt: Date.now() + AUTO_SCAN_MS,
    scanRunning: false,
    tokens: [],
    whaleActivity: [],
    scanRuns: [],
    watchlist: [],
    watchlistHistory: [],
    alerts: [],
    patterns: [],
    portfolio: {
      starting: 100000, cash: 100000, realized: 0, fees: 0, trades: 0, positions: [], history: []
    },
    system: {
      scheduler: "RUNNING · 15s", worker: "READY", database: "POSTGRESQL / PRISMA", rpc: "LIVE PROVIDER", market: "LIVE PROVIDER",
      lastScanStatus: "NOT RUN YET", avgDuration: "—", tokensPerScan: 0, transactionsPerScan: 0, errors: 0,
      securityFilter: lastFilterReport
    }
  };
}

let state = freshState();

async function saveState() {
  await persistState(state);
}

function securityHeaders() {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Content-Security-Policy": "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' https:;"
  };
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    ...securityHeaders(),
    "Content-Type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let settled = false;
    const timer = setTimeout(() => finishReject(new Error("Request body timed out.")), BODY_TIMEOUT_MS);
    const finishReject = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const finishResolve = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const contentLength = Number(req.headers["content-length"]);
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      return finishReject(new Error("Payload too large."));
    }
    req.on("data", chunk => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) finishReject(new Error("Payload too large."));
    });
    req.on("end", () => {
      if (settled) return;
      try {
        const parsed = body ? JSON.parse(body) : {};
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Request body must be a JSON object.");
        finishResolve(parsed);
      } catch (error) {
        finishReject(error.message === "Request body must be a JSON object." ? error : new Error("Invalid JSON."));
      }
    });
    req.on("error", finishReject);
  });
}

function requestId(req) {
  const supplied = String(req.headers["x-request-id"] || "");
  return /^[A-Za-z0-9._:-]{1,128}$/.test(supplied) ? supplied : crypto.randomUUID();
}

function mutationRoute(url, method) {
  return method === "POST" && (url.pathname === "/api/scan" || url.pathname === "/api/analysis" || url.pathname === "/api/trades" || url.pathname.startsWith("/api/watchlist/"))
    || method === "DELETE" && url.pathname.startsWith("/api/watchlist/");
}

function mutationAllowed(req) {
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host) return false;
    } catch {
      return false;
    }
  }
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  const configuredToken = process.env.RADAR_AUTH_TOKEN;
  if (configuredToken) return req.headers.authorization === `Bearer ${configuredToken}`;
  return true;
}

function rateLimit(req, url) {
  if (!url.pathname.startsWith("/api/")) return { allowed: true };
  const now = Date.now();
  const key = `${req.socket?.remoteAddress || "unknown"}:${mutationRoute(url, req.method) ? "mutation" : "api"}`;
  const limit = mutationRoute(url, req.method) ? MUTATION_RATE_LIMIT : API_RATE_LIMIT;
  const current = rateBuckets.get(key);
  if (!current || now >= current.resetAt) {
    rateBuckets.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    if (rateBuckets.size > 2_000) {
      for (const [bucketKey, bucket] of rateBuckets) if (bucket.resetAt <= now) rateBuckets.delete(bucketKey);
    }
    return { allowed: true };
  }
  current.count += 1;
  return current.count <= limit
    ? { allowed: true }
    : { allowed: false, retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) };
}

async function lockMutation(req) {
  const owner = `${req.requestId}:${crypto.randomUUID()}`;
  const acquired = await acquireMutationLease(owner, BODY_TIMEOUT_MS + 10_000);
  return acquired ? owner : null;
}

async function unlockMutation(owner, requestId) {
  if (!owner) return;
  try {
    await releaseMutationLease(owner);
  } catch (error) {
    console.error(`[${requestId}] Mutation lease release failed`, error.message);
  }
}
function jsonState() {
  const now = Date.now();
  const positions = state.portfolio.positions.map(position => {
    const current = state.tokens.find(item => item.mint === position.mint);
    const currentPrice = current ? parseFloat(String(current.price).replace("$", "")) : NaN;
    const price = Number.isFinite(currentPrice) ? currentPrice : position.entry;
    const currentValue = position.quantity * price;
    const pnl = currentValue - position.invested;
    return { ...position, currentPrice: price, currentValue, pnl, pnlPct: (pnl / position.invested) * 100, holding: formatAge(now - position.openedAt) };
  });
  const unrealized = positions.reduce((sum, position) => sum + position.pnl, 0);
  return { ...state, now, positions, portfolio: { ...state.portfolio, positions, invested: positions.reduce((sum, p) => sum + p.invested, 0), equity: state.portfolio.cash + positions.reduce((sum, p) => sum + p.currentValue, 0), unrealized, roi: ((state.portfolio.cash + positions.reduce((sum, p) => sum + p.currentValue, 0) - state.portfolio.starting) / state.portfolio.starting) * 100 } };
}
function formatAge(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60000));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
function providerLinks(...groups) {
  const seen = new Set();
  return groups.flatMap(group => Array.isArray(group) ? group : [])
    .map(link => ({
      label: link?.label || link?.type || "Link",
      type: link?.type || null,
      url: typeof link?.url === "string" ? link.url : ""
    }))
    .filter(link => {
      if (!/^https?:\/\//i.test(link.url) || seen.has(link.url)) return false;
      seen.add(link.url);
      return true;
    });
}
function tokenById(id) {
  return state.tokens.find(item => item.mint === id || item.symbol.toLowerCase() === String(id).toLowerCase());
}

const configuredRpcUrls = [process.env.SOLANA_RPC_URLS, process.env.SOLANA_RPC_URL]
  .filter(Boolean)
  .flatMap(value => String(value).split(/[,\n]+/))
  .map(value => value.trim())
  .filter(value => /^https?:\/\//i.test(value));
const SOLANA_RPC_URLS = [...new Set(configuredRpcUrls)].length
  ? [...new Set(configuredRpcUrls)].slice(0, 8)
  : ["https://solana-rpc.publicnode.com", "https://api.mainnet-beta.solana.com"];
const RPC_FAILURE_THRESHOLD = 2;
const RPC_COOLDOWN_MS = 30_000;
const RPC_MAX_ATTEMPTS_PER_ENDPOINT = 2;
const rpcHealth = new Map();
let rpcRoundRobin = 0;
let rpcInFlight = 0;
const rpcWaiters = [];

function rpcEndpointState(endpoint) {
  const state = rpcHealth.get(endpoint) || {
    failures: 0, openedAt: 0, lastStatus: null, lastFailureAt: null, lastSuccessAt: null
  };
  if (state.openedAt && Date.now() - state.openedAt >= RPC_COOLDOWN_MS) {
    state.openedAt = 0;
    state.failures = 0;
  }
  rpcHealth.set(endpoint, state);
  return state;
}

function rpcEndpointCandidates() {
  const healthy = SOLANA_RPC_URLS.filter(endpoint => !rpcEndpointState(endpoint).openedAt);
  const pool = healthy.length
    ? healthy
    : [...SOLANA_RPC_URLS].sort((left, right) => rpcEndpointState(left).openedAt - rpcEndpointState(right).openedAt).slice(0, 1);
  if (!pool.length) return [];
  const offset = rpcRoundRobin++ % pool.length;
  return [...pool.slice(offset), ...pool.slice(0, offset)];
}

function rpcEndpointLabel(endpoint) {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return "invalid-endpoint";
  }
}

function recordRpcFailure(endpoint, status = null) {
  const state = rpcEndpointState(endpoint);
  state.failures += 1;
  state.lastStatus = status;
  state.lastFailureAt = new Date().toISOString();
  if (state.failures >= RPC_FAILURE_THRESHOLD) state.openedAt = Date.now();
}

function recordRpcSuccess(endpoint) {
  rpcHealth.set(endpoint, {
    failures: 0,
    openedAt: 0,
    lastStatus: null,
    lastFailureAt: rpcEndpointState(endpoint).lastFailureAt,
    lastSuccessAt: new Date().toISOString()
  });
}

function rpcRetryDelay(response, attempt) {
  const retryAfter = Number(response?.headers?.get("retry-after"));
  return Number.isFinite(retryAfter) && retryAfter >= 0
    ? Math.min(2_000, retryAfter * 1_000)
    : Math.min(2_000, 250 * (2 ** attempt));
}

function rpcHealthSummary() {
  return {
    configuredEndpoints: SOLANA_RPC_URLS.length,
    endpoints: SOLANA_RPC_URLS.map(endpoint => {
      const state = rpcEndpointState(endpoint);
      return {
        endpoint: rpcEndpointLabel(endpoint),
        failures: state.failures,
        circuitOpen: Boolean(state.openedAt),
        lastStatus: state.lastStatus,
        lastFailureAt: state.lastFailureAt,
        lastSuccessAt: state.lastSuccessAt
      };
    })
  };
}

async function acquireRpcSlot() {
  if (rpcInFlight < 1) {
    rpcInFlight += 1;
    return;
  }
  await new Promise(resolve => rpcWaiters.push(resolve));
  rpcInFlight += 1;
}

function releaseRpcSlot() {
  rpcInFlight -= 1;
  rpcWaiters.shift()?.();
}

async function solanaRpc(method, params) {
  await acquireRpcSlot();
  try {
    let lastError;
    const tried = [];
    for (const endpoint of rpcEndpointCandidates()) {
      tried.push(rpcEndpointLabel(endpoint));
      for (let attempt = 0; attempt < RPC_MAX_ATTEMPTS_PER_ENDPOINT; attempt += 1) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        try {
          const response = await fetch(endpoint, {
            method: "POST",
            signal: controller.signal,
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params })
          });
          if (response.status === 429 || response.status >= 500) {
            lastError = new Error(`Solana RPC HTTP ${response.status} at ${rpcEndpointLabel(endpoint)}`);
            lastError.status = response.status;
            recordRpcFailure(endpoint, response.status);
            if (attempt + 1 < RPC_MAX_ATTEMPTS_PER_ENDPOINT) {
              await new Promise(resolve => setTimeout(resolve, rpcRetryDelay(response, attempt)));
            }
            continue;
          }
          if (!response.ok) {
            lastError = new Error(`Solana RPC HTTP ${response.status} at ${rpcEndpointLabel(endpoint)}`);
            lastError.status = response.status;
            recordRpcFailure(endpoint, response.status);
            break;
          }
          const payload = await response.json();
          if (payload.error) {
            lastError = new Error(payload.error.message || "Solana RPC request failed");
            lastError.status = payload.error.code || null;
            recordRpcFailure(endpoint, lastError.status);
            break;
          }
          recordRpcSuccess(endpoint);
          return payload.result;
        } catch (error) {
          if (error.name === "AbortError") error.message = `Solana RPC timeout at ${rpcEndpointLabel(endpoint)}`;
          lastError = error;
          if (error.status == null) recordRpcFailure(endpoint, null);
          if (attempt + 1 < RPC_MAX_ATTEMPTS_PER_ENDPOINT) {
            await new Promise(resolve => setTimeout(resolve, 250 * (2 ** attempt)));
          }
        } finally {
          clearTimeout(timeout);
        }
      }
    }
    throw lastError || new Error(`No Solana RPC endpoint responded. Tried: ${tried.join(", ")}`);
  } finally {
    releaseRpcSlot();
  }
}

async function solanaRpcBatch(requests, signal) {
  await acquireRpcSlot();
  try {
    let lastError;
    const tried = [];
    for (const endpoint of rpcEndpointCandidates()) {
      tried.push(rpcEndpointLabel(endpoint));
      for (let attempt = 0; attempt < RPC_MAX_ATTEMPTS_PER_ENDPOINT; attempt += 1) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5_000);
        try {
          const response = await fetch(endpoint, {
            method: "POST",
            signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify(requests)
          });
          if (response.status === 429 || response.status >= 500) {
            lastError = new Error(`Solana RPC HTTP ${response.status} at ${rpcEndpointLabel(endpoint)}`);
            lastError.status = response.status;
            recordRpcFailure(endpoint, response.status);
            if (attempt + 1 < RPC_MAX_ATTEMPTS_PER_ENDPOINT) {
              await new Promise(resolve => setTimeout(resolve, rpcRetryDelay(response, attempt)));
            }
            continue;
          }
          if (!response.ok) {
            lastError = new Error(`Solana RPC HTTP ${response.status} at ${rpcEndpointLabel(endpoint)}`);
            lastError.status = response.status;
            recordRpcFailure(endpoint, response.status);
            break;
          }
          const payload = await response.json();
          if (!Array.isArray(payload)) {
            lastError = new Error(`Solana RPC batch response was invalid at ${rpcEndpointLabel(endpoint)}`);
            recordRpcFailure(endpoint, null);
            break;
          }
          recordRpcSuccess(endpoint);
          return payload;
        } catch (error) {
          if (signal?.aborted) throw new Error("Solana RPC request aborted by scan deadline.");
          if (error.name === "AbortError") error.message = `Solana RPC timeout at ${rpcEndpointLabel(endpoint)}`;
          lastError = error;
          if (error.status == null) recordRpcFailure(endpoint, null);
          if (attempt + 1 < RPC_MAX_ATTEMPTS_PER_ENDPOINT) {
            await new Promise(resolve => setTimeout(resolve, 250 * (2 ** attempt)));
          }
        } finally {
          clearTimeout(timeout);
        }
      }
    }
    throw lastError || new Error(`No Solana RPC endpoint responded. Tried: ${tried.join(", ")}`);
  } finally {
    releaseRpcSlot();
  }
}

function unverifiedSecurity(message, {
  poolEvidence = {},
  reasonCodes = ["RPC_INCOMPLETE"],
  rpcEvidence = null
} = {}) {
  const taxonomy = buildAccountTaxonomy([], { poolEvidence });
  return {
    verified: false,
    status: "UNVERIFIED",
    reasons: [`Security verification failed: ${message}`],
    reasonCodes,
    authorities: { mint: "UNKNOWN", freeze: "UNKNOWN", metadata: "UNKNOWN" },
    holders: null,
    topHolderPercent: null,
    topHolders: [],
    supply: null,
    poolEvidence: taxonomy.poolEvidence,
    accountTaxonomy: taxonomy,
    concentration: taxonomy.concentration,
    tokenProgram: "UNKNOWN",
    tokenProgramStatus: "UNKNOWN",
    extensions: [],
    extensionWarnings: [],
    rpcEvidence
  };
}

function securityFromRpcResults(accountResponse, supplyResponse, largestResponse, taxonomyOptions = {}, rpcEvidence = null) {
  const rpcError = [accountResponse, supplyResponse, largestResponse].find(item => item?.error);
  if (rpcError) return unverifiedSecurity(rpcError.error.message || "Solana RPC request failed", {
    ...taxonomyOptions,
    reasonCodes: ["RPC_REQUEST_FAILED"],
    rpcEvidence
  });
  try {
    const account = accountResponse?.result;
    const supply = supplyResponse?.result;
    const largest = largestResponse?.result;
    const accountValue = account?.value;
    const info = account?.value?.data?.parsed?.info;
    const supplyAmount = supply?.value?.amount;
    const largestAccounts = largest?.value;
    const contexts = [account, supply, largest].map(result => result?.context);
    if (!info || accountValue == null || supplyAmount == null || !Array.isArray(largestAccounts) || !largestAccounts.length) {
      return unverifiedSecurity("Solana RPC security response is incomplete.", {
        ...taxonomyOptions,
        reasonCodes: ["RPC_INCOMPLETE"],
        rpcEvidence: { ...rpcEvidence, contexts }
      });
    }
    if (!contexts.every(context => Number.isInteger(context?.slot) && context.slot >= 0)) {
      return unverifiedSecurity("Solana RPC response did not identify a complete slot context.", {
        ...taxonomyOptions,
        reasonCodes: ["RPC_CONTEXT_UNKNOWN"],
        rpcEvidence: { ...rpcEvidence, contexts }
      });
    }
    const parsedType = account?.value?.data?.parsed?.type;
    const program = account?.value?.data?.program;
    const owner = accountValue?.owner;
    const tokenProgram = program === "spl-token" || owner === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
      ? "SPL_TOKEN"
      : program === "spl-token-2022" || owner === "TokenzQdBNbLqP5VEhdkY6Y1W3qL6u3x9a6J6wGv5"
        ? "TOKEN_2022"
        : "UNKNOWN";
    if (parsedType !== "mint" || tokenProgram === "UNKNOWN") {
      return {
        ...unverifiedSecurity("Account is not a supported parsed SPL mint account.", {
          ...taxonomyOptions,
          reasonCodes: ["MINT_ACCOUNT_INVALID"],
          rpcEvidence: { ...rpcEvidence, contexts }
        }),
        status: "REJECTED",
        tokenProgram,
        tokenProgramStatus: "UNSUPPORTED",
        rpcEvidence: { ...rpcEvidence, contexts }
      };
    }
    const mintAuthorityRenounced = Boolean(info) && info.mintAuthority == null;
    const freezeAuthorityRenounced = Boolean(info) && info.freezeAuthority == null;
    if (!/^\d+$/.test(String(supplyAmount)) || !/^\d+$/.test(String(largestAccounts[0]?.amount || ""))) {
      return unverifiedSecurity("Solana RPC supply or largest-holder data is invalid.", {
        ...taxonomyOptions,
        reasonCodes: ["SECURITY_DATA_INVALID"],
        rpcEvidence: { ...rpcEvidence, contexts }
      });
    }
    const supplyRaw = BigInt(supplyAmount);
    const largestRaw = BigInt(largestAccounts[0].amount);
    if (supplyRaw <= 0n) {
      return unverifiedSecurity("Solana RPC reported a non-positive token supply.", {
        ...taxonomyOptions,
        reasonCodes: ["SUPPLY_NON_POSITIVE"],
        rpcEvidence: { ...rpcEvidence, contexts }
      });
    }
    if (largestAccounts.some(holder => !holder?.address || !/^\d+$/.test(String(holder.amount ?? "")))) {
      return unverifiedSecurity("Solana RPC largest-holder data contains an invalid account amount.", {
        ...taxonomyOptions,
        reasonCodes: ["LARGEST_HOLDER_DATA_INVALID"],
        rpcEvidence: { ...rpcEvidence, contexts }
      });
    }
    const topHolderPercent = supplyRaw > 0n ? Number((largestRaw * 10000n) / supplyRaw) / 100 : null;
    const topHolders = Array.isArray(largest?.value)
      ? largest.value.slice(0, 20).map((holder, index) => {
        const amountRaw = BigInt(holder?.amount || "0");
        return {
          rank: index + 1,
          address: holder?.address || null,
          amount: holder?.uiAmountString || holder?.uiAmount || null,
          percent: supplyRaw > 0n ? Number((amountRaw * 10000n) / supplyRaw) / 100 : null
        };
      })
      : [];
    const accountTaxonomy = buildAccountTaxonomy(topHolders, taxonomyOptions);
    const reasons = [];
    const reasonCodes = [];
    if (!mintAuthorityRenounced) {
      reasons.push("Mint authority is still active.");
      reasonCodes.push("MINT_AUTHORITY_ACTIVE");
    }
    if (!freezeAuthorityRenounced) {
      reasons.push("Freeze authority is still active.");
      reasonCodes.push("FREEZE_AUTHORITY_ACTIVE");
    }
    if (topHolderPercent == null) reasons.push("Token supply or largest-holder data is unavailable.");
    else if (topHolderPercent > MAX_TOP_HOLDER_PERCENT) {
      reasons.push(`Largest holder controls ${topHolderPercent.toFixed(2)}% of supply.`);
      reasonCodes.push("TOP_HOLDER_ABOVE_LIMIT");
    }
    const extensions = Array.isArray(info.extensions)
      ? info.extensions.map(extension => typeof extension === "string" ? extension : extension?.extension || extension?.type).filter(Boolean)
      : [];
    const extensionWarnings = extensions.filter(extension => [
      "transferFeeConfig", "transferHook", "permanentDelegate", "defaultAccountState",
      "nonTransferable", "confidentialTransfer", "metadataPointer"
    ].includes(extension)).map(extension => `Token-2022 extension present: ${extension}.`);
    if (extensionWarnings.length) reasons.push(...extensionWarnings);
    const verified = mintAuthorityRenounced && freezeAuthorityRenounced && topHolderPercent != null && topHolderPercent <= MAX_TOP_HOLDER_PERCENT;
    return {
      verified,
      status: verified ? "VERIFIED" : "REJECTED",
      reasons: reasons.length ? reasons : ["Mint and freeze authorities are renounced; largest-holder concentration is within the 80% limit."],
      reasonCodes,
      authorities: {
        mint: mintAuthorityRenounced ? "RENOUNCED" : "ACTIVE",
        freeze: freezeAuthorityRenounced ? "RENOUNCED" : "ACTIVE",
        metadata: "UNKNOWN"
      },
      holders: largest?.value?.length || null,
      topHolderPercent,
      topHolders: accountTaxonomy.accounts,
      supply: supply?.value?.uiAmountString || null,
      tokenProgram,
      tokenProgramStatus: tokenProgram === "TOKEN_2022" ? "SUPPORTED_WITH_EXTENSION_REVIEW" : "SUPPORTED",
      extensions,
      extensionWarnings,
      poolEvidence: accountTaxonomy.poolEvidence,
      accountTaxonomy,
      concentration: accountTaxonomy.concentration,
      rpcEvidence: { ...rpcEvidence, contexts, commitment: "confirmed" }
    };
  } catch (error) {
    return unverifiedSecurity(error.message, {
      ...taxonomyOptions,
      reasonCodes: ["SECURITY_DATA_INVALID"],
      rpcEvidence
    });
  }
}

async function verifyTokensSecurity(tokenRecords, signal) {
  const records = (Array.isArray(tokenRecords) ? tokenRecords : []).map(record => typeof record === "string"
    ? { mint: record, poolEvidence: {} }
    : { mint: record?.mint, poolEvidence: record?.poolEvidence || {} });
  const requests = records.flatMap((record, index) => [
    { jsonrpc: "2.0", id: `${index}:account`, method: "getAccountInfo", params: [record.mint, { encoding: "jsonParsed", commitment: "confirmed" }] },
    { jsonrpc: "2.0", id: `${index}:supply`, method: "getTokenSupply", params: [record.mint, { commitment: "confirmed" }] },
    { jsonrpc: "2.0", id: `${index}:largest`, method: "getTokenLargestAccounts", params: [record.mint, { commitment: "confirmed" }] }
  ]);
  try {
    const responses = await solanaRpcBatch(requests, signal);
    const byId = new Map(responses.map(response => [String(response.id), response]));
    const rpcEvidence = {
      observedAt: new Date().toISOString(),
      commitment: "confirmed",
      responseCount: responses.length,
      requestCount: requests.length,
      complete: responses.length === requests.length
    };
    const baseResults = records.map((record, index) => ({
      account: byId.get(`${index}:account`),
      supply: byId.get(`${index}:supply`),
      largest: byId.get(`${index}:largest`),
      poolEvidence: record.poolEvidence
    }));
    const holderRefs = [];
    for (const result of baseResults) {
      for (const holder of (result.largest?.result?.value || []).slice(0, MAX_TAXONOMY_HOLDERS_PER_TOKEN)) {
        if (holder?.address && !holderRefs.some(ref => ref.address === holder.address)) {
          holderRefs.push({ address: holder.address });
        }
        if (holderRefs.length >= MAX_TAXONOMY_ACCOUNT_REQUESTS) break;
      }
      if (holderRefs.length >= MAX_TAXONOMY_ACCOUNT_REQUESTS) break;
    }
    let accountInfoByAddress = {};
    if (holderRefs.length) {
      try {
        const accountResponses = await solanaRpcBatch(holderRefs.map((ref, index) => ({
          jsonrpc: "2.0",
          id: `taxonomy:account:${index}`,
          method: "getAccountInfo",
          params: [ref.address, { encoding: "jsonParsed", commitment: "confirmed" }]
        })), signal);
        accountInfoByAddress = Object.fromEntries(accountResponses.map((response, index) => [
          holderRefs[index].address,
          response
        ]));
      } catch {
        accountInfoByAddress = {};
      }
    }
    const ownerRefs = [...new Set(Object.values(accountInfoByAddress)
      .map(response => response?.result?.value?.data?.parsed?.info?.owner)
      .filter(Boolean))].slice(0, MAX_TAXONOMY_ACCOUNT_REQUESTS);
    let ownerInfoByAddress = {};
    if (ownerRefs.length) {
      try {
        const ownerResponses = await solanaRpcBatch(ownerRefs.map((address, index) => ({
          jsonrpc: "2.0",
          id: `taxonomy:owner:${index}`,
          method: "getAccountInfo",
          params: [address, { encoding: "base64", commitment: "confirmed" }]
        })), signal);
        ownerInfoByAddress = Object.fromEntries(ownerResponses.map((response, index) => [
          ownerRefs[index],
          response
        ]));
      } catch {
        ownerInfoByAddress = {};
      }
    }
    return baseResults.map(result => securityFromRpcResults(
      result.account,
      result.supply,
      result.largest,
      {
        poolEvidence: result.poolEvidence,
        accountInfoByAddress,
        ownerInfoByAddress
      },
      rpcEvidence
    ));
  } catch (error) {
    return records.map(record => unverifiedSecurity(error.message, { poolEvidence: record.poolEvidence }));
  }
}

async function verifyTokenSecurity(mint) {
  try {
    const [account, supply, largest] = await Promise.all([
      solanaRpc("getAccountInfo", [mint, { encoding: "jsonParsed", commitment: "confirmed" }]),
      solanaRpc("getTokenSupply", [mint, { commitment: "confirmed" }]),
      solanaRpc("getTokenLargestAccounts", [mint, { commitment: "confirmed" }])
    ]);
    const info = account?.value?.data?.parsed?.info;
    const mintAuthorityRenounced = Boolean(info) && info.mintAuthority == null;
    const freezeAuthorityRenounced = Boolean(info) && info.freezeAuthority == null;
    const supplyRaw = BigInt(supply?.value?.amount || "0");
    const largestRaw = BigInt(largest?.value?.[0]?.amount || "0");
    const topHolderPercent = supplyRaw > 0n ? Number((largestRaw * 10000n) / supplyRaw) / 100 : null;
    const reasons = [];
    if (!info) reasons.push("Mint account data is unavailable or not an SPL token mint.");
    else {
      if (!mintAuthorityRenounced) reasons.push("Mint authority is still active.");
      if (!freezeAuthorityRenounced) reasons.push("Freeze authority is still active.");
    }
    if (topHolderPercent == null) reasons.push("Token supply or largest-holder data is unavailable.");
    else if (topHolderPercent > MAX_TOP_HOLDER_PERCENT) reasons.push(`Largest holder controls ${topHolderPercent.toFixed(2)}% of supply.`);
    const verified = mintAuthorityRenounced && freezeAuthorityRenounced && topHolderPercent != null && topHolderPercent <= MAX_TOP_HOLDER_PERCENT;
    return {
      verified,
      status: verified ? "VERIFIED" : "REJECTED",
      reasons: reasons.length ? reasons : ["Mint and freeze authorities are renounced; largest-holder concentration is within the 80% limit."],
      authorities: {
        mint: mintAuthorityRenounced ? "RENOUNCED" : "ACTIVE",
        freeze: freezeAuthorityRenounced ? "RENOUNCED" : "ACTIVE",
        metadata: "UNKNOWN"
      },
      holders: largest?.value?.length || null,
      topHolderPercent,
      supply: supply?.value?.uiAmountString || null
    };
  } catch (error) {
    return {
      verified: false,
      status: "UNVERIFIED",
      reasons: [`Security verification failed: ${error.message}`],
      authorities: { mint: "UNKNOWN", freeze: "UNKNOWN", metadata: "UNKNOWN" },
      holders: null,
      topHolderPercent: null,
      supply: null
    };
  }
}

function buildTokenReview(item, security) {
  const change = Number(String(item.priceChange || "").replace("%", ""));
  const positiveChange = Number.isFinite(change) && change > 0;
  const liquidity = Number(item.liquidity);
  const reasons = [
    "Passed mint-authority, freeze-authority, and largest-holder security filters.",
    `Largest-holder concentration: ${security.topHolderPercent.toFixed(2)}% (limit ${MAX_TOP_HOLDER_PERCENT}%).`,
    `Verified liquidity: $${liquidity.toLocaleString("en-US", { maximumFractionDigits: 0 })}.`
  ];
  if (positiveChange) reasons.push(`Positive provider-reported 24h change: ${change.toFixed(2)}%.`);
  if (item.details?.providerMetadata?.boostAmount != null) reasons.push(`DexScreener boost amount: ${item.details.providerMetadata.boostAmount}.`);
  return positiveChange
    ? `Upward bias is based on positive 24h provider momentum, available liquidity, and the verified security checks above. This is evidence, not a guarantee. ${reasons.join(" ")}`
    : `No upward prediction is issued because the provider did not report a positive 24h change. ${reasons.join(" ")}`;
}

function potentialAlert(item) {
  const security = item.details?.security || {};
  const holder = security.topHolderPercent == null ? "UNKNOWN" : `${security.topHolderPercent.toFixed(2)}%`;
  const change = item.priceChange || "UNKNOWN";
  const liquidity = Number(item.liquidity);
  const liquidityText = Number.isFinite(liquidity) ? `$${liquidity.toLocaleString("en-US", { maximumFractionDigits: 0 })}` : "UNKNOWN";
  return {
    type: "POTENTIAL TOKEN",
    token: item.symbol,
    tone: "green",
    time: new Date().toISOString(),
    text: `${item.symbol} passed all active safety filters and shows upward evidence. Review: ${item.rationale} Key checks — mint ${security.authorities?.mint || "UNKNOWN"}, freeze ${security.authorities?.freeze || "UNKNOWN"}, largest holder ${holder}, liquidity ${liquidityText}, 24h ${change}. This is a research alert, not a guarantee.`
  };
}

async function publishPotentialAlerts(previousTokens, currentTokens) {
  const previousMints = new Set(previousTokens.map(item => item.mint));
  const newCandidates = currentTokens.filter(item => !previousMints.has(item.mint));
  const alerts = newCandidates.map(potentialAlert);
  if (!alerts.length) return;
  await recordAlertsAtomic(alerts);
  state.alerts = [...alerts, ...(state.alerts || [])].slice(0, 20);
}

function derivePatterns(tokens, scanRuns = []) {
  const sample = tokens.length;
  const coverage = (label, values) => {
    const available = values.filter(Boolean).length;
    const match = sample ? Math.round((available / sample) * 100) : 0;
    return {
      id: label.id,
      name: label.name,
      desc: label.desc,
      match,
      sample,
      outcome: sample ? `${available}/${sample} provider records contain ${label.field}.` : "No provider records are available.",
      tone: match >= 75 ? "green" : match >= 40 ? "yellow" : "red"
    };
  };
  const successfulScans = scanRuns.filter(run => run.status === "SUCCESS").length;
  return [
    coverage({ id: "LIVE-MARKET", name: "Market coverage", field: "price and liquidity", desc: "Records with provider price and liquidity values." }, tokens.map(token => token.price !== "UNKNOWN" && token.liquidity != null)),
    coverage({ id: "LIVE-CAP", name: "Capital coverage", field: "market cap", desc: "Records with a provider market-cap value." }, tokens.map(token => token.marketCap != null)),
    coverage({ id: "LIVE-EVIDENCE", name: "Evidence coverage", field: "provider evidence", desc: "Records with a persisted evidence trail from DexScreener." }, tokens.map(token => Array.isArray(token.details?.evidence) && token.details.evidence.length > 0)),
    {
      id: "SCAN-RELIABILITY",
      name: "Scan reliability",
      desc: "Completed provider scans compared with all persisted executions.",
      match: scanRuns.length ? Math.round((successfulScans / scanRuns.length) * 100) : 0,
      sample: scanRuns.length,
      outcome: scanRuns.length ? `${successfulScans}/${scanRuns.length} persisted scans completed successfully.` : "No scan executions are available.",
      tone: !scanRuns.length || successfulScans / scanRuns.length < 0.4 ? "red" : successfulScans === scanRuns.length ? "green" : "yellow"
    }
  ];
}

function appendScanRunToState(scanRun, status, audit, details) {
  if (!scanRun?.id) return;
  state.scanRuns = [{
    id: scanRun.id,
    manual: Boolean(scanRun.manual),
    status,
    startedAt: scanRun.startedAt instanceof Date ? scanRun.startedAt.toISOString() : String(scanRun.startedAt),
    ...details,
    ...audit
  }, ...(state.scanRuns || [])].slice(0, 100);
}

function timestampMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d{10,}$/.test(value.trim())) {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue : NaN;
  }
  return Date.parse(String(value || ""));
}

function providerHealthFor(endpoint) {
  const current = providerHealth.get(endpoint) || { failures: 0, openedAt: 0, lastStatus: null };
  if (current.openedAt && Date.now() - current.openedAt >= PROVIDER_CIRCUIT_COOLDOWN_MS) {
    current.openedAt = 0;
    current.failures = 0;
  }
  providerHealth.set(endpoint, current);
  return current;
}

function providerFailure(endpoint, status = null) {
  const health = providerHealthFor(endpoint);
  health.failures += 1;
  health.lastStatus = status;
  if (health.failures >= PROVIDER_CIRCUIT_FAILURE_THRESHOLD) health.openedAt = Date.now();
}

function providerSuccess(endpoint) {
  providerHealth.set(endpoint, { failures: 0, openedAt: 0, lastStatus: null });
}

function retryAfterMs(response, attempt) {
  const header = response?.headers?.get("retry-after");
  const seconds = header == null ? NaN : Number(header);
  return Number.isFinite(seconds) && seconds >= 0
    ? Math.min(5_000, seconds * 1_000)
    : Math.min(5_000, PROVIDER_RETRY_BASE_MS * (2 ** attempt));
}

async function fetchProviderJson(endpoint, { signal, timeoutMs = 5_000 } = {}) {
  const health = providerHealthFor(endpoint);
  if (health.openedAt) throw new Error(`Provider circuit open for ${new URL(endpoint).hostname}.`);
  let lastError;
  for (let attempt = 0; attempt <= PROVIDER_MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(endpoint, {
        signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
        headers: { Accept: "application/json" }
      });
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`Provider HTTP ${response.status}`);
        lastError.status = response.status;
        providerFailure(endpoint, response.status);
        if (attempt < PROVIDER_MAX_RETRIES) {
          await new Promise(resolve => setTimeout(resolve, retryAfterMs(response, attempt)));
          continue;
        }
        throw lastError;
      }
      if (!response.ok) {
        lastError = new Error(`Provider HTTP ${response.status}`);
        lastError.status = response.status;
        providerFailure(endpoint, response.status);
        throw lastError;
      }
      const payload = await response.json();
      providerSuccess(endpoint);
      return payload;
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error;
      if (attempt >= PROVIDER_MAX_RETRIES || error.status >= 400 && error.status < 500 && error.status !== 429) {
        providerFailure(endpoint, error.status || null);
        throw error;
      }
      providerFailure(endpoint, error.status || null);
      await new Promise(resolve => setTimeout(resolve, Math.min(5_000, PROVIDER_RETRY_BASE_MS * (2 ** attempt))));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError || new Error("Provider request failed.");
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function consume() {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, consume));
  return results;
}

function poolEvidenceFromItem(item) {
  const pair = item?.details?.pair || {};
  const supplied = pair.poolEvidence || pair.pool || pair.info?.poolEvidence || {};
  return normalizePoolEvidence({
    ...supplied,
    // A DexScreener pair address is not proof of a Solana AMM pool account.
    // Only explicit provider evidence can classify pool/vault ownership.
    poolAddress: supplied.poolAddress || supplied.address || null,
    ammType: supplied.ammType || supplied.dexId || pair.dexId || null,
    source: supplied.source || "DexScreener pair identity"
  });
}

function observationData(item, endpoint, sourceRequestId, observedAt, pairOverride = null, pairRole = "primary") {
  const pair = pairOverride || item.details?.pair || {};
  const providerMetadata = item.details?.providerMetadata || {};
  const decision = evaluatePhase2Candidate(item);
  const rawPayload = {
    providerMetadata,
    pair,
    pairRole,
    discoverySources: item.details?.discoverySources || [],
    marketQuality: item.details?.marketQuality || decision.marketQuality || null
  };
  return {
    mint: item.mint,
    pairAddress: pair.address || null,
    chainId: providerMetadata.chainId || "solana",
    dexId: pair.dexId || null,
    baseToken: pair.baseToken || null,
    quoteToken: pair.quoteToken || null,
    observedAt,
    providerUpdatedAt: pair.updatedAt || providerMetadata.providerUpdatedAt || null,
    pairCreatedAt: pair.pairCreatedAt || null,
    priceUsd: Number.isFinite(Number(pair.priceUsd)) ? Number(pair.priceUsd) : null,
    marketCap: Number.isFinite(Number(pair.marketCap)) ? Number(pair.marketCap) : null,
    fdv: Number.isFinite(Number(pair.fdv)) ? Number(pair.fdv) : null,
    liquidityUsd: Number.isFinite(Number(pair.liquidityUsd)) ? Number(pair.liquidityUsd) : null,
    volume: pair.volume || null,
    transactions: pair.txns || null,
    makers: pair.makers || null,
    priceChange: pair.priceChange || null,
    boostAmount: Number.isFinite(Number(providerMetadata.boostAmount)) ? Number(providerMetadata.boostAmount) : null,
    ctoFlag: typeof providerMetadata.cto === "boolean" ? providerMetadata.cto : null,
    source: "DexScreener",
    sourceEndpoint: endpoint,
    sourceRequestId,
    sourceResponseHash: crypto.createHash("sha256").update(JSON.stringify(rawPayload)).digest("hex"),
    freshnessMs: Number.isFinite(timestampMs(pair.updatedAt || providerMetadata.providerUpdatedAt))
      ? Math.max(0, Date.now() - timestampMs(pair.updatedAt || providerMetadata.providerUpdatedAt))
      : null,
    dataQuality: pair.address ? `${pairRole.toUpperCase()}_PAIR_SECURITY_SEPARATE` : "MISSING_PAIR",
    qualityReasons: decision.reasonCodes,
    accountTaxonomy: item.details?.security?.accountTaxonomy || null,
    poolEvidence: item.details?.security?.poolEvidence || poolEvidenceFromItem(item),
    concentration: item.details?.security?.concentration || null,
    rawPayload
  };
}

async function fetchLiveTokens({ correlationId, signal } = {}) {
  const boostEndpoint = process.env.DEXSCREENER_API_URL || "https://api.dexscreener.com/token-boosts/latest/v1";
  const profileEndpoint = process.env.DEXSCREENER_PROFILES_API_URL || "https://api.dexscreener.com/token-profiles/latest/v1";
  const pairEndpoint = process.env.DEXSCREENER_PAIR_API_URL || "https://api.dexscreener.com/latest/dex/tokens";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  const observedAt = new Date().toISOString();
  const sourceRequestId = correlationId || crypto.randomUUID();
  let pairRequests = 0;
  let pairFailures = 0;
  let invalidFeedRecords = 0;
  let invalidPairRecords = 0;
  let schemaErrors = 0;
  const invalidFeedReasonCounts = {};
  const rpcFailureReasons = new Set();
  try {
    const requestSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    const readFeed = async endpoint => {
      try {
        const payload = await fetchProviderJson(endpoint, { signal: requestSignal });
        const validation = validateProviderFeed(payload);
        invalidFeedRecords += validation.invalidRecords || 0;
        for (const [reason, count] of Object.entries(validation.invalidReasonCounts || {})) {
          invalidFeedReasonCounts[reason] = (invalidFeedReasonCounts[reason] || 0) + count;
        }
        if (!validation.ok) {
          schemaErrors += 1;
          return { ok: false, entries: [], error: validation.errors.join("; "), schemaVersion: validation.schemaVersion };
        }
        return {
          ok: true,
          entries: validation.entries,
          error: null,
          schemaVersion: validation.schemaVersion
        };
      } catch (error) {
        if (signal?.aborted) throw error;
        return { ok: false, entries: [], error: error.message, schemaVersion: PROVIDER_SCHEMA_VERSION };
      }
    };
    const [boostFeed, profileFeed] = await Promise.all([readFeed(boostEndpoint), readFeed(profileEndpoint)]);
    const boostEntries = boostFeed.entries.filter(item => item.chainId === "solana" && item.tokenAddress);
    const profileEntries = profileFeed.entries.filter(item => item.chainId === "solana" && item.tokenAddress);
    const discovery = normalizeDiscoveryUniverse({
      boostEntries,
      profileEntries,
      watchlistMints: state.watchlist,
      limit: Math.max(1, Math.min(100, Number(process.env.DEXSCREENER_DISCOVERY_LIMIT || 30)))
    });
    pairRequests = discovery.entries.length;
    const pairResponses = await mapWithConcurrency(discovery.entries, PROVIDER_MAX_CONCURRENCY, async entry => {
      const mint = entry.tokenAddress;
      try {
        const payload = await fetchProviderJson(`${pairEndpoint}/${encodeURIComponent(mint)}`, { signal: requestSignal });
        const raw = Array.isArray(payload?.pairs) ? payload.pairs : [];
        const pairs = [];
        for (const candidate of raw) {
          const validation = validateProviderPair(candidate);
          if (validation.valid) pairs.push(validation.pair);
          else invalidPairRecords += 1;
        }
        if (!Array.isArray(payload?.pairs)) {
          schemaErrors += 1;
          pairFailures += 1;
          return { pairs: [], schemaError: "Pair response must contain a pairs array." };
        }
        return { pairs, invalidPairs: raw.length - pairs.length };
      } catch {
        pairFailures += 1;
        return { pairs: [] };
      }
    });
    const rawPairs = pairResponses.flatMap(result => Array.isArray(result?.pairs) ? result.pairs : []);
    const allPairs = dedupePairs(rawPairs);
    const fresh = discovery.entries.map((entry, index) => {
      const mint = entry.tokenAddress || `live-${index}`;
      const pairs = dedupePairs(Array.isArray(pairResponses[index]?.pairs) ? pairResponses[index].pairs : []);
       const pair = selectPrimaryPair(pairs);
      const boost = entry.sourceEntries.boost_feed || {};
      const profile = entry.sourceEntries.new_pair_feed || {};
      const shortMint = mint.slice(0, 4).toUpperCase();
      const baseToken = pair?.baseToken || {};
      const pairInfo = pair?.info || {};
      const sourceItem = { ...profile, ...boost };
      const symbol = baseToken.symbol || sourceItem.symbol || `SOL-${shortMint}`;
      const name = baseToken.name || sourceItem.name || String(sourceItem.description || "").split(/\r?\n/).map(line => line.trim()).find(Boolean) || `Solana token ${shortMint}`;
      const description = sourceItem.description || pairInfo.description || null;
      const links = providerLinks(sourceItem.links, pairInfo.websites, pairInfo.socials);
      const websites = providerLinks(sourceItem.links, pairInfo.websites).filter(link => !["twitter", "telegram", "discord"].includes(link.type));
      const socials = providerLinks(sourceItem.links, pairInfo.socials).filter(link => !websites.some(site => site.url === link.url));
      const imageUrl = /^https?:\/\//i.test(String(sourceItem.icon || "")) ? sourceItem.icon : pairInfo.imageUrl || null;
      const headerUrl = /^https?:\/\//i.test(String(sourceItem.header || "")) ? sourceItem.header : pairInfo.header || null;
      const providerMetadata = {
        chainId: "solana", symbol, name, icon: imageUrl, header: headerUrl,
        openGraph: sourceItem.openGraph || null, description, links, websites, socials, pairInfo,
        cto: typeof boost.cto === "boolean" ? boost.cto : null,
        boostAmount: boost.amount ?? null, totalBoostAmount: boost.totalAmount ?? null,
        providerUpdatedAt: boost.updatedAt || profile.updatedAt || null,
        discoverySources: entry.sources
      };
      const evidence = [
        `DexScreener discovery sources: ${entry.sources.join(", ")}.`,
        "DexScreener supplied live discovery metadata and pair data when available; missing market metrics remain UNKNOWN.",
        `DexScreener CTO flag: ${providerMetadata.cto == null ? "UNKNOWN" : providerMetadata.cto ? "TRUE" : "FALSE"}.`,
        links.length ? `DexScreener supplied ${links.length} external link${links.length === 1 ? "" : "s"}.` : "DexScreener supplied no external links."
      ];
      if (providerMetadata.boostAmount != null) evidence.push(`Reported boost amount: ${providerMetadata.boostAmount}.`);
      if (providerMetadata.providerUpdatedAt) evidence.push(`Provider metadata updated ${providerMetadata.providerUpdatedAt}.`);
      const providerTime = providerMetadata.providerUpdatedAt ? Date.parse(providerMetadata.providerUpdatedAt) : NaN;
      const providerAge = Number.isFinite(providerTime) ? formatAge(Math.max(0, Date.now() - providerTime)) : "UNKNOWN";
      const price = pair?.priceUsd ? `$${pair.priceUsd}` : "UNKNOWN";
      const marketCap = Number.isFinite(Number(pair?.marketCap)) ? Number(pair.marketCap) : null;
      const liquidity = Number.isFinite(Number(pair?.liquidity?.usd)) ? Number(pair.liquidity.usd) : null;
      const priceChange = pair?.priceChange?.h24 != null ? `${Number(pair.priceChange.h24).toFixed(2)}%` : "UNKNOWN";
      const base = token(symbol, name, price, marketCap, liquidity, null, null, null, null, null, null, null, priceChange, "UNKNOWN", "UNKNOWN", providerMetadata.cto ? "CTO FLAG" : "PROVIDER", providerAge, "Pending independent Solana security verification.", "unknown", null, "UNKNOWN");
      return {
        ...base, mint, symbol, name,
        providerUrl: pair?.url || sourceItem.url || `https://dexscreener.com/solana/${mint}`,
        details: {
          ...base.details, source: "DexScreener", coverage: "DEXSCREENER_MULTI_SOURCE_DISCOVERY",
          discoverySources: entry.sources,
          pair: pair ? {
            address: pair.pairAddress || null, dexId: pair.dexId || null, url: pair.url || null,
            baseToken: pair.baseToken || null, quoteToken: pair.quoteToken || null,
             pairCreatedAt: pair.pairCreatedAt || null, updatedAt: pair.updatedAt || null, labels: Array.isArray(pair.labels) ? pair.labels : [],
             priceUsd: pair.priceUsd ?? null, fdv: pair.fdv ?? null, marketCap: pair.marketCap ?? null,
             liquidityUsd: pair.liquidity?.usd ?? null, volume: pair.volume || null,
             priceChange: pair.priceChange || null, txns: pair.txns || null, makers: pair.makers || null,
            info: pair.info || null, pairCountForMint: pairs.length
          } : null,
          pairs: pairs.map(candidate => ({
            address: candidate.pairAddress || null, dexId: candidate.dexId || null, url: candidate.url || null,
            chainId: candidate.chainId || null, baseToken: candidate.baseToken || null, quoteToken: candidate.quoteToken || null,
             pairCreatedAt: candidate.pairCreatedAt || null, updatedAt: candidate.updatedAt || null,
            priceUsd: candidate.priceUsd ?? null, fdv: candidate.fdv ?? null, marketCap: candidate.marketCap ?? null,
             liquidityUsd: candidate.liquidity?.usd ?? null, volume: candidate.volume || null,
             priceChange: candidate.priceChange || null, txns: candidate.txns || null, makers: candidate.makers || null
          })),
          primaryPairPolicy: "SOLANA_ONLY_WITH_PRICE_AND_LIQUIDITY_THEN_LIQUIDITY_UPDATED_CREATED_ADDRESS",
          providerMetadata,
          profile: { description, imageUrl, headerUrl, websites, socials, openGraph: sourceItem.openGraph || null },
          evidence
        }
      };
    });
    const rpcStartedAt = Date.now();
    const securityResults = await verifyTokensSecurity(fresh.map(item => ({
      mint: item.mint,
      poolEvidence: poolEvidenceFromItem(item)
    })), signal);
    for (const reason of securityResults.flatMap(result => result?.status === "UNVERIFIED" ? result.reasons || [] : [])) {
      rpcFailureReasons.add(String(reason).slice(0, 240));
    }
    const rpcFreshnessMs = Date.now() - rpcStartedAt;
    const secured = fresh.map((item, index) => ({
      ...item,
      security: securityResults[index],
      details: {
        ...item.details,
        security: securityResults[index],
        marketQuality: evaluateMarketQuality(item)
      }
    }));
    const decisions = secured.map(evaluatePhase2Candidate);
    const safeTokens = secured.filter((item, index) => decisions[index].accepted).map(item => {
      const rationale = buildTokenReview(item, item.security);
      return {
        ...item, rationale, potential: "UPWARD BIAS",
        details: {
          ...item.details, holders: item.security.holders,
          holderConcentration: item.security.topHolderPercent,
          authorities: item.security.authorities,
          security: item.security,
          evidence: [...item.details.evidence, ...item.security.reasons, rationale]
        }
      };
    });
    const providerAgeMs = fresh.reduce((maxAge, item) => {
      const updatedAt = timestampMs(item.details?.providerMetadata?.providerUpdatedAt);
      return Number.isFinite(updatedAt) ? Math.max(maxAge, Math.max(0, Date.now() - updatedAt)) : maxAge;
    }, 0) || null;
    const rpcStatuses = securityResults.map(result => result.status);
    const rpcStatus = rpcStatuses.length && rpcStatuses.every(status => status !== "UNVERIFIED")
      ? "LIVE"
      : rpcStatuses.some(status => status !== "UNVERIFIED") ? "PARTIAL" : "FAILED";
    const report = summarizePhase2Candidates(secured, {
      checked: secured.length,
       providerRecords: boostEntries.length + profileEntries.length,
       discoveryUniverseSize: discovery.entries.length,
       providerRecordsWithPair: fresh.filter(item => (item.details?.pairs || []).length > 0).length,
      providerRecordsWithPrice: fresh.filter(item => item.price !== "UNKNOWN").length,
      providerRecordsWithLiquidity: fresh.filter(item => item.liquidity != null).length,
      pairRequests, pairFailures, providerAgeMs, rpcFreshnessMs,
      rpcStatus, rpcCommitment: "confirmed",
       qualityStatus: rpcStatus === "LIVE" && pairFailures === 0
         ? "FULL"
         : rpcStatus === "PARTIAL" || pairFailures > 0
           ? "PARTIAL"
           : "FAILED",
      filterConfig: PHASE2_FILTER_CONFIG,
      sourceMetrics: {
        ...discovery.sourceMetrics,
         unique_pairs_before_dedup: new Set(rawPairs.map(pair => pair.pairAddress).filter(Boolean)).size,
        unique_pairs_after_dedup: new Set(fresh.flatMap(item => item.details?.pairs || []).map(pair => pair.address).filter(Boolean)).size,
        discovery_sources: {
          boost_feed: { endpoint: boostEndpoint, ok: boostFeed.ok, error: boostFeed.error },
          new_pair_feed: { endpoint: profileEndpoint, ok: profileFeed.ok, error: profileFeed.error },
          watchlist: { count: state.watchlist.length, ok: true }
        },
        primary_pair_policy: "SOLANA_ONLY_WITH_PRICE_AND_LIQUIDITY_THEN_LIQUIDITY_UPDATED_CREATED_ADDRESS"
         ,
         provider_schema_version: PROVIDER_SCHEMA_VERSION,
         invalid_feed_records: invalidFeedRecords,
         invalid_pair_records: invalidPairRecords,
         schema_errors: schemaErrors,
         invalid_feed_reason_counts: invalidFeedReasonCounts,
         rpc_failure_reasons: [...rpcFailureReasons],
         provider_health: Object.fromEntries([...providerHealth.entries()].map(([endpoint, health]) => [
           endpoint,
           { failures: health.failures, circuitOpen: Boolean(health.openedAt), lastStatus: health.lastStatus }
         ]))
         ,
         rpc_health: rpcHealthSummary()
      }
    });
    lastFilterReport = {
      ...report,
      checked: report.recordsChecked,
      accepted: report.accepted,
      rejected: report.rejected,
      unresolved: report.unresolved,
      tokensPersisted: safeTokens.length,
      reasons: report.reasons
    };
    return {
      tokens: safeTokens,
      observations: secured.flatMap(item => {
        const pairs = item.details?.pairs?.length ? item.details.pairs : [item.details?.pair || null];
        return pairs.map(candidate => observationData(
          item,
          pairEndpoint,
          sourceRequestId,
          observedAt,
          candidate,
          candidate?.address && candidate.address === item.details?.pair?.address ? "primary" : "secondary"
        ));
      }),
      report: lastFilterReport
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function runScan(manual = false, options = {}) {
  const correlationId = crypto.randomUUID();
  const idempotencyKey = options.idempotencyKey || null;
  const requestId = options.requestId || null;
  if (idempotencyKey) {
    const previousRun = await findScanByIdempotencyKey(idempotencyKey);
    if (previousRun) {
      return {
        ok: previousRun.status === "SUCCESS",
        duplicate: true,
        scanRunId: previousRun.id,
        status: previousRun.status,
        message: "The scan request was already accepted."
      };
    }
  }
  if (state.scanRunning) {
    await recordSkippedScan({ manual, provider: state.provider, correlationId, requestId, idempotencyKey, reason: "overlapping_scan" });
    return { ok: false, skipped: true, message: "A scan is already running.", requestId };
  }
  let leaseAcquired = false;
  try {
    leaseAcquired = await acquireScanLease(correlationId, LIVE_SCAN_TIMEOUT_MS + 10_000);
  } catch (error) {
    console.error(`[${requestId || correlationId}] Scan lease unavailable`, error.message);
    return { ok: false, message: "Scan lock is temporarily unavailable.", requestId };
  }
  if (!leaseAcquired) {
    await recordSkippedScan({ manual, provider: state.provider, correlationId, requestId, idempotencyKey, reason: "distributed_scan_lock" });
    return { ok: false, skipped: true, message: "A scan is already running.", requestId };
  }
  state.scanRunning = true;
  const started = Date.now();
  let scanRun = null;
  let scanResult = null;
  const scanController = new AbortController();
  let scanDeadline;
  let deadlineExceeded = false;
  lastFilterReport = {
    ...lastFilterReport,
    checked: 0,
    accepted: 0,
    rejected: 0,
    unresolved: 0,
    reasons: [],
    providerRecords: 0,
    pairRequests: 0,
    pairFailures: 0,
    providerAgeMs: null,
    rpcFreshnessMs: null,
    rpcStatus: "NOT RUN",
    qualityStatus: "RUNNING",
    tokensPersisted: 0,
    timedOut: false,
    timeoutReason: null,
    sourceMetrics: {}
  };
  const scanAudit = () => ({
    recordsChecked: lastFilterReport.checked || 0,
    acceptedCount: lastFilterReport.accepted || 0,
    rejectedCount: lastFilterReport.rejected || 0,
    unresolvedCount: lastFilterReport.unresolved || 0,
    rejectionReasons: lastFilterReport.reasons || [],
    filterConfig: lastFilterReport.filterConfig || PHASE2_FILTER_CONFIG,
    providerAgeMs: lastFilterReport.providerAgeMs ?? null,
    providerRecords: lastFilterReport.providerRecords || 0,
    pairRequests: lastFilterReport.pairRequests || 0,
    pairFailures: lastFilterReport.pairFailures || 0,
    rpcStatus: lastFilterReport.rpcStatus || "NOT RUN",
    qualityStatus: lastFilterReport.qualityStatus || "NOT RUN",
    discoveryUniverseSize: lastFilterReport.discoveryUniverseSize || 0,
    providerRecordsWithPair: lastFilterReport.providerRecordsWithPair || 0,
    providerRecordsWithPrice: lastFilterReport.providerRecordsWithPrice || 0,
    providerRecordsWithLiquidity: lastFilterReport.providerRecordsWithLiquidity || 0,
    securityVerified: lastFilterReport.securityVerified || 0,
    securityUnknown: lastFilterReport.securityUnknown || 0,
    securityRejected: lastFilterReport.securityRejected || 0,
    liquidityRejected: lastFilterReport.liquidityRejected || 0,
    momentumRejected: lastFilterReport.momentumRejected || 0,
    ctoRejected: lastFilterReport.ctoRejected || 0,
    tokensPersisted: lastFilterReport.tokensPersisted || 0,
    providerFreshnessMs: lastFilterReport.providerAgeMs ?? null,
    rpcFreshnessMs: lastFilterReport.rpcFreshnessMs ?? null,
    rpcCommitment: lastFilterReport.rpcCommitment || "confirmed",
    timedOut: Boolean(lastFilterReport.timedOut),
    timeoutReason: lastFilterReport.timeoutReason || null,
    decisionVersion: PHASE2_DECISION_VERSION,
    correlationId,
    requestId,
    sourceMetrics: lastFilterReport.sourceMetrics || {}
  });
  try {
    scanRun = await Promise.race([
      createScanRun({
        manual,
        status: "RUNNING",
        startedAt: new Date(started),
        provider: state.provider,
        decisionVersion: PHASE2_DECISION_VERSION,
        correlationId,
        requestId,
        idempotencyKey,
        ...scanAudit()
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Scan run could not be registered in the database.")), 8000))
    ]);
    state.mode = "live";
    state.provider = "DexScreener";
    const previousTokens = state.tokens;
    scanDeadline = setTimeout(() => {
      deadlineExceeded = true;
      scanController.abort();
    }, LIVE_SCAN_TIMEOUT_MS);
    scanResult = await Promise.race([
      fetchLiveTokens({ correlationId, signal: scanController.signal }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("LIVE scan timed out before provider verification completed.")), LIVE_SCAN_TIMEOUT_MS))
    ]);
    clearTimeout(scanDeadline);
    lastFilterReport = scanResult.report;
    if (scanRun?.id) await recordTokenObservations(scanResult.observations, scanRun.id);
    const hasAcceptedTokens = scanResult.tokens.length > 0;
    const completeScan = scanResult.report.qualityStatus === "FULL";
    if (completeScan && hasAcceptedTokens) {
      state.tokens = selectBoardTokens(state.tokens, scanResult.tokens);
      lastFilterReport.tokensPersisted = scanResult.tokens.length;
    } else {
      lastFilterReport.tokensPersisted = 0;
      if (!completeScan) throw new Error(`LIVE scan completed with ${scanResult.report.qualityStatus.toLowerCase()} coverage.`);
      throw new Error("No token passed the LIVE security and upward-evidence filters.");
    }
    await publishPotentialAlerts(previousTokens, state.tokens);
    state.system.rpc = "LIVE PROVIDER";
    state.system.market = "LIVE PROVIDER";
    state.whaleActivity = [];
    state.lastScan = new Date().toISOString();
    state.nextScanAt = Date.now() + AUTO_SCAN_MS;
    state.system.lastScanStatus = "SUCCESS";
    state.system.avgDuration = `${Date.now() - started}ms`;
    state.system.tokensPerScan = scanResult.tokens.length;
    state.system.transactionsPerScan = 0;
    state.system.securityFilter = lastFilterReport;
    state.system.lastScanQuality = lastFilterReport.qualityStatus;
    state.system.lastScanRunId = scanRun.id;
    delete state.system.lastScanError;
    state.scanRunning = false;
    const finishedAt = new Date();
    const durationMs = Date.now() - started;
    await finishScanRun(scanRun.id, {
      status: "SUCCESS",
      finishedAt,
      durationMs,
      tokensScanned: lastFilterReport.recordsChecked || 0,
      transactionsProcessed: 0,
      errorCount: 0,
      ...scanAudit()
    });
    appendScanRunToState(scanRun, "SUCCESS", scanAudit(), {
      finishedAt: finishedAt.toISOString(),
      durationMs,
        tokensScanned: lastFilterReport.recordsChecked || 0,
      transactionsProcessed: 0,
      errorCount: 0
    });
    state.patterns = derivePatterns(state.tokens, state.scanRuns);
    await persistPatterns(state.patterns);
    await saveState();
    return { ok: true, manual, duration: Date.now() - started, tokens: state.tokens.length };
  } catch (error) {
    if (scanDeadline) clearTimeout(scanDeadline);
    state.scanRunning = false;
    const filtered = error.message === "No token passed the LIVE security and upward-evidence filters."
      && lastFilterReport.unresolved === 0
      && lastFilterReport.qualityStatus === "FULL";
    const partial = Boolean(scanResult) && lastFilterReport.qualityStatus === "PARTIAL";
    const timedOut = deadlineExceeded || /timed out|timeout|aborted/i.test(error.message);
    if (!scanResult || deadlineExceeded) {
      lastFilterReport = {
        ...lastFilterReport,
        qualityStatus: timedOut ? "TIMEOUT" : "FAILED",
        rpcStatus: "UNKNOWN",
        timedOut,
        timeoutReason: timedOut ? error.message : null,
        tokensPersisted: 0
      };
    }
    state.nextScanAt = Date.now() + AUTO_SCAN_MS;
    state.system.lastScanStatus = filtered
      ? "FILTERED · 0 SAFE TOKENS"
      : partial
        ? "PARTIAL · BOARD UNCHANGED"
        : "FAILED";
    state.system.tokensPerScan = 0;
    state.system.securityFilter = lastFilterReport;
    state.system.lastScanError = error.message;
    state.system.lastScanQuality = filtered ? lastFilterReport.qualityStatus : partial ? "PARTIAL" : "FAILED";
    if (scanRun?.id) state.system.lastScanRunId = scanRun.id;
    if (!filtered) state.system.errors += 1;
    if (scanRun) {
      const finishedAt = new Date();
      const durationMs = Date.now() - started;
      const status = filtered ? "FILTERED" : partial ? "PARTIAL" : "FAILED";
      const audit = scanAudit();
      await finishScanRun(scanRun.id, {
        status,
        finishedAt,
        durationMs,
        tokensScanned: lastFilterReport.recordsChecked || 0,
        transactionsProcessed: 0,
        errorCount: filtered || partial ? 0 : 1,
        timedOut,
        timeoutReason: timedOut ? error.message : null,
        tokensPersisted: 0,
        ...audit
      });
      appendScanRunToState(scanRun, status, audit, {
        finishedAt: finishedAt.toISOString(),
        durationMs,
        tokensScanned: lastFilterReport.recordsChecked || 0,
        transactionsProcessed: 0,
        errorCount: filtered || partial ? 0 : 1
      });
    }
    await saveState();
    return { ok: false, message: filtered ? "No token passed the active security filters. No token was added to Radar." : "DexScreener provider temporarily unavailable. Data remains unchanged.", securityFilter: lastFilterReport, requestId };
  } finally {
    if (leaseAcquired) {
      try {
        await releaseScanLease(correlationId);
      } catch (releaseError) {
        console.error(`[${requestId || correlationId}] Scan lease release failed`, releaseError.message);
      }
    }
  }
}

async function handleApi(req, res, url) {
  if (mutationRoute(url, req.method) && !mutationAllowed(req)) {
    return send(res, 403, { error: "Mutation is not authorized for this origin.", requestId: req.requestId });
  }
  if (req.method === "GET" && url.pathname === "/api/state") return send(res, 200, jsonState());
  if (req.method === "GET" && url.pathname.startsWith("/api/tokens/")) {
    const item = tokenById(decodeURIComponent(url.pathname.split("/").pop()));
    return item ? send(res, 200, { token: item, mode: state.mode }) : send(res, 404, { error: "Token not found" });
  }
  if (req.method === "POST" && url.pathname === "/api/scan") {
    const rawIdempotencyKey = String(req.headers["idempotency-key"] || "");
    const idempotencyKey = /^[A-Za-z0-9._:-]{1,128}$/.test(rawIdempotencyKey) ? rawIdempotencyKey : null;
    return send(res, 200, await runScan(true, { requestId: req.requestId, idempotencyKey }));
  }
  if (req.method === "POST" && url.pathname === "/api/analysis") {
    const mutationOwner = await lockMutation(req);
    if (!mutationOwner) return send(res, 409, { error: "Another state mutation is in progress.", requestId: req.requestId });
    try {
      state = await readState(state);
      state.patterns = derivePatterns(state.tokens, state.scanRuns);
      await persistPatterns(state.patterns);
      await saveState();
      return send(res, 200, { ok: true, patterns: state.patterns.length, state: jsonState() });
    } finally {
      await unlockMutation(mutationOwner, req.requestId);
    }
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/watchlist/")) {
    const mutationOwner = await lockMutation(req);
    if (!mutationOwner) return send(res, 409, { error: "Another state mutation is in progress.", requestId: req.requestId });
    try {
      state = await readState(state);
      const id = decodeURIComponent(url.pathname.split("/").pop());
      const item = tokenById(id);
      if (!item) return send(res, 404, { error: "Token not found" });
      const nextState = {
        ...state,
        watchlist: state.watchlist.includes(item.mint) ? [...state.watchlist] : [...state.watchlist, item.mint],
        watchlistHistory: [...state.watchlistHistory, { mint: item.mint, action: "ADDED", at: new Date().toISOString() }]
      };
      await persistState(nextState, { watchlistEvent: { mint: item.mint, action: "ADDED" } });
      state = nextState;
      return send(res, 200, { ok: true, watchlist: state.watchlist });
    } finally {
      await unlockMutation(mutationOwner, req.requestId);
    }
  }
  if (req.method === "DELETE" && url.pathname.startsWith("/api/watchlist/")) {
    const mutationOwner = await lockMutation(req);
    if (!mutationOwner) return send(res, 409, { error: "Another state mutation is in progress.", requestId: req.requestId });
    try {
      state = await readState(state);
      const id = decodeURIComponent(url.pathname.split("/").pop());
      const item = tokenById(id);
      if (item) {
        const nextState = {
          ...state,
          watchlist: state.watchlist.filter(mint => mint !== item.mint),
          watchlistHistory: [...state.watchlistHistory, { mint: item.mint, action: "REMOVED_FROM_ACTIVE_VIEW", at: new Date().toISOString() }]
        };
        await persistState(nextState, { watchlistEvent: { mint: item.mint, action: "REMOVED_FROM_ACTIVE_VIEW" } });
        state = nextState;
      }
      return send(res, 200, { ok: true, watchlist: state.watchlist });
    } finally {
      await unlockMutation(mutationOwner, req.requestId);
    }
  }
  if (req.method === "POST" && url.pathname === "/api/trades") {
    let idempotencyKey = null;
    let mutationOwner = null;
    try {
      const body = await readBody(req);
      if (typeof body.mint !== "string" || body.mint.length < 1 || body.mint.length > 128 || !["BUY", "SELL"].includes(body.side)) {
        return send(res, 422, { error: "Trade requires a valid mint and BUY or SELL side.", requestId: req.requestId });
      }
      const rawIdempotencyKey = String(req.headers["idempotency-key"] || "");
      idempotencyKey = /^[A-Za-z0-9._:-]{1,128}$/.test(rawIdempotencyKey) ? rawIdempotencyKey : null;
      if (idempotencyKey && await findTradeByIdempotencyKey(idempotencyKey)) {
        return send(res, 200, { ok: true, duplicate: true, state: jsonState(), requestId: req.requestId });
      }
      mutationOwner = await lockMutation(req);
      if (!mutationOwner) return send(res, 409, { error: "Another state mutation is in progress.", requestId: req.requestId });
      state = await readState(state);
      if (idempotencyKey && await findTradeByIdempotencyKey(idempotencyKey)) {
        return send(res, 200, { ok: true, duplicate: true, state: jsonState(), requestId: req.requestId });
      }
      const item = tokenById(body.mint);
      if (!item) return send(res, 404, { error: "Token not found" });
      const price = parseFloat(String(item.price).replace("$", ""));
      if (!Number.isFinite(price)) return send(res, 422, { error: "Current price is unavailable; paper trade cannot be simulated." });
      const nextPortfolio = JSON.parse(JSON.stringify(state.portfolio));
      let tradeRecord;
      if (body.side === "BUY") {
        const amount = 100;
        if (nextPortfolio.cash < amount) return send(res, 422, { error: "Insufficient virtual cash." });
        if (nextPortfolio.positions.some(position => position.mint === item.mint)) return send(res, 409, { error: "An open virtual position already exists for this token." });
        const fee = amount * 0.003;
        const position = { mint: item.mint, symbol: item.symbol, name: item.name, invested: amount, quantity: (amount - fee) / price, entry: price, peakPnl: 0, openedAt: Date.now() };
        nextPortfolio.cash -= amount;
        nextPortfolio.fees += fee;
        nextPortfolio.trades += 1;
        nextPortfolio.positions.push(position);
        const tradeTime = Date.now();
        nextPortfolio.history.unshift({ symbol: item.symbol, side: "BUY", amount, price, fee, score: item.radar, time: tradeTime });
        tradeRecord = { mint: item.mint, symbol: item.symbol, side: "BUY", amount, price, fee, score: item.radar, time: tradeTime, idempotencyKey };
      } else if (body.side === "SELL") {
        const position = nextPortfolio.positions.find(p => p.mint === item.mint);
        if (!position) return send(res, 422, { error: "No open paper position for this token." });
        const value = position.quantity * price;
        const fee = value * 0.003;
        nextPortfolio.cash += value - fee;
        nextPortfolio.realized += value - fee - position.invested;
        nextPortfolio.fees += fee;
        const tradeTime = Date.now();
        nextPortfolio.history.unshift({ symbol: item.symbol, side: "SELL", amount: value, price, fee, score: item.radar, time: tradeTime });
        nextPortfolio.positions = nextPortfolio.positions.filter(p => p !== position);
        tradeRecord = { mint: item.mint, symbol: item.symbol, side: "SELL", amount: value, price, fee, score: item.radar, time: tradeTime, idempotencyKey };
      }
      const nextState = { ...state, portfolio: nextPortfolio };
      await persistState(nextState, { tradeRecord });
      state = nextState;
      return send(res, 200, { ok: true, state: jsonState() });
    } catch (error) {
      if (/Payload too large|Request body timed out|Invalid JSON|Request body must be/.test(error.message)) {
        return send(res, error.message === "Payload too large." ? 413 : 400, { error: error.message, requestId: req.requestId });
      }
      if (error.code === "P2002" && idempotencyKey) {
        const existing = await findTradeByIdempotencyKey(idempotencyKey);
        if (existing) return send(res, 200, { ok: true, duplicate: true, state: jsonState(), requestId: req.requestId });
      }
      console.error(`[${req.requestId}] Paper trade failed`, error.message);
      return send(res, 500, { error: "Paper trade could not be persisted.", requestId: req.requestId });
    } finally {
      await unlockMutation(mutationOwner, req.requestId);
    }
  }
  send(res, 404, { error: "API route not found" });
}

function serveStatic(req, res, url) {
  let pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = path.normalize(path.join(PUBLIC, pathname));
  if (!file.startsWith(PUBLIC)) return send(res, 403, "Forbidden");
  fs.readFile(file, (error, content) => {
    if (error) return send(res, 404, "Not found");
    const ext = path.extname(file);
    const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
    res.writeHead(200, { ...securityHeaders(), "Content-Type": types[ext] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(content);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  req.requestId = requestId(req);
  res.setHeader("X-Request-ID", req.requestId);
  req.setTimeout(BODY_TIMEOUT_MS, () => {
    if (!res.headersSent) send(res, 408, { error: "Request timed out.", requestId: req.requestId });
    req.destroy();
  });
  const limit = rateLimit(req, url);
  if (!limit.allowed) {
    return send(res, 429, { error: "Rate limit exceeded.", requestId: req.requestId }, { "Retry-After": String(limit.retryAfter) });
  }
  if (url.pathname.startsWith("/api/")) {
    return handleApi(req, res, url).catch(error => {
      console.error(`[${req.requestId}] API request failed`, error.message);
      if (!res.headersSent) send(res, 500, { error: "Internal server error.", requestId: req.requestId });
    });
  }
  serveStatic(req, res, url);
});

async function start() {
  try {
    state = await readState(state);
    state.system.database = "POSTGRESQL / PRISMA";
    state.system.scheduler = "RUNNING · 15s";
    state.nextScanAt = Date.now() + AUTO_SCAN_MS;
    if (!state.patterns.length && state.tokens.length) {
      state.patterns = derivePatterns(state.tokens, state.scanRuns);
      await persistPatterns(state.patterns);
    }
    await saveState();
    setInterval(() => { if (!state.scanRunning) runScan(false).catch(error => console.error("Automatic scan failed", error)); }, AUTO_SCAN_MS);
    setInterval(() => {
      state.system.lastAnalysis = new Date().toISOString();
      saveState().catch(error => console.error("Analysis checkpoint failed", error));
    }, ANALYSIS_MS);
    server.listen(PORT, "0.0.0.0", () => console.log(`Solana 20× Radar listening on 0.0.0.0:${PORT} · mode=${state.mode} · database=postgresql/prisma`));
  } catch (error) {
    console.error("Unable to initialize PostgreSQL/Prisma", error);
    process.exitCode = 1;
  }
}

process.on("SIGTERM", async () => {
  await disconnectDb();
  process.exit(0);
});

start();