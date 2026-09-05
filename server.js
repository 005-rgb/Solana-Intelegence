const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const {
  readState,
  persistState,
  recordTrade,
  recordWatchlistEvent,
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

const DEMO_TOKENS = [
  token("NOVA", "Nova Protocol", "$0.0842", 8420000, 1184000, 94, 91, 89, 86, 78, 21, 88, "+18.42%", "+$312.4K", "+12.8%", "ACCUMULATING", "2h 14m", "Early whale accumulation and organic holder growth.", "low", 92, "5×"),
  token("DRIFT", "Driftwood", "$0.0128", 1280000, 426000, 88, 86, 82, 91, 94, 38, 71, "+42.18%", "+$184.1K", "+28.4%", "BREAKOUT", "41m", "Volume and holder velocity accelerating across multiple windows.", "moderate", 82, "10×"),
  token("KITE", "Kite Finance", "$0.2910", 29100000, 3840000, 84, 79, 88, 77, 72, 29, 90, "+9.08%", "+$96.7K", "+6.1%", "ACTIVE", "3h 06m", "High-quality smart money history with improving liquidity.", "low", 87, "2×"),
  token("ORBIT", "Orbit Cats", "$0.00391", 391000, 118000, 76, 81, 69, 88, 83, 57, 64, "+71.32%", "+$58.2K", "+44.7%", "HYPED", "18m", "Social velocity is high, but activity coverage is incomplete.", "high", 64, "5×"),
  token("MESA", "Mesa Markets", "$0.0467", 4670000, 910000, 73, 76, 75, 68, 61, 34, 85, "+4.21%", "+$42.8K", "+3.7%", "COOLING", "5h 48m", "Strong distribution quality; momentum has cooled from its peak.", "moderate", 90, "2×"),
  token("VOLT", "Volt Labs", "$0.00174", 174000, 31000, 61, 54, 42, 73, 67, 79, 49, "-12.64%", "-$8.7K", "-2.3%", "DISTRIBUTING", "9m", "Liquidity and whale flow are deteriorating; monitor for pre-rug signals.", "very-high", 58, "—")
];

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
    mode: process.env.RADAR_MODE === "live" ? "live" : "demo",
    provider: process.env.RADAR_MODE === "live" ? "DexScreener" : "Controlled Demo Dataset",
    lastScan: null,
    nextScanAt: Date.now() + AUTO_SCAN_MS,
    scanRunning: false,
    tokens: DEMO_TOKENS,
    watchlist: [DEMO_TOKENS[0].mint, DEMO_TOKENS[2].mint],
    watchlistHistory: [],
    alerts: [
      { type: "SIGNAL ACCELERATION", token: "NOVA", text: "Radar score moved 82 → 94 across 4 observations.", tone: "green", time: "12m ago" },
      { type: "LIQUIDITY DROP", token: "VOLT", text: "Liquidity decreased 18.4% in the latest window.", tone: "red", time: "26m ago" },
      { type: "WHALE ACCUMULATION", token: "DRIFT", text: "5 tracked wallets added exposure during breakout.", tone: "blue", time: "41m ago" },
      { type: "PRE-RUG WATCH", token: "ORBIT", text: "High hype with low organic activity. Evidence is incomplete.", tone: "yellow", time: "1h ago" }
    ],
    patterns: [
      { id: "ACCUM-014", name: "Organic accumulation", desc: "Whale inflow + holder expansion + rising liquidity", match: 87, sample: 143, outcome: "2× 63% · 5× 31% · 10× 12%", tone: "green" },
      { id: "RUG-024", name: "Pre-rug concentration", desc: "Insider concentration rising while LP contracts", match: 72, sample: 38, outcome: "Failure rate 68%", tone: "red" },
      { id: "HYPE-009", name: "False hype", desc: "Social velocity + bot probability + low holder quality", match: 61, sample: 96, outcome: "Failure rate 54%", tone: "yellow" }
    ],
    portfolio: {
      starting: 100000, cash: 98600, realized: 0, fees: 0, trades: 14, positions: [
        { mint: DEMO_TOKENS[0].mint, symbol: "NOVA", name: "Nova Protocol", invested: 100, quantity: 1187.65, entry: 0.0842, peakPnl: 34.2, openedAt: Date.now() - 1000 * 60 * 90 },
        { mint: DEMO_TOKENS[2].mint, symbol: "KITE", name: "Kite Finance", invested: 100, quantity: 343.64, entry: 0.291, peakPnl: 8.7, openedAt: Date.now() - 1000 * 60 * 240 },
        { mint: DEMO_TOKENS[4].mint, symbol: "MESA", name: "Mesa Markets", invested: 100, quantity: 2141.33, entry: 0.0467, peakPnl: 5.4, openedAt: Date.now() - 1000 * 60 * 360 }
      ],
      history: [
        { symbol: "NOVA", side: "BUY", amount: 100, price: 0.0842, score: 94, time: Date.now() - 1000 * 60 * 90 },
        { symbol: "KITE", side: "BUY", amount: 100, price: 0.291, score: 84, time: Date.now() - 1000 * 60 * 240 },
        { symbol: "MESA", side: "BUY", amount: 100, price: 0.0467, score: 73, time: Date.now() - 1000 * 60 * 360 }
      ]
    },
    system: {
      scheduler: "RUNNING", worker: "READY", database: "LOCAL PERSISTENCE", rpc: "DEMO PROVIDER", market: "DEMO PROVIDER",
      lastScanStatus: "NOT RUN YET", avgDuration: "—", tokensPerScan: 0, transactionsPerScan: 0, errors: 0
    }
  };
}

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return { ...freshState(), ...parsed, portfolio: { ...freshState().portfolio, ...(parsed.portfolio || {}) }, system: { ...freshState().system, ...(parsed.system || {}) } };
  } catch {
    return freshState();
  }
}
let state = loadState();

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
    const price = current ? parseFloat(current.price.replace("$", "")) : position.entry;
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
    const entries = Array.isArray(payload) ? payload : [];
    const fresh = entries.slice(0, 10).map((item, index) => ({
      ...token(`LIVE${index + 1}`, item.description || "Live Solana token", item.amount ? `$${Number(item.amount).toFixed(6)}` : "UNKNOWN", null, null, null, null, null, null, null, null, null, "UNKNOWN", "UNKNOWN", "UNKNOWN", "UNKNOWN", "UNKNOWN", "Live provider record; deeper intelligence requires indexed market data.", "unknown", null, "UNKNOWN",
      ),
      mint: item.tokenAddress || `live-${index}`,
      symbol: (item.symbol || item.description || "TOKEN").slice(0, 10).toUpperCase(),
      name: item.description || "Unnamed token",
      providerUrl: item.url || null,
      details: { ...token("X", "x", "UNKNOWN", 0, 0, 0, 0, 0, 0, 0, 0, 0, "UNKNOWN", "UNKNOWN", "UNKNOWN", "UNKNOWN", "UNKNOWN", "UNKNOWN", "unknown", 0, "UNKNOWN").details, source: endpoint }
    }));
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
    if (state.mode === "live") {
      state.tokens = await fetchLiveTokens();
      state.provider = "DexScreener";
      state.system.rpc = "LIVE PROVIDER";
      state.system.market = "LIVE PROVIDER";
    } else {
      state.tokens = state.tokens.map((item, index) => {
        const drift = ((started / 30000 + index) % 5) - 2;
        return { ...item, radar: Math.round(Math.max(1, Math.min(99, item.radar + drift))), updatedAt: new Date().toISOString() };
      });
    }
    state.lastScan = new Date().toISOString();
    state.nextScanAt = Date.now() + AUTO_SCAN_MS;
    state.system.lastScanStatus = "SUCCESS";
    state.system.avgDuration = `${Date.now() - started}ms`;
    state.system.tokensPerScan = state.tokens.length;
    state.system.transactionsPerScan = state.mode === "demo" ? 128 : null;
    state.scanRunning = false;
    await finishScanRun(scanRun.id, {
      status: "SUCCESS",
      finishedAt: new Date(),
      durationMs: Date.now() - started,
      tokensScanned: state.tokens.length,
      transactionsProcessed: state.mode === "demo" ? 128 : 0,
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
    return { ok: false, message: state.mode === "live" ? "Provider temporarily unavailable. Data remains unchanged." : error.message };
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
  if (req.method === "POST" && url.pathname === "/api/settings") {
    try {
      const body = await readBody(req);
      if (body.mode === "demo" || body.mode === "live") state.mode = body.mode;
      if (body.mode === "demo") {
        state.provider = "Controlled Demo Dataset";
        state.system.rpc = "DEMO PROVIDER";
        state.system.market = "DEMO PROVIDER";
        state.tokens = DEMO_TOKENS.map(item => ({ ...item, updatedAt: new Date().toISOString() }));
        state.nextScanAt = Date.now() + AUTO_SCAN_MS;
      }
      if (body.mode === "live") { state.provider = "DexScreener"; state.system.rpc = "LIVE PROVIDER"; state.system.market = "LIVE PROVIDER"; }
      await saveState();
      return send(res, 200, { ok: true, mode: state.mode, provider: state.provider });
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