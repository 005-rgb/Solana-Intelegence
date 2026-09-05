const http = require("http");
const fs = require("fs");
const path = require("path");
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
  persistPatterns,
  disconnectDb
} = require("./db");

const PORT = Number(process.env.PORT || 5000);
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, ".data");
const STATE_FILE = path.join(DATA_DIR, "radar-state.json");
const AUTO_SCAN_MS = 30_000;
const LIVE_SCAN_TIMEOUT_MS = 20_000;
const ANALYSIS_MS = 6 * 60 * 60 * 1000;
let lastFilterReport = { checked: 0, accepted: 0, rejected: 0, reasons: [] };

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
      scheduler: "RUNNING · 30s", worker: "READY", database: "POSTGRESQL / PRISMA", rpc: "LIVE PROVIDER", market: "LIVE PROVIDER",
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
function tokenById(id) {
  return state.tokens.find(item => item.mint === id || item.symbol.toLowerCase() === String(id).toLowerCase());
}

const SOLANA_RPC_URLS = process.env.SOLANA_RPC_URL
  ? [process.env.SOLANA_RPC_URL]
  : ["https://solana-rpc.publicnode.com", "https://api.mainnet-beta.solana.com"];
const MAX_TOP_HOLDER_PERCENT = 80;
const MIN_LIQUIDITY_USD = 10_000;
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

async function fetchLiveTokens() {
  const endpoint = process.env.DEXSCREENER_API_URL || "https://api.dexscreener.com/token-boosts/latest/v1";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(endpoint, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`Provider HTTP ${response.status}`);
    const payload = await response.json();
    const entries = Array.isArray(payload) ? payload.filter(item => item && item.chainId === "solana") : [];
    const boostedEntries = [];
    const seenMints = new Set();
    for (const item of entries) {
      if (!item.tokenAddress || seenMints.has(item.tokenAddress)) continue;
      seenMints.add(item.tokenAddress);
      boostedEntries.push(item);
      if (boostedEntries.length === 10) break;
    }
    const pairResponses = await Promise.all(boostedEntries.map(async item => {
      const mint = item.tokenAddress;
      if (!mint) return { pairs: [] };
      try {
        const pairResponse = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`, {
          signal: controller.signal,
          headers: { Accept: "application/json" }
        });
        if (!pairResponse.ok) return { pairs: [] };
        return await pairResponse.json();
      } catch {
        return { pairs: [] };
      }
    }));
    const fresh = boostedEntries.map((item, index) => {
      const mint = item.tokenAddress || `live-${index}`;
      const pairs = Array.isArray(pairResponses[index]?.pairs)
        ? pairResponses[index].pairs.filter(pair => pair && pair.chainId === "solana")
        : [];
      const pair = pairs.sort((left, right) => Number(right.liquidity?.usd || 0) - Number(left.liquidity?.usd || 0))[0] || null;
      const shortMint = mint.slice(0, 4).toUpperCase();
      const symbol = `SOL-${shortMint}`;
      const description = String(item.description || "").split(/\r?\n/).map(line => line.trim()).find(Boolean) || `Solana token ${shortMint}`;
      const links = Array.isArray(item.links) ? item.links.filter(link => link && typeof link.url === "string").map(link => ({ label: link.label || link.type || "Link", type: link.type || null, url: link.url })) : [];
      const providerMetadata = {
        chainId: item.chainId,
        icon: item.icon || null,
        header: item.header || null,
        openGraph: item.openGraph || null,
        description: item.description || null,
        links,
        cto: typeof item.cto === "boolean" ? item.cto : null,
        boostAmount: item.amount ?? null,
        totalBoostAmount: item.totalAmount ?? null,
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
      const base = token(symbol, description, price, marketCap, liquidity, null, null, null, null, null, null, null, priceChange, "UNKNOWN", "UNKNOWN", providerMetadata.cto ? "CTO FLAG" : "PROVIDER", providerAge, "Pending independent Solana security verification.", "unknown", null, "UNKNOWN");
      return {
        ...base,
        mint,
        symbol,
        name: description,
        providerUrl: pair?.url || item.url || `https://dexscreener.com/solana/${mint}`,
        details: {
          ...base.details,
          source: endpoint,
          coverage: "DEXSCREENER_TOKEN_BOOST_METADATA",
          pair: pair ? {
            address: pair.pairAddress || null,
            dexId: pair.dexId || null,
            url: pair.url || null,
            baseToken: pair.baseToken || null,
            quoteToken: pair.quoteToken || null,
            volume24h: pair.volume?.h24 ?? null,
            liquidityUsd: pair.liquidity?.usd ?? null
          } : null,
          providerMetadata,
          evidence
        }
      };
    });
    const securityResults = await verifyTokensSecurity(fresh.map(item => item.mint));
    const secured = fresh.map((item, index) => ({ ...item, security: securityResults[index] }));
    const safeTokens = secured
      .filter(item => {
        const change = Number(String(item.priceChange || "").replace("%", ""));
        return item.security.verified &&
          item.price !== "UNKNOWN" &&
          Number(item.liquidity) >= MIN_LIQUIDITY_USD &&
          Number.isFinite(change) &&
          change > 0 &&
          item.details.providerMetadata.cto !== true;
      })
      .map(item => {
        const rationale = buildTokenReview(item, item.security);
        return {
          ...item,
          rationale,
          potential: "UPWARD BIAS",
          details: {
            ...item.details,
            holders: item.security.holders,
            holderConcentration: item.security.topHolderPercent,
            authorities: item.security.authorities,
            security: item.security,
            evidence: [...item.details.evidence, ...item.security.reasons, rationale]
          }
        };
      });
    const reasonCounts = new Map();
    for (const item of secured) {
      const reasons = [];
      if (!item.security.verified) reasons.push(...item.security.reasons);
      if (item.price === "UNKNOWN") reasons.push("Provider price is unavailable.");
      if (Number(item.liquidity) < MIN_LIQUIDITY_USD) reasons.push(`Liquidity is below $${MIN_LIQUIDITY_USD.toLocaleString("en-US")}.`);
      const change = Number(String(item.priceChange || "").replace("%", ""));
      if (!Number.isFinite(change) || change <= 0) reasons.push("Provider 24h change is not positive.");
      if (item.details.providerMetadata.cto === true) reasons.push("Provider marked the token as CTO.");
      for (const reason of new Set(reasons)) reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
    }
    lastFilterReport = {
      checked: secured.length,
      accepted: safeTokens.length,
      rejected: secured.length - safeTokens.length,
      reasons: [...reasonCounts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 6).map(([reason, count]) => ({ reason, count })),
      rules: {
        mintAuthority: "RENOUNCED",
        freezeAuthority: "RENOUNCED",
        largestHolderMaximum: `${MAX_TOP_HOLDER_PERCENT}%`,
        minimumLiquidityUsd: MIN_LIQUIDITY_USD,
        positive24hChange: true,
        ctoFlag: false
      }
    };
    if (!safeTokens.length) throw new Error("No token passed the LIVE security and upward-evidence filters.");
    return safeTokens;
  } finally {
    clearTimeout(timeout);
  }
}

