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
  createScanRun,
  finishScanRun,
  recordTokenObservations,
  persistPatterns,
  disconnectDb
} = require("./db");
const {
  BASELINE_DECISION_VERSION,
  FILTER_CONFIG,
  MAX_TOP_HOLDER_PERCENT,
  MIN_LIQUIDITY_USD,
  dedupeMintEntries,
  evaluateBaselineCandidate,
  selectBoardTokens,
  selectPrimaryPair,
  summarizeBaselineCandidates
} = require("./radar-core");

const PORT = Number(process.env.PORT || 5000);
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, ".data");
const STATE_FILE = path.join(DATA_DIR, "radar-state.json");
const AUTO_SCAN_MS = 15_000;
const LIVE_SCAN_TIMEOUT_MS = 20_000;
const ANALYSIS_MS = 6 * 60 * 60 * 1000;
let lastFilterReport = {
  checked: 0, accepted: 0, rejected: 0, unresolved: 0, reasons: [],
  providerRecords: 0, pairRequests: 0, pairFailures: 0, providerAgeMs: null,
  rpcStatus: "NOT RUN", rpcFreshnessMs: null, rpcCommitment: "confirmed",
  qualityStatus: "NOT RUN", filterConfig: FILTER_CONFIG, tokensPersisted: 0,
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

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "Content-Type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(payload);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => { body += chunk; if (body.length > 100_000) reject(new Error("Payload too large")); });
    req.on("end", () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error("Invalid JSON")); } });
    req.on("error", reject);
  });
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

const SOLANA_RPC_URLS = process.env.SOLANA_RPC_URL
  ? [process.env.SOLANA_RPC_URL]
  : ["https://solana-rpc.publicnode.com", "https://api.mainnet-beta.solana.com"];
let rpcInFlight = 0;
const rpcWaiters = [];

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
    for (const endpoint of SOLANA_RPC_URLS) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        try {
          const response = await fetch(endpoint, {
            method: "POST",
            signal: controller.signal,
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params })
          });
          if (response.status === 429) {
            lastError = new Error(`Solana RPC HTTP 429 at ${new URL(endpoint).hostname}`);
            await new Promise(resolve => setTimeout(resolve, 700 * (attempt + 1)));
            continue;
          }
          if (!response.ok) throw new Error(`Solana RPC HTTP ${response.status}`);
          const payload = await response.json();
          if (payload.error) throw new Error(payload.error.message || "Solana RPC request failed");
          return payload.result;
        } catch (error) {
          lastError = error;
          if (attempt === 2) break;
          await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1)));
        } finally {
          clearTimeout(timeout);
        }
      }
    }
    throw lastError || new Error("No Solana RPC endpoint responded");
  } finally {
    releaseRpcSlot();
  }
}

async function solanaRpcBatch(requests) {
  await acquireRpcSlot();
  try {
    let lastError;
    for (const endpoint of SOLANA_RPC_URLS) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5_000);
        try {
          const response = await fetch(endpoint, {
            method: "POST",
            signal: controller.signal,
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify(requests)
          });
          if (response.status === 429) {
            lastError = new Error(`Solana RPC HTTP 429 at ${new URL(endpoint).hostname}`);
            break;
          }
          if (!response.ok) throw new Error(`Solana RPC HTTP ${response.status}`);
          const payload = await response.json();
          if (!Array.isArray(payload)) throw new Error("Solana RPC batch response was invalid");
          return payload;
        } catch (error) {
          lastError = error;
          if (attempt === 2) break;
          await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1)));
        } finally {
          clearTimeout(timeout);
        }
      }
    }
    throw lastError || new Error("No Solana RPC endpoint responded");
  } finally {
    releaseRpcSlot();
  }
}

function unverifiedSecurity(message) {
  return {
    verified: false,
    status: "UNVERIFIED",
    reasons: [`Security verification failed: ${message}`],
    authorities: { mint: "UNKNOWN", freeze: "UNKNOWN", metadata: "UNKNOWN" },
    holders: null,
    topHolderPercent: null,
    topHolders: [],
    supply: null
  };
}

