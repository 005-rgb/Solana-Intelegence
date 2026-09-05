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
  createScanRun,
  finishScanRun,
  disconnectDb
} = require("./db");

const PORT = Number(process.env.PORT || 5000);
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, ".data");
const STATE_FILE = path.join(DATA_DIR, "radar-state.json");
const AUTO_SCAN_MS = 30_000;
const ANALYSIS_MS = 6 * 60 * 60 * 1000;

function token(symbol, name, price, marketCap, liquidity, radar, opportunity, smartMoney, momentum, hype, risk, confidence, priceChange, whaleFlow, holderGrowth, status, age, rationale, riskLabel, dataQuality, potential) {
  const mint = `${symbol.toLowerCase()}${"7".repeat(28)}${symbol.length}`;
  return {
    mint, symbol, name, price, marketCap, liquidity, radar, opportunity, smartMoney, momentum, hype, risk, confidence,
    priceChange, whaleFlow, holderGrowth, status, age, rationale, riskLabel, dataQuality, potential,
    updatedAt: new Date().toISOString(),
    details: {
      holders: Math.round(marketCap / 4100), top10: risk > 60 ? 48.2 : 31.4, volume24h: Math.round(liquidity * 3.8),
      liquidityQuality: Math.max(12, 100 - risk), earlyness: Math.max(20, 100 - radar / 2), patternMatch: Math.min(94, radar - 3),
      consensus: risk < 40 ? "6/7 engines" : "3/7 engines", social: symbol === "NOVA" ? "AVAILABLE" : "INSUFFICIENT DATA",
      authorities: { mint: risk > 55 ? "ACTIVE" : "REVOKED", freeze: risk > 70 ? "ACTIVE" : "REVOKED", metadata: "UNKNOWN" },
      evidence: risk < 40
        ? ["7 tracked wallets accumulated in the last 15m", `Whale net flow ${whaleFlow}`, `Holder growth ${holderGrowth}`, "Liquidity depth remains adequate"]
        : ["Holder concentration above model threshold", "Sell pressure rising in the latest window", "Provider evidence is incomplete"]
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
      lastScanStatus: "NOT RUN YET", avgDuration: "—", tokensPerScan: 0, transactionsPerScan: 0, errors: 0
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
      const base = token(symbol, description, price, marketCap, liquidity, null, null, null, null, null, null, null, priceChange, "UNKNOWN", "UNKNOWN", providerMetadata.cto ? "CTO FLAG" : "PROVIDER", providerAge, "DexScreener live token and pair data; intelligence fields remain UNKNOWN when the provider does not supply them.", "unknown", null, "UNKNOWN");
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
            volume24h: pair.volume?.h24 ?? null
          } : null,
          providerMetadata,
          evidence
        }
      };
    });
    if (!fresh.length) throw new Error("Provider returned no token records");
    return fresh;
  } finally {
    clearTimeout(timeout);
  }
}

async function runScan(manual = false) {
  if (state.scanRunning) return { ok: false, message: "A scan is already running." };
  state.scanRunning = true;
  const started = Date.now();
  const scanRun = await createScanRun({
    manual,
    status: "RUNNING",
    startedAt: new Date(started),
    provider: state.provider
  });
  try {
    state.mode = "live";
    state.provider = "DexScreener";
    state.tokens = await fetchLiveTokens();
    state.system.rpc = "LIVE PROVIDER";
    state.system.market = "LIVE PROVIDER";
    state.whaleActivity = [];
    state.lastScan = new Date().toISOString();
    state.nextScanAt = Date.now() + AUTO_SCAN_MS;
    state.system.lastScanStatus = "SUCCESS";
    state.system.avgDuration = `${Date.now() - started}ms`;
    state.system.tokensPerScan = state.tokens.length;
    state.system.transactionsPerScan = 0;
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
    state.system.lastScanStatus = "FAILED";
    state.system.errors += 1;
    await finishScanRun(scanRun.id, {
      status: "FAILED",
      finishedAt: new Date(),
      durationMs: Date.now() - started,
      tokensScanned: 0,
      transactionsProcessed: 0,
      errorCount: 1
    });
    await saveState();
    return { ok: false, message: "DexScreener provider temporarily unavailable. Data remains unchanged." };
  }
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/state") return send(res, 200, jsonState());
  if (req.method === "GET" && url.pathname.startsWith("/api/tokens/")) {
    const item = tokenById(decodeURIComponent(url.pathname.split("/").pop()));
    return item ? send(res, 200, { token: item, mode: state.mode }) : send(res, 404, { error: "Token not found" });
  }
  if (req.method === "POST" && url.pathname === "/api/scan") return send(res, 200, await runScan(true));
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