async function runScan(manual = false) {
  if (state.scanRunning) return { ok: false, message: "A scan is already running." };
  state.scanRunning = true;
  const started = Date.now();
  let scanRun = null;
  try {
    scanRun = await Promise.race([
      createScanRun({
        manual,
        status: "RUNNING",
        startedAt: new Date(started),
        provider: state.provider
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Scan run could not be registered in the database.")), 8000))
    ]);
    state.mode = "live";
    state.provider = "DexScreener";
    const previousTokens = state.tokens;
    state.tokens = await Promise.race([
      fetchLiveTokens(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("LIVE scan timed out before provider verification completed.")), LIVE_SCAN_TIMEOUT_MS))
    ]);
    await publishPotentialAlerts(previousTokens, state.tokens);
    state.patterns = derivePatterns(state.tokens, state.scanRuns);
    await persistPatterns(state.patterns);
    state.system.rpc = "LIVE PROVIDER";
    state.system.market = "LIVE PROVIDER";
    state.whaleActivity = [];
    state.lastScan = new Date().toISOString();
    state.nextScanAt = Date.now() + AUTO_SCAN_MS;
    state.system.lastScanStatus = "SUCCESS";
    state.system.avgDuration = `${Date.now() - started}ms`;
    state.system.tokensPerScan = state.tokens.length;
    state.system.transactionsPerScan = 0;
    state.system.securityFilter = lastFilterReport;
    delete state.system.lastScanError;
    state.scanRunning = false;
    await finishScanRun(scanRun.id, {
      status: "SUCCESS",
      finishedAt: new Date(),
      durationMs: Date.now() - started,
      tokensScanned: state.tokens.length,
      transactionsProcessed: 0,
      errorCount: 0
    });
    await saveState();
    return { ok: true, manual, duration: Date.now() - started, tokens: state.tokens.length };
  } catch (error) {
    state.scanRunning = false;
    const filtered = error.message === "No token passed the LIVE security and upward-evidence filters.";
    state.nextScanAt = Date.now() + AUTO_SCAN_MS;
    state.system.lastScanStatus = filtered ? "FILTERED · 0 SAFE TOKENS" : "FAILED";
    state.system.tokensPerScan = 0;
    state.system.securityFilter = lastFilterReport;
    state.system.lastScanError = error.message;
    if (!filtered) state.system.errors += 1;
    if (scanRun) await finishScanRun(scanRun.id, {
        status: filtered ? "FILTERED" : "FAILED",
        finishedAt: new Date(),
        durationMs: Date.now() - started,
        tokensScanned: 0,
        transactionsProcessed: 0,
        errorCount: filtered ? 0 : 1
      });
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
    state.system.scheduler = "RUNNING · 30s";
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