function securityFromRpcResults(accountResponse, supplyResponse, largestResponse) {
  const rpcError = [accountResponse, supplyResponse, largestResponse].find(item => item?.error);
  if (rpcError) return unverifiedSecurity(rpcError.error.message || "Solana RPC request failed");
  try {
    const account = accountResponse?.result;
    const supply = supplyResponse?.result;
    const largest = largestResponse?.result;
    const info = account?.value?.data?.parsed?.info;
    const mintAuthorityRenounced = Boolean(info) && info.mintAuthority == null;
    const freezeAuthorityRenounced = Boolean(info) && info.freezeAuthority == null;
    const supplyRaw = BigInt(supply?.value?.amount || "0");
    const largestRaw = BigInt(largest?.value?.[0]?.amount || "0");
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
      topHolders,
      supply: supply?.value?.uiAmountString || null
    };
  } catch (error) {
    return unverifiedSecurity(error.message);
  }
}

async function verifyTokensSecurity(mints) {
  const requests = mints.flatMap((mint, index) => [
    { jsonrpc: "2.0", id: `${index}:account`, method: "getAccountInfo", params: [mint, { encoding: "jsonParsed", commitment: "confirmed" }] },
    { jsonrpc: "2.0", id: `${index}:supply`, method: "getTokenSupply", params: [mint, { commitment: "confirmed" }] },
    { jsonrpc: "2.0", id: `${index}:largest`, method: "getTokenLargestAccounts", params: [mint, { commitment: "confirmed" }] }
  ]);
  try {
    const responses = await solanaRpcBatch(requests);
    const byId = new Map(responses.map(response => [String(response.id), response]));
    return mints.map((_, index) => securityFromRpcResults(
      byId.get(`${index}:account`),
      byId.get(`${index}:supply`),
      byId.get(`${index}:largest`)
    ));
  } catch (error) {
    return mints.map(() => unverifiedSecurity(error.message));
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
  state.alerts = [...alerts, ...(state.alerts || [])].slice(0, 20);
  await Promise.all(alerts.map(alert => recordAlert(alert).catch(error => console.error("Potential-token alert persistence failed", error.message))));
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

function observationData(item, endpoint, sourceRequestId, observedAt) {
  const pair = item.details?.pair || {};
  const providerMetadata = item.details?.providerMetadata || {};
  const decision = evaluateBaselineCandidate(item);
  const rawPayload = { providerMetadata, pair };
  return {
    mint: item.mint,
    pairAddress: pair.address || null,
    chainId: providerMetadata.chainId || "solana",
    dexId: pair.dexId || null,
    baseToken: pair.baseToken || {},
    quoteToken: pair.quoteToken || {},
    observedAt,
    providerUpdatedAt: providerMetadata.providerUpdatedAt || null,
    pairCreatedAt: pair.pairCreatedAt || null,
    priceUsd: Number.isFinite(Number(pair.priceUsd)) ? Number(pair.priceUsd) : null,
    marketCap: Number.isFinite(Number(pair.marketCap)) ? Number(pair.marketCap) : null,
    fdv: Number.isFinite(Number(pair.fdv)) ? Number(pair.fdv) : null,
    liquidityUsd: Number.isFinite(Number(pair.liquidityUsd)) ? Number(pair.liquidityUsd) : null,
    volume: pair.volume || {},
    transactions: pair.txns || {},
    makers: pair.makers || {},
    priceChange: pair.priceChange || {},
    boostAmount: Number.isFinite(Number(providerMetadata.boostAmount)) ? Number(providerMetadata.boostAmount) : null,
    ctoFlag: typeof providerMetadata.cto === "boolean" ? providerMetadata.cto : null,
    source: "DexScreener",
    sourceEndpoint: endpoint,
    sourceRequestId,
    sourceResponseHash: crypto.createHash("sha256").update(JSON.stringify(rawPayload)).digest("hex"),
    freshnessMs: Number.isFinite(Date.parse(providerMetadata.providerUpdatedAt || ""))
      ? Math.max(0, Date.now() - Date.parse(providerMetadata.providerUpdatedAt))
      : null,
    dataQuality: pair.address ? "PARTIAL_SECURITY_SEPARATE" : "MISSING_PAIR",
    qualityReasons: decision.reasonCodes,
    rawPayload
  };
}

async function fetchLiveTokens({ correlationId } = {}) {
  const endpoint = process.env.DEXSCREENER_API_URL || "https://api.dexscreener.com/token-boosts/latest/v1";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  const observedAt = new Date().toISOString();
  const sourceRequestId = correlationId || crypto.randomUUID();
  let pairRequests = 0;
  let pairFailures = 0;
  try {
    const response = await fetch(endpoint, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`Provider HTTP ${response.status}`);
    const payload = await response.json();
    const entries = Array.isArray(payload) ? payload.filter(item => item && item.chainId === "solana") : [];
    const boostedEntries = dedupeMintEntries(entries, 10);
    pairRequests = boostedEntries.length;
    const pairResponses = await Promise.all(boostedEntries.map(async item => {
      const mint = item.tokenAddress;
      try {
        const pairResponse = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`, {
          signal: controller.signal,
          headers: { Accept: "application/json" }
        });
        if (!pairResponse.ok) {
          pairFailures += 1;
          return { pairs: [] };
        }
        return await pairResponse.json();
      } catch {
        pairFailures += 1;
        return { pairs: [] };
      }
    }));
    const allPairs = pairResponses.flatMap(result => Array.isArray(result?.pairs) ? result.pairs.filter(pair => pair?.chainId === "solana") : []);
    const fresh = boostedEntries.map((item, index) => {
      const mint = item.tokenAddress || `live-${index}`;
      const pairs = Array.isArray(pairResponses[index]?.pairs)
        ? pairResponses[index].pairs.filter(pair => pair && pair.chainId === "solana")
        : [];
      const pair = selectPrimaryPair(pairs);
      const shortMint = mint.slice(0, 4).toUpperCase();
      const baseToken = pair?.baseToken || {};
      const pairInfo = pair?.info || {};
      const symbol = baseToken.symbol || item.symbol || `SOL-${shortMint}`;
      const name = baseToken.name || item.name || String(item.description || "").split(/\r?\n/).map(line => line.trim()).find(Boolean) || `Solana token ${shortMint}`;
      const description = item.description || pairInfo.description || null;
      const links = providerLinks(item.links, pairInfo.websites, pairInfo.socials);
      const websites = providerLinks(item.links, pairInfo.websites).filter(link => !["twitter", "telegram", "discord"].includes(link.type));
      const socials = providerLinks(item.links, pairInfo.socials).filter(link => !websites.some(site => site.url === link.url));
      const imageUrl = /^https?:\/\//i.test(String(item.icon || "")) ? item.icon : pairInfo.imageUrl || null;
      const headerUrl = /^https?:\/\//i.test(String(item.header || "")) ? item.header : pairInfo.header || null;
      const providerMetadata = {
        chainId: item.chainId, symbol, name, icon: imageUrl, header: headerUrl,
        openGraph: item.openGraph || null, description, links, websites, socials, pairInfo,
        cto: typeof item.cto === "boolean" ? item.cto : null,
        boostAmount: item.amount ?? null, totalBoostAmount: item.totalAmount ?? null,
        providerUpdatedAt: item.updatedAt || null
      };
      const evidence = [
        "DexScreener supplied live token-boost metadata and pair data when available; missing market metrics remain UNKNOWN.",
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
        providerUrl: pair?.url || item.url || `https://dexscreener.com/solana/${mint}`,
        details: {
          ...base.details, source: endpoint, coverage: "DEXSCREENER_TOKEN_BOOST_METADATA",
          pair: pair ? {
            address: pair.pairAddress || null, dexId: pair.dexId || null, url: pair.url || null,
            baseToken: pair.baseToken || null, quoteToken: pair.quoteToken || null,
            pairCreatedAt: pair.pairCreatedAt || null, labels: Array.isArray(pair.labels) ? pair.labels : [],
            priceUsd: pair.priceUsd ?? null, fdv: pair.fdv ?? null, marketCap: pair.marketCap ?? null,
            liquidityUsd: pair.liquidity?.usd ?? null, volume: pair.volume || {},
            priceChange: pair.priceChange || {}, txns: pair.txns || {}, makers: pair.makers || {},
            info: pair.info || null, pairCountForMint: pairs.length
          } : null,
          providerMetadata,
          profile: { description, imageUrl, headerUrl, websites, socials, openGraph: item.openGraph || null },
          evidence
        }
      };
    });
    const rpcStartedAt = Date.now();
    const securityResults = await verifyTokensSecurity(fresh.map(item => item.mint));
    const rpcFreshnessMs = Date.now() - rpcStartedAt;
    const secured = fresh.map((item, index) => ({
      ...item,
      security: securityResults[index],
      details: { ...item.details, security: securityResults[index] }
    }));
    const decisions = secured.map(evaluateBaselineCandidate);
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
      const updatedAt = Date.parse(item.details?.providerMetadata?.providerUpdatedAt || "");
      return Number.isFinite(updatedAt) ? Math.max(maxAge, Math.max(0, Date.now() - updatedAt)) : maxAge;
    }, 0) || null;
    const rpcStatuses = securityResults.map(result => result.status);
    const rpcStatus = rpcStatuses.length && rpcStatuses.every(status => status !== "UNVERIFIED")
      ? "LIVE"
      : rpcStatuses.some(status => status !== "UNVERIFIED") ? "PARTIAL" : "FAILED";
    const report = summarizeBaselineCandidates(secured, {
      checked: secured.length,
      providerRecords: entries.length,
      discoveryUniverseSize: boostedEntries.length,
      providerRecordsWithPair: fresh.filter(item => item.details?.pair).length,
      providerRecordsWithPrice: fresh.filter(item => item.price !== "UNKNOWN").length,
      providerRecordsWithLiquidity: fresh.filter(item => item.liquidity != null).length,
      pairRequests, pairFailures, providerAgeMs, rpcFreshnessMs,
      rpcStatus, rpcCommitment: "confirmed",
      qualityStatus: pairFailures > 0 ? "PARTIAL" : "FULL",
      filterConfig: FILTER_CONFIG,
      sourceMetrics: {
        boost_feed_seen: entries.length,
        unique_mints_before_dedup: new Set(entries.map(item => item.tokenAddress).filter(Boolean)).size,
        unique_pairs_before_dedup: new Set(allPairs.map(pair => pair.pairAddress).filter(Boolean)).size,
        unique_mints_after_dedup: boostedEntries.length,
        source_overlap: {},
        source_only_candidates: { boost_feed: boostedEntries.length }
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
      observations: secured.map(item => observationData(item, endpoint, sourceRequestId, observedAt)),
      report: lastFilterReport
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function runScan(manual = false) {
  if (state.scanRunning) return { ok: false, message: "A scan is already running." };
  state.scanRunning = true;
  const started = Date.now();
  const correlationId = crypto.randomUUID();
  let scanRun = null;
  let scanResult = null;
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
    filterConfig: lastFilterReport.filterConfig || FILTER_CONFIG,
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
    decisionVersion: BASELINE_DECISION_VERSION,
    correlationId,
    sourceMetrics: lastFilterReport.sourceMetrics || {}
  });
  try {
    scanRun = await Promise.race([
      createScanRun({
        manual,
        status: "RUNNING",
        startedAt: new Date(started),
        provider: state.provider,
        decisionVersion: BASELINE_DECISION_VERSION,
        correlationId,
        ...scanAudit()
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Scan run could not be registered in the database.")), 8000))
    ]);
    state.mode = "live";
    state.provider = "DexScreener";
    const previousTokens = state.tokens;
    scanResult = await Promise.race([
      fetchLiveTokens({ correlationId }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("LIVE scan timed out before provider verification completed.")), LIVE_SCAN_TIMEOUT_MS))
    ]);
    lastFilterReport = scanResult.report;
    if (scanRun?.id) await recordTokenObservations(scanResult.observations, scanRun.id);
    const hasAcceptedTokens = scanResult.tokens.length > 0;
    state.tokens = selectBoardTokens(state.tokens, scanResult.tokens);
    lastFilterReport.tokensPersisted = hasAcceptedTokens ? scanResult.tokens.length : 0;
    if (!hasAcceptedTokens) throw new Error("No token passed the LIVE security and upward-evidence filters.");
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
      tokensScanned: state.tokens.length,
      transactionsProcessed: 0,
      errorCount: 0,
      ...scanAudit()
    });
    appendScanRunToState(scanRun, "SUCCESS", scanAudit(), {
      finishedAt: finishedAt.toISOString(),
      durationMs,
      tokensScanned: state.tokens.length,
      transactionsProcessed: 0,
      errorCount: 0
    });
    state.patterns = derivePatterns(state.tokens, state.scanRuns);
    await persistPatterns(state.patterns);
    await saveState();
    return { ok: true, manual, duration: Date.now() - started, tokens: state.tokens.length };
  } catch (error) {
    state.scanRunning = false;
    const filtered = error.message === "No token passed the LIVE security and upward-evidence filters.";
    const timedOut = /timed out|timeout|aborted/i.test(error.message);
    if (!scanResult) {
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
    state.system.lastScanStatus = filtered ? "FILTERED · 0 SAFE TOKENS" : "FAILED";
    state.system.tokensPerScan = 0;
    state.system.securityFilter = lastFilterReport;
    state.system.lastScanError = error.message;
    state.system.lastScanQuality = filtered ? lastFilterReport.qualityStatus : "FAILED";
    if (scanRun?.id) state.system.lastScanRunId = scanRun.id;
    if (!filtered) state.system.errors += 1;
    if (scanRun) {
      const finishedAt = new Date();
      const durationMs = Date.now() - started;
      const status = filtered ? "FILTERED" : "FAILED";
      const audit = scanAudit();
      await finishScanRun(scanRun.id, {
        status,
        finishedAt,
        durationMs,
        tokensScanned: 0,
        transactionsProcessed: 0,
        errorCount: filtered ? 0 : 1,
        timedOut,
        timeoutReason: timedOut ? error.message : null,
        tokensPersisted: 0,
        ...audit
      });
      appendScanRunToState(scanRun, status, audit, {
        finishedAt: finishedAt.toISOString(),
        durationMs,
        tokensScanned: 0,
        transactionsProcessed: 0,
        errorCount: filtered ? 0 : 1
      });
    }
    await saveState();
    return { ok: false, message: filtered ? "No token passed the active security filters. No token was added to Radar." : "DexScreener provider temporarily unavailable. Data remains unchanged.", securityFilter: lastFilterReport };
  }
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/state") return send(res, 200, jsonState());
  if (req.method === "GET" && url.pathname.startsWith("/api/tokens/")) {
    const item = tokenById(decodeURIComponent(url.pathname.split("/").pop()));
    return item ? send(res, 200, { token: item, mode: state.mode }) : send(res, 404, { error: "Token not found" });
  }
  if (req.method === "POST" && url.pathname === "/api/scan") return send(res, 200, await runScan(true));
  if (req.method === "POST" && url.pathname === "/api/analysis") {
    state.patterns = derivePatterns(state.tokens, state.scanRuns);
    await persistPatterns(state.patterns);
    await saveState();
    return send(res, 200, { ok: true, patterns: state.patterns.length, state: jsonState() });
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/watchlist/")) {
    const id = decodeURIComponent(url.pathname.split("/").pop());
    const item = tokenById(id);
    if (!item) return send(res, 404, { error: "Token not found" });
    if (!state.watchlist.includes(item.mint)) state.watchlist.push(item.mint);
    state.watchlistHistory.push({ mint: item.mint, action: "ADDED", at: new Date().toISOString() });
    await saveState();
    await recordWatchlistEvent(item.mint, "ADDED");
    return send(res, 200, { ok: true, watchlist: state.watchlist });
  }
  if (req.method === "DELETE" && url.pathname.startsWith("/api/watchlist/")) {
    const id = decodeURIComponent(url.pathname.split("/").pop());
    const item = tokenById(id);
    if (item) {
      state.watchlist = state.watchlist.filter(mint => mint !== item.mint);
      state.watchlistHistory.push({ mint: item.mint, action: "REMOVED_FROM_ACTIVE_VIEW", at: new Date().toISOString() });
      await saveState();
      await recordWatchlistEvent(item.mint, "REMOVED_FROM_ACTIVE_VIEW");
    }
    return send(res, 200, { ok: true, watchlist: state.watchlist });
  }
  if (req.method === "POST" && url.pathname === "/api/trades") {
    try {
      const body = await readBody(req);
      const item = tokenById(body.mint);
      if (!item) return send(res, 404, { error: "Token not found" });
      const price = parseFloat(String(item.price).replace("$", ""));
      if (!Number.isFinite(price)) return send(res, 422, { error: "Current price is unavailable; paper trade cannot be simulated." });
      let tradeRecord;
      if (body.side === "BUY") {
        const amount = 100;
        if (state.portfolio.cash < amount) return send(res, 422, { error: "Insufficient virtual cash." });
        if (state.portfolio.positions.some(position => position.mint === item.mint)) return send(res, 409, { error: "An open virtual position already exists for this token." });
        const fee = amount * 0.003;
        const position = { mint: item.mint, symbol: item.symbol, name: item.name, invested: amount, quantity: (amount - fee) / price, entry: price, peakPnl: 0, openedAt: Date.now() };
        state.portfolio.cash -= amount;
        state.portfolio.fees += fee;
        state.portfolio.trades += 1;
        state.portfolio.positions.push(position);
        state.portfolio.history.unshift({ symbol: item.symbol, side: "BUY", amount, price, fee, score: item.radar, time: Date.now() });
        tradeRecord = { mint: item.mint, symbol: item.symbol, side: "BUY", amount, price, fee, score: item.radar, time: Date.now() };
      } else if (body.side === "SELL") {
        const position = state.portfolio.positions.find(p => p.mint === item.mint);
        if (!position) return send(res, 422, { error: "No open paper position for this token." });
        const value = position.quantity * price;
        const fee = value * 0.003;
        state.portfolio.cash += value - fee;
        state.portfolio.realized += value - fee - position.invested;
        state.portfolio.fees += fee;
        state.portfolio.history.unshift({ symbol: item.symbol, side: "SELL", amount: value, price, fee, score: item.radar, time: Date.now() });
        state.portfolio.positions = state.portfolio.positions.filter(p => p !== position);
        tradeRecord = { mint: item.mint, symbol: item.symbol, side: "SELL", amount: value, price, fee, score: item.radar, time: Date.now() };
      } else return send(res, 400, { error: "Unsupported trade side." });
      await saveState();
      await recordTrade(tradeRecord);
      return send(res, 200, { ok: true, state: jsonState() });
    } catch (error) { return send(res, 400, { error: error.message }); }
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
    res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(content);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/")) return handleApi(req, res, url).catch(error => send(res, 500, { error: error.message }));
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