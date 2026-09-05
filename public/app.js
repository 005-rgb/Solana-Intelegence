const app = document.querySelector("#app");
let snapshot = null;
let activePage = "dashboard";
let selectedToken = null;
let whaleRange = "6h";
let radarSort = "radar";
let radarStatus = "all";
let refreshInFlight = false;

const NAV_GROUPS = [
  ["Workspace", [
    ["dashboard", "⌂", "Dashboard"],
    ["radar", "◈", "Radar"],
    ["new-tokens", "✦", "New Tokens"],
    ["whales", "◒", "Whales"],
    ["smart-money", "◌", "Smart Money"],
    ["watchlist", "☆", "Watchlist"]
  ]],
  ["Trading", [
    ["portfolio", "▣", "Paper Portfolio"],
    ["trades", "↔", "Trades"],
    ["alerts", "!", "Alerts"]
  ]],
  ["Research", [
    ["patterns", "⌁", "Patterns"],
    ["backtest", "◫", "Backtest"],
    ["model", "◎", "Model Intelligence"],
    ["token-search", "⌕", "Token Search"]
  ]],
  ["System", [
    ["settings", "⚙", "Settings"],
    ["health", "◌", "System Health"]
  ]]
];
const NAV = NAV_GROUPS.flatMap(([, items]) => items);
const money = (value, digits = 0) => value == null ? "UNKNOWN" : value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: digits });
const compact = value => value == null ? "UNKNOWN" : value >= 1e6 ? `$${(value / 1e6).toFixed(1)}M` : value >= 1e3 ? `$${(value / 1e3).toFixed(0)}K` : `$${value.toFixed(0)}`;
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;" }[c]));
const safeHttpUrl = value => /^https?:\/\//i.test(String(value || "")) ? String(value) : "";
const priceNumber = value => {
  const parsed = Number(String(value ?? "").replace(/[$,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
};
function tokenLogo(item, large = false) {
  const icon = safeHttpUrl(item?.details?.providerMetadata?.icon);
  const className = large ? "big-logo" : "token-logo";
  return icon ? `<img class="${className} token-logo-image" src="${esc(icon)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<div class="${className}">${esc(String(item?.symbol || "?").slice(0, 2))}</div>`;
}
const tone = (risk, positive = false) => positive ? "green" : risk <= 25 ? "green" : risk <= 55 ? "yellow" : "red";
const nextScanLabel = () => {
  const seconds = Math.max(0, Math.ceil(((snapshot?.nextScanAt || Date.now() + 30000) - Date.now()) / 1000));
  return `Next auto scan ${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
};
function toast(message, error = false) { const el = document.createElement("div"); el.className = `toast ${error ? "error" : ""}`; el.textContent = message; document.querySelector("#toast-region").appendChild(el); setTimeout(() => el.remove(), 3500); }
async function api(path, options = {}) { const response = await fetch(path, { headers: { "Content-Type":"application/json" }, ...options }); const data = await response.json(); if (!response.ok) throw new Error(data.error || "Request failed"); return data; }

function layout(content) {
  const rendered = `<div class="app-shell">
    <aside class="sidebar">
      <div class="brand"><div class="brand-mark">20</div><div><div class="brand-name">Solana Radar</div><div class="brand-sub">Intelligence OS</div></div></div>
       ${NAV_GROUPS.map(([group, items]) => `<div class="nav-section">${group}</div>${items.map(navItem).join("")}`).join("")}
       <div class="sidebar-bottom"><div class="mode-pill"><span class="mode-dot live"></span>LIVE PROVIDER</div><div class="disclaimer">Research analytics only. Scores and historical patterns are not guarantees or financial advice.</div></div>
    </aside>
    <main class="content">
       <header class="topbar"><div class="topbar-left"><span class="eyebrow">Solana 20× Radar</span><span class="scan-status"><span class="live-dot"></span>DexScreener LIVE · ${snapshot?.lastScan ? "updated just now" : "awaiting first scan"} · <span id="next-scan-label">${nextScanLabel()}</span></span></div><div class="top-actions"><input id="global-search" class="search" placeholder="Search token or mint…" /><button class="icon-button" title="Alerts" onclick="go('alerts')">◔</button><button class="icon-button" title="Settings" onclick="go('settings')">⋯</button></div></header>
      <div class="mobile-nav">${NAV.map(navItem).join("")}</div>
      <div class="main">${content}</div>
    </main>
  </div>`;
  app.innerHTML = rendered.replaceAll("30s", "15s").replaceAll("30 seconds", "15 seconds");
  document.querySelector("#global-search")?.addEventListener("keydown", e => { if (e.key === "Enter") { const query = e.target.value.trim().toLowerCase(); const found = snapshot.tokens.find(t => t.symbol.toLowerCase() === query || t.name.toLowerCase().includes(query) || t.mint.toLowerCase() === query); if (found) showToken(found.mint); else toast("No matching token in the current provider dataset.", true); } });
}
function navItem([id, icon, label]) { const count = id === "alerts" ? (snapshot?.alerts?.length || 0) : 0; return `<button class="nav-item ${activePage === id ? "active":""}" onclick="go('${id}')"><span class="nav-icon">${icon}</span><span>${label}</span>${count ? `<span class="nav-count">${count > 99 ? "99+" : count}</span>` : ""}</button>`; }
function head(eyebrow, title, description, actions = "") { return `<div class="page-head"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p>${description}</p></div><div class="actions">${actions}</div></div>`; }
function stat(label, value, foot, accent, cls = "") { return `<div class="card metric"><span class="metric-accent">${accent}</span><div class="metric-label">${label}</div><div class="metric-value ${cls}">${value}</div><div class="metric-foot">${foot}</div></div>`; }
function statusBadge(item) { const t = item.status?.includes("RISK") || item.status === "DISTRIBUTING" ? "red" : item.status === "BREAKOUT" || item.status === "ACCUMULATING" || item.status === "ACTIVE" ? "green" : item.status === "HYPED" || item.status === "COOLING" ? "yellow" : "blue"; return `<span class="badge badge-${t}">${esc(item.status)}</span>`; }
function positionFor(item) { return snapshot?.portfolio?.positions?.find(position => position.mint === item.mint) || null; }
function tokenPnl(item) {
  const position = positionFor(item);
  if (!position) return { text: "—", percentText: "—", className: "health-muted" };
  const pnl = Number.isFinite(position.pnl) ? position.pnl : null;
  const pnlPct = Number.isFinite(position.pnlPct) ? position.pnlPct : null;
  if (pnl == null) return { text: "UNKNOWN", percentText: "UNKNOWN", className: "health-muted" };
  return {
    text: `${pnl >= 0 ? "+" : ""}${money(pnl)}`,
    percentText: pnlPct == null ? "UNKNOWN" : `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`,
    className: pnl >= 0 ? "positive" : "negative"
  };
}
function pnlMarkup(item) {
  const pnl = tokenPnl(item);
  if (pnl.text === "—") return `<span class="pnl-cell health-muted">—</span>`;
  return `<span class="pnl-cell ${pnl.className}"><strong>${pnl.text}</strong><small>${pnl.percentText}</small></span>`;
}
function tokenActions(item) {
  const encoded = encodeURIComponent(item.mint);
  const watched = snapshot.watchlist.includes(item.mint);
  const position = positionFor(item);
  const canTrade = priceNumber(item.price) != null;
  const tradeLabel = position ? "Sell" : "Buy $100";
  const tradeSide = position ? "SELL" : "BUY";
  return `<div class="token-actions"><button class="btn btn-small ${watched ? "btn-quiet" : ""}" onclick="event.stopPropagation(); toggleWatch('${encoded}')">${watched ? "Watching" : "Watchlist"}</button><button class="btn btn-small ${position ? "btn-danger" : "btn-primary"}" ${canTrade ? "" : "disabled"} title="${canTrade ? "" : "Provider price unavailable"}" onclick="event.stopPropagation(); trade('${encoded}','${tradeSide}')">${tradeLabel}</button></div>`;
}
function tokenRow(item, index, actions = true) { return `<tr>
  <td class="rank">0${index + 1}</td><td><button class="token-link" onclick="showToken('${encodeURIComponent(item.mint)}')" aria-label="Open details for ${esc(item.symbol)}"><div class="token-cell">${tokenLogo(item)}<div class="token-meta"><strong>${esc(item.symbol)}</strong><span>${esc(item.name)}</span></div></div></button></td>
  <td>${esc(item.age)}</td><td>${compact(item.marketCap)}</td><td>${compact(item.liquidity)}</td><td class="score">${item.radar ?? "UNKNOWN"}</td><td>${item.opportunity ?? "UNKNOWN"}</td><td>${item.smartMoney ?? "UNKNOWN"}</td><td class="${String(item.priceChange).startsWith("-") ? "negative":"positive"}">${esc(item.priceChange)}</td><td>${statusBadge(item)}</td>
  ${actions ? `<td>${pnlMarkup(item)}</td><td>${tokenActions(item)}</td>` : ""}</tr>`; }
function tokenTable(items, title = "Top opportunities", subtitle = "Ranked by current Radar Score") { return `<section class="card page-panel"><div class="card-head"><div><div class="card-title">${title}</div><div class="card-kicker">${subtitle}</div></div><button class="btn btn-small" onclick="go('radar')">View radar ↗</button></div><div class="table-wrap"><table><thead><tr><th>#</th><th>Token</th><th>Age</th><th>MC</th><th>Liquidity</th><th>Radar</th><th>Opp.</th><th>Smart</th><th>24h</th><th>Status</th><th>P/L</th><th>Actions</th></tr></thead><tbody>${items.map(tokenRow).join("")}</tbody></table></div><div class="data-note">LIVE DATA · Values reflect the latest DexScreener response. Unavailable fields remain UNKNOWN.</div></section>`; }
function whaleChart() {
  const ranges = { "1h": 60 * 60 * 1000, "6h": 6 * 60 * 60 * 1000, "24h": 24 * 60 * 60 * 1000 };
  const cutoff = Date.now() - ranges[whaleRange];
  const points = (snapshot.whaleActivity || []).filter(point => new Date(point.at).getTime() >= cutoff);
  const sourceLabel = "LIVE PROVIDER";
  if (!points.length) {
    return `<section class="card whale-chart-card"><div class="card-head"><div><div class="card-title">Whale activity volume</div><div class="card-kicker">Accumulation pressure over time · ${sourceLabel}</div></div><span class="badge badge-yellow">UNKNOWN</span></div><div class="empty"><strong>Whale activity unavailable</strong><span>The current provider has not supplied whale-volume evidence for this window.</span></div></section>`;
  }
  const maxVolume = Math.max(...points.map(point => Math.max(point.buyVolume || 0, point.sellVolume || 0)), 1);
  const width = 760;
  const height = 210;
  const baseline = 106;
  const plotTop = 20;
  const plotBottom = 184;
  const plotWidth = width - 48;
  const step = points.length === 1 ? plotWidth : plotWidth / (points.length - 1);
  const x = index => 24 + index * step;
  const yBuy = value => baseline - (value / maxVolume) * (baseline - plotTop);
  const ySell = value => baseline + (value / maxVolume) * (plotBottom - baseline);
  const yNet = value => baseline - (value / maxVolume) * 60;
  const bars = points.map((point, index) => {
    const barWidth = Math.max(5, Math.min(20, step * 0.5));
    const buyHeight = Math.max(1, baseline - yBuy(point.buyVolume || 0));
    const sellHeight = Math.max(1, ySell(point.sellVolume || 0) - baseline);
    const time = new Date(point.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return `<g><title>${time} · buy ${money(point.buyVolume)} · sell ${money(point.sellVolume)} · net ${money(point.netFlow)}</title><rect class="whale-buy" x="${x(index) - barWidth / 2}" y="${baseline - buyHeight}" width="${barWidth}" height="${buyHeight}" rx="2"></rect><rect class="whale-sell" x="${x(index) - barWidth / 2}" y="${baseline}" width="${barWidth}" height="${sellHeight}" rx="2"></rect></g>`;
  }).join("");
  const netLine = points.map((point, index) => `${x(index)},${yNet(point.netFlow || 0)}`).join(" ");
  const firstLabel = new Date(points[0].at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const lastLabel = new Date(points[points.length - 1].at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const latest = points[points.length - 1];
  const accumulation = (latest.netFlow || 0) >= 0;
  return `<section class="card whale-chart-card"><div class="card-head"><div><div class="card-title">Whale activity volume</div><div class="card-kicker">Buy volume above zero · sell volume below zero · ${sourceLabel}</div></div><div class="chart-actions">${["1h", "6h", "24h"].map(range => `<button class="chart-range ${whaleRange === range ? "active" : ""}" onclick="setWhaleRange('${range}')">${range}</button>`).join("")}</div></div><div class="whale-summary"><div><span class="insight-label">Latest net flow</span><strong class="${accumulation ? "positive" : "negative"}">${accumulation ? "+" : ""}${money(latest.netFlow)}</strong></div><div><span class="insight-label">Total volume</span><strong>${money(latest.totalVolume)}</strong></div><div><span class="insight-label">Read</span><strong class="${accumulation ? "positive" : "negative"}">${accumulation ? "ACCUMULATION" : "DISTRIBUTION"}</strong></div></div><div class="whale-chart"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Whale buy and sell volume over time"><line class="whale-grid" x1="24" y1="${plotTop}" x2="${width - 24}" y2="${plotTop}"></line><line class="whale-grid" x1="24" y1="${baseline}" x2="${width - 24}" y2="${baseline}"></line><line class="whale-grid" x1="24" y1="${plotBottom}" x2="${width - 24}" y2="${plotBottom}"></line><text class="whale-axis" x="4" y="${plotTop + 4}">BUY</text><text class="whale-axis" x="4" y="${plotBottom}">SELL</text>${bars}<polyline class="whale-net" points="${netLine}"></polyline></svg><div class="whale-axis-labels"><span>${firstLabel}</span><span>Net flow trend</span><span>${lastLabel}</span></div></div><div class="chart-legend"><span><i class="legend-buy"></i>Buy volume</span><span><i class="legend-sell"></i>Sell volume</span><span><i class="legend-net"></i>Net flow</span><span class="data-note-inline">${points.length} observations · refreshes every 30s</span></div></section>`;
}
function setWhaleRange(range) { whaleRange = range; render(); }
function alertMarkup(alert, large = false) {
  const token = snapshot.tokens.find(item => item.symbol === alert.token);
  const tokenLabel = token
    ? `<button class="alert-token-link" onclick="showToken('${encodeURIComponent(token.mint)}')">${esc(alert.token)}</button>`
    : `<span class="alert-token">${esc(alert.token)}</span>`;
  return `<div class="alert ${large ? "alert-large" : ""}"><span class="alert-mark mark-${alert.tone}"></span><div class="alert-copy"><div class="alert-title">${esc(alert.type)}${tokenLabel}</div><div class="alert-text">${esc(alert.text)}</div></div><span class="alert-time">${esc(alert.time)}</span></div>`;
}
function dashboard() {
  const sorted = [...snapshot.tokens].sort((a,b) => (b.radar ?? -1) - (a.radar ?? -1));
  const portfolio = snapshot.portfolio;
  const latestWhale = (snapshot.whaleActivity || []).at(-1);
  const riskAlerts = snapshot.alerts.filter(alert => alert.tone === "red" || alert.tone === "yellow").length;
  const feed = snapshot.alerts.length
    ? snapshot.alerts.map(alert => alertMarkup(alert)).join("")
    : `<div class="empty"><strong>No live alerts yet</strong><span>Alerts will appear after provider evidence is available.</span></div>`;
  return liveDashboard();
  return head("Command center", "Find the signal before the crowd.", "A multi-factor view of live DexScreener data, virtual execution, and evidence coverage across the Solana ecosystem.", `<button class="btn btn-primary" onclick="scan()">↻ Scan now</button>`) +
    `<div class="grid metrics">${stat("Radar opportunities", sorted.filter(token => token.radar != null && token.radar >= 75).length, "provider-scored candidates", "◈", "metric-positive")}${stat("Whale net flow", money(latestWhale?.netFlow), "provider evidence only", "↗", latestWhale ? "metric-positive" : "")}${stat("Virtual equity", money(portfolio.equity), `${portfolio.roi >= 0 ? "+" : ""}${portfolio.roi.toFixed(2)}% total ROI`, "◫", portfolio.roi >= 0 ? "metric-positive" : "metric-negative")}${stat("Risk alerts", riskAlerts, "requiring review", "!", riskAlerts ? "metric-negative" : "")}</div>
    <div class="grid main-grid">${tokenTable(sorted.slice(0,5))}<div class="card activity-card"><div class="card-head"><div><div class="card-title">Signal feed</div><div class="card-kicker">Recent system observations</div></div><span class="badge badge-blue">LIVE</span></div>${snapshot.alerts.map(alert => `<div class="alert"><span class="alert-mark mark-${alert.tone}"></span><div class="alert-copy"><div class="alert-title">${esc(alert.type)}<span class="alert-token">${esc(alert.token)}</span></div><div class="alert-text">${esc(alert.text)}</div></div><span class="alert-time">${esc(alert.time)}</span></div>`).join("")}</div></div>
     ${whaleChart()}<div class="grid section-grid"><div class="card matrix"><div class="card-title">Opportunity × risk matrix</div><div class="card-kicker">Current candidates by evidence-weighted score</div><div class="matrix-plot">${sorted.slice(0,8).map((t,i) => `<span class="matrix-dot dot-${tone(t.risk)}" title="${esc(t.symbol)}" style="left:${Math.min(91,Math.max(4,t.opportunity || 20))}%;top:${Math.min(91,Math.max(4,t.risk || 20))}%"></span>`).join("")}<span class="axis-y">Risk →</span></div><div class="axis-x">Opportunity →</div></div><div class="card insight-card"><div class="insight-label">Signal consensus</div><div class="insight-number">6<span style="font-size:15px;color:var(--muted)"> / 7</span></div><div class="progress"><span style="width:86%"></span></div><div class="insight-note">Independent engines agree on NOVA. Confidence is still separate from opportunity.</div></div><div class="card insight-card"><div class="insight-label">Scan health</div><div class="insight-number">${snapshot.lastScan ? "READY" : "IDLE"}</div><div class="progress"><span style="width:${snapshot.lastScan ? 100 : 35}%;background:var(--green)"></span></div><div class="insight-note">Server-side 30s scheduler · ${snapshot.lastScan ? `last completed ${new Date(snapshot.lastScan).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}` : "run a scan to initialize"}</div></div></div>`;
}
function liveDashboard() {
  const sorted = [...snapshot.tokens].sort((a, b) => (b.radar ?? -1) - (a.radar ?? -1));
  const portfolio = snapshot.portfolio;
  const latestWhale = (snapshot.whaleActivity || []).at(-1);
  const riskAlerts = snapshot.alerts.filter(alert => alert.tone === "red" || alert.tone === "yellow").length;
  const feed = snapshot.alerts.length
    ? snapshot.alerts.map(alert => `<div class="alert"><span class="alert-mark mark-${alert.tone}"></span><div class="alert-copy"><div class="alert-title">${esc(alert.type)}<span class="alert-token">${esc(alert.token)}</span></div><div class="alert-text">${esc(alert.text)}</div></div><span class="alert-time">${esc(alert.time)}</span></div>`).join("")
    : `<div class="empty"><strong>No live alerts yet</strong><span>Alerts will appear after provider evidence is available.</span></div>`;
  return head("Command center", "Find the signal before the crowd.", "A multi-factor view of live DexScreener data, virtual execution, and evidence coverage across the Solana ecosystem.", `<button class="btn btn-primary" onclick="scan()">↻ Scan now</button>`) +
    `<div class="grid metrics">${stat("Radar opportunities", sorted.filter(token => token.radar != null && token.radar >= 75).length, "provider-scored candidates", "◈", "metric-positive")}${stat("Whale net flow", money(latestWhale?.netFlow), "provider evidence only", "↗", latestWhale ? "metric-positive" : "")}${stat("Virtual equity", money(portfolio.equity), `${portfolio.roi >= 0 ? "+" : ""}${portfolio.roi.toFixed(2)}% total ROI`, "◫", portfolio.roi >= 0 ? "metric-positive" : "metric-negative")}${stat("Risk alerts", riskAlerts, "requiring review", "!", riskAlerts ? "metric-negative" : "")}</div>` +
    `${snapshot.alerts.some(alert => alert.type === "POTENTIAL TOKEN") ? `<section class="potential-banner"><div class="potential-icon">↗</div><div><strong>Potential token detected</strong><span>Safety-filtered candidate found. Open Alerts for the full evidence-based review.</span></div><button class="btn btn-small btn-primary" onclick="go('alerts')">View alert</button></section>` : ""}<div class="grid main-grid">${tokenTable(sorted.slice(0, 5))}<div class="card activity-card"><div class="card-head"><div><div class="card-title">Signal feed</div><div class="card-kicker">Recent live observations</div></div><span class="badge badge-blue">LIVE</span></div>${feed}</div></div>` +
    `${whaleChart()}<div class="grid section-grid"><div class="card matrix"><div class="card-title">Opportunity × risk matrix</div><div class="card-kicker">Provider scores appear when coverage is available</div><div class="matrix-plot">${sorted.filter(token => token.opportunity != null && token.risk != null).slice(0, 8).map(token => `<span class="matrix-dot dot-${tone(token.risk)}" title="${esc(token.symbol)}" style="left:${Math.min(91, Math.max(4, token.opportunity))}%;top:${Math.min(91, Math.max(4, token.risk))}%"></span>`).join("")}<span class="axis-y">Risk →</span></div><div class="axis-x">Opportunity →</div><div class="data-note">UNKNOWN until DexScreener or an indexed provider supplies scoring evidence.</div></div><div class="card insight-card"><div class="insight-label">Signal consensus</div><div class="insight-number">UNKNOWN</div><div class="progress"><span style="width:0%"></span></div><div class="insight-note">Consensus is not inferred from token-boost metadata.</div></div><div class="card insight-card"><div class="insight-label">Scan health</div><div class="insight-number">${snapshot.lastScan ? "READY" : "IDLE"}</div><div class="progress"><span style="width:${snapshot.lastScan ? 100 : 35}%;background:var(--green)"></span></div><div class="insight-note">Server-side 30s scheduler · ${snapshot.lastScan ? `last completed ${new Date(snapshot.lastScan).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "run a scan to initialize"}</div></div></div>`;
}
function setRadarSort(value) { radarSort = value; render(); }
function setRadarStatus(value) { radarStatus = value; render(); }
function radar() {
  const sorters = {
    radar: (a, b) => (b.radar ?? -1) - (a.radar ?? -1),
    opportunity: (a, b) => (b.opportunity ?? -1) - (a.opportunity ?? -1),
    risk: (a, b) => (a.risk ?? 101) - (b.risk ?? 101),
    smart: (a, b) => (b.smartMoney ?? -1) - (a.smartMoney ?? -1),
    newest: (a, b) => ageMinutes(a.age) - ageMinutes(b.age)
  };
  const items = snapshot.tokens
    .filter(item => radarStatus === "all" || String(item.status || "").toLowerCase() === radarStatus)
    .sort(sorters[radarSort] || sorters.radar);
  const report = snapshot.system?.securityFilter;
  const filterNotice = !items.length && report
    ? `<section class="card filter-notice"><strong>No token passed the active Radar filters.</strong><span>Checked ${report.checked || 0} provider records; accepted ${report.accepted || 0}. Tokens remain hidden when security verification is unavailable or fails.</span>${(report.reasons || []).slice(0, 4).map(item => `<div class="filter-reason"><span>${esc(item.reason)}</span><strong>${item.count}</strong></div>`).join("")}</section>`
    : "";
  return head("Discovery", "Radar board", "Sort the current LIVE universe by provider evidence. Missing scores remain UNKNOWN and are never estimated.", `<button class="btn btn-primary" onclick="scan()">↻ Scan now</button>`) +
    filterNotice +
    `<section class="card page-panel"><div class="toolbar"><label class="filter-control">Status <select onchange="setRadarStatus(this.value)"><option value="all" ${radarStatus === "all" ? "selected" : ""}>All statuses</option><option value="provider" ${radarStatus === "provider" ? "selected" : ""}>Provider</option><option value="cto flag" ${radarStatus === "cto flag" ? "selected" : ""}>CTO flag</option></select></label><label class="filter-control">Sort <select onchange="setRadarSort(this.value)"><option value="radar" ${radarSort === "radar" ? "selected" : ""}>Radar score</option><option value="opportunity" ${radarSort === "opportunity" ? "selected" : ""}>Opportunity</option><option value="risk" ${radarSort === "risk" ? "selected" : ""}>Lowest risk</option><option value="smart" ${radarSort === "smart" ? "selected" : ""}>Smart money</option><option value="newest" ${radarSort === "newest" ? "selected" : ""}>Newest first</option></select></label><span class="filter">${items.length} of ${snapshot.tokens.length} tokens</span></div><div class="table-wrap"><table><thead><tr><th>#</th><th>Token</th><th>Age</th><th>MC</th><th>Liquidity</th><th>Radar</th><th>Opp.</th><th>Smart</th><th>Momentum</th><th>Hype</th><th>Risk</th><th>Confidence</th><th>Status</th><th>P/L</th><th>Actions</th></tr></thead><tbody>${items.map((item, i) => { return `<tr><td class="rank">${String(i+1).padStart(2,"0")}</td><td><button class="token-link" onclick="showToken('${encodeURIComponent(item.mint)}')" aria-label="Open details for ${esc(item.symbol)}"><div class="token-cell">${tokenLogo(item)}<div class="token-meta"><strong>${esc(item.symbol)}</strong><span>${esc(item.name)}</span></div></div></button></td><td>${esc(item.age)}</td><td>${compact(item.marketCap)}</td><td>${compact(item.liquidity)}</td><td class="score">${item.radar ?? "UNKNOWN"}</td><td>${item.opportunity ?? "UNKNOWN"}</td><td>${item.smartMoney ?? "UNKNOWN"}</td><td>${item.momentum ?? "UNKNOWN"}</td><td>${item.hype ?? "UNKNOWN"}</td><td class="${item.risk > 55 ? "negative":""}">${item.risk ?? "UNKNOWN"}</td><td>${item.confidence ?? "UNKNOWN"}${item.confidence != null ? "%" : ""}</td><td>${statusBadge(item)}</td><td>${pnlMarkup(item)}</td><td>${tokenActions(item)}</td></tr>`; }).join("")}</tbody></table></div><div class="data-note">Showing ${items.length} provider records. P/L percentage is marked to the latest LIVE price every 5 seconds while a virtual position is open.</div></section>`;
}
const flowNumber = value => {
  const match = String(value || "").replace(/[$,]/g, "").match(/([+-]?\d+(?:\.\d+)?)([KMB]?)/i);
  if (!match) return null;
  return Number(match[1]) * ({ K: 1e3, M: 1e6, B: 1e9 }[match[2].toUpperCase()] || 1);
};
const ageMinutes = value => {
  const text = String(value || "");
  const hours = Number(text.match(/(\d+)\s*h/)?.[1] || 0);
  const minutes = Number(text.match(/(\d+)\s*m/)?.[1] || 0);
  return hours * 60 + minutes;
};
function tokenMiniRow(item, index, extra = "") {
  return `<tr><td class="rank">${String(index + 1).padStart(2, "0")}</td><td><div class="token-cell">${tokenLogo(item)}<div class="token-meta"><strong>${esc(item.symbol)}</strong><span>${esc(item.name)}</span></div></div></td><td>${compact(item.marketCap)}</td><td>${compact(item.liquidity)}</td><td class="score">${item.radar ?? "UNKNOWN"}</td>${extra}<td>${statusBadge(item)}</td><td><button class="btn btn-small btn-quiet" onclick="showToken('${encodeURIComponent(item.mint)}')">View</button></td></tr>`;
}
function newTokens() {
  const items = [...snapshot.tokens].sort((a, b) => ageMinutes(a.age) - ageMinutes(b.age));
  return head("Discovery", "New tokens", "Recently observed candidates with freshness, liquidity, and risk evidence kept separate.", `<button class="btn btn-primary" onclick="scan()">↻ Scan now</button>`) +
    `<section class="card page-panel"><div class="toolbar"><span class="filter">Freshest first</span><span class="filter">Provider: ${esc(snapshot.provider)}</span><span class="filter">${items.length} observations</span></div><div class="table-wrap"><table><thead><tr><th>#</th><th>Token</th><th>MC</th><th>Liquidity</th><th>Radar</th><th>Momentum</th><th>Risk</th><th>Status</th><th></th></tr></thead><tbody>${items.map((item, index) => tokenMiniRow(item, index, `<td>${item.momentum ?? "UNKNOWN"}</td><td>${item.risk ?? "UNKNOWN"}</td>`)).join("")}</tbody></table></div><div class="data-note">LIVE DATA · Freshness and deep token age may be unavailable from the configured provider.</div></section>`;
}
function whales() {
  const items = [...snapshot.tokens].sort((a, b) => (flowNumber(b.whaleFlow) ?? -Infinity) - (flowNumber(a.whaleFlow) ?? -Infinity));
  return head("On-chain intelligence", "Whales", "Track reported whale flow by token and compare the latest activity against accumulated volume.", `<button class="btn btn-primary" onclick="scan()">↻ Refresh whale scan</button>`) +
    whaleChart() + `<section class="card page-panel" style="margin-top:14px"><div class="card-head"><div><div class="card-title">Token whale flow</div><div class="card-kicker">Provider-reported flow; UNKNOWN stays visible when coverage is missing</div></div></div><div class="table-wrap"><table><thead><tr><th>#</th><th>Token</th><th>MC</th><th>Liquidity</th><th>Whale flow</th><th>Holder growth</th><th>Radar</th><th>Status</th><th></th></tr></thead><tbody>${items.map((item, index) => tokenMiniRow(item, index, `<td class="${(flowNumber(item.whaleFlow) || 0) >= 0 ? "positive" : "negative"}">${esc(item.whaleFlow)}</td><td>${esc(item.holderGrowth)}</td>`)).join("")}</tbody></table></div></section>`;
}
function smartMoney() {
  const items = [...snapshot.tokens].sort((a, b) => (b.smartMoney ?? -1) - (a.smartMoney ?? -1));
  return head("Capital intelligence", "Smart money", "Rank tracked-wallet conviction independently from hype and opportunity so accumulation is not confused with attention.", `<button class="btn btn-primary" onclick="scan()">↻ Refresh signals</button>`) +
    `<div class="grid metrics">${stat("Tracked candidates", items.length, "current provider universe", "◌")}${stat("High conviction", items.filter(item => item.smartMoney != null && item.smartMoney >= 75).length, "smart money score ≥ 75", "↗", "metric-positive")}${stat("Net whale flow", money((snapshot.whaleActivity || []).at(-1)?.netFlow), "latest recorded observation", "◒", "metric-positive")}${stat("Data source", "LIVE", "DexScreener provider", "◈")}</div>` +
    `<section class="card page-panel"><div class="card-head"><div><div class="card-title">Smart money leaderboard</div><div class="card-kicker">Score, flow, holders, and risk shown as separate evidence</div></div></div><div class="table-wrap"><table><thead><tr><th>#</th><th>Token</th><th>Smart</th><th>Whale flow</th><th>Holder growth</th><th>Opportunity</th><th>Risk</th><th>Status</th><th></th></tr></thead><tbody>${items.map((item, index) => `<tr><td class="rank">${String(index + 1).padStart(2, "0")}</td><td><div class="token-cell"><div class="token-logo">${esc(item.symbol.slice(0,2))}</div><div class="token-meta"><strong>${esc(item.symbol)}</strong><span>${esc(item.name)}</span></div></div></td><td class="score">${item.smartMoney ?? "UNKNOWN"}</td><td class="${(flowNumber(item.whaleFlow) || 0) >= 0 ? "positive" : "negative"}">${esc(item.whaleFlow)}</td><td>${esc(item.holderGrowth)}</td><td>${item.opportunity ?? "UNKNOWN"}</td><td>${item.risk ?? "UNKNOWN"}</td><td>${statusBadge(item)}</td><td><button class="btn btn-small btn-quiet" onclick="showToken('${encodeURIComponent(item.mint)}')">View</button></td></tr>`).join("")}</tbody></table></div></section>`;
}
function trades() {
  const history = snapshot.portfolio.history || [];
  const buys = history.filter(trade => trade.side === "BUY").length;
  const sells = history.filter(trade => trade.side === "SELL").length;
  return head("Paper execution", "Trades", "Every simulated decision is persisted with side, price, fee, score, and timestamp. No real funds are connected.", `<button class="btn btn-primary" onclick="go('radar')">Paper trade from Radar</button>`) +
    `<div class="grid metrics">${stat("Recorded trades", history.length, "persisted journal entries", "↔")}${stat("Buys", buys, "fixed $100 entry model", "↗", "metric-positive")}${stat("Sells", sells, "closed paper positions", "↘", "metric-negative")}${stat("Fees paid", money(snapshot.portfolio.fees), "simulated 0.3% fee", "◫")}</div>` +
    `<section class="card page-panel"><div class="card-head"><div><div class="card-title">Trade journal</div><div class="card-kicker">Newest execution first · PostgreSQL-backed</div></div></div>${history.length ? `<div class="table-wrap"><table><thead><tr><th>Time</th><th>Side</th><th>Token</th><th>Amount</th><th>Price</th><th>Fee</th><th>Radar score</th></tr></thead><tbody>${history.map(trade => `<tr><td>${formatDate(trade.time)}</td><td><span class="badge ${trade.side === "BUY" ? "badge-green" : "badge-red"}">${esc(trade.side)}</span></td><td><strong>${esc(trade.symbol)}</strong></td><td>${money(trade.amount)}</td><td>$${Number(trade.price).toFixed(5)}</td><td>${money(trade.fee)}</td><td class="score">${trade.score ?? "UNKNOWN"}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty"><strong>No paper trades yet</strong>Paper buys are always exactly $100.</div>`}</section>`;
}
function alerts() {
  return head("Risk operations", "Alerts", "Review current observations and risk flags produced by the signal feed. Alerts are informational and never financial advice.", `<button class="btn btn-primary" onclick="scan()">↻ Run alert scan</button>`) +
    `<div class="grid metrics">${stat("Open observations", snapshot.alerts.length, "latest persisted feed", "!")}${stat("High risk", snapshot.alerts.filter(alert => alert.tone === "red").length, "red alerts", "!", "metric-negative")}${stat("Watch items", snapshot.alerts.filter(alert => alert.tone === "yellow").length, "yellow alerts", "◌")}${stat("Last scan", snapshot.lastScan ? formatDate(snapshot.lastScan) : "—", "provider freshness", "◷")}</div>` +
    `<section class="card page-panel">${snapshot.alerts.length ? snapshot.alerts.map(alert => alertMarkup(alert, true)).join("") : `<div class="empty"><strong>No potential-token notifications yet</strong><span>Notifications appear only after a LIVE token passes every active safety filter.</span></div>`}</section>`;
}
function backtest() {
  const runs = snapshot.scanRuns || [];
  const successful = runs.filter(run => run.status === "SUCCESS");
  const evaluated = successful.reduce((sum, run) => sum + (run.tokensScanned || 0), 0);
  const avgDuration = successful.length ? Math.round(successful.reduce((sum, run) => sum + (run.durationMs || 0), 0) / successful.length) : null;
  const avgPatternMatch = snapshot.patterns.length ? Math.round(snapshot.patterns.reduce((sum, pattern) => sum + pattern.match, 0) / snapshot.patterns.length) : null;
  return head("Validation", "Backtest", "Replay captured scan runs and pattern outcomes without inventing historical market data. New history is created by the server-side scan.", `<button class="btn btn-primary" onclick="scan()">↻ Capture next observation</button>`) +
    `<div class="grid metrics">${stat("Captured runs", runs.length, "Prisma ScanRun history", "◫")}${stat("Successful runs", successful.length, "eligible for replay", "✓", "metric-positive")}${stat("Tokens evaluated", evaluated, "across successful scans", "◈")}${stat("Avg duration", avgDuration == null ? "UNKNOWN" : `${avgDuration}ms`, "captured scan duration", "◷")}</div>` +
     `<div class="grid main-grid"><section class="card page-panel"><div class="card-head"><div><div class="card-title">Signal replay summary</div><div class="card-kicker">Live provider history · average match ${avgPatternMatch == null ? "UNKNOWN" : `${avgPatternMatch}%`}</div></div><span class="badge badge-blue">LIVE HISTORY</span></div>${snapshot.patterns.map(pattern => `<div class="health-row"><span>${esc(pattern.id)} · ${esc(pattern.name)}</span><strong class="health-value ${pattern.tone === "red" ? "health-warn" : "health-ok"}">${pattern.match}% match</strong></div>`).join("")}<div class="data-note">No future returns are fabricated. A proper historical backtest becomes available as provider snapshots accumulate.</div></section><section class="card page-panel"><div class="card-head"><div><div class="card-title">Recent scan runs</div><div class="card-kicker">Execution evidence</div></div></div>${runs.slice(0, 8).map(run => `<div class="alert"><span class="alert-mark ${run.status === "SUCCESS" ? "mark-green" : "mark-red"}"></span><div class="alert-copy"><div class="alert-title">${run.manual ? "MANUAL" : "AUTO"} · ${esc(run.status)}</div><div class="alert-text">${run.tokensScanned} tokens · ${run.transactionsProcessed} transactions · ${run.provider}</div></div><span class="alert-time">${formatDate(run.startedAt)}</span></div>`).join("")}</section></div>`;
}
function modelIntelligence() {
  const patterns = snapshot.patterns || [];
  const tokens = [...snapshot.tokens].sort((a, b) => (b.confidence ?? -1) - (a.confidence ?? -1));
  const sampleCount = patterns.reduce((sum, pattern) => sum + (pattern.sample || 0), 0);
  const averageMatch = patterns.length ? Math.round(patterns.reduce((sum, pattern) => sum + pattern.match, 0) / patterns.length) : null;
  return head("Research system", "Model Intelligence", "Controlled learning through measured historical outcomes. No uncontrolled self-modifying AI.", `<button class="btn btn-primary" onclick="go('backtest')">Open backtest ↗</button>`) +
    `<section class="card page-panel"><div class="card-head"><div><div class="card-title">Model versions</div><div class="card-kicker">Versioned multi-factor scoring engine</div></div><span class="badge badge-green">ACTIVE</span></div><div class="model-version"><div class="model-mark">◎</div><div class="model-copy"><strong>Radar Engine v1.0</strong><span>Opportunity · smart money · momentum · risk</span></div><div class="model-stat"><span>Pattern samples</span><strong>${sampleCount.toLocaleString()}</strong></div><div class="model-stat"><span>Avg pattern match</span><strong>${averageMatch == null ? "UNKNOWN" : `${averageMatch}%`}</strong></div><div class="model-stat"><span>Updated</span><strong>${snapshot.lastScan ? formatDate(snapshot.lastScan) : "PENDING"}</strong></div></div></section>` +
    `<section class="card page-panel model-section"><div class="card-head"><div><div class="card-title">Pattern performance</div><div class="card-kicker">Outcome-aware evidence, separated from confidence</div></div></div><div class="table-wrap"><table><thead><tr><th>Pattern</th><th>Match</th><th>Sample</th><th>Outcome</th><th>State</th></tr></thead><tbody>${patterns.map(pattern => `<tr><td><strong>${esc(pattern.id)}</strong><br><span class="health-muted">${esc(pattern.name)}</span></td><td class="score">${pattern.match}%</td><td>${pattern.sample}</td><td>${esc(pattern.outcome)}</td><td><span class="badge badge-${pattern.tone === "red" ? "red" : pattern.tone === "yellow" ? "yellow" : "green"}">${pattern.tone === "red" ? "RISK" : "TRACKED"}</span></td></tr>`).join("")}</tbody></table></div></section>` +
    `<section class="card page-panel model-section"><div class="card-head"><div><div class="card-title">Prediction outcomes</div><div class="card-kicker">Counterfactual tracking · unavailable horizons stay pending</div></div></div><div class="table-wrap"><table><thead><tr><th>Token</th><th>Radar</th><th>Dir</th><th>Conf</th><th>5m</th><th>15m</th><th>1h</th><th>24h</th></tr></thead><tbody>${tokens.slice(0, 12).map(item => `<tr><td><strong>${esc(item.symbol)}</strong></td><td class="score">${item.radar ?? "UNKNOWN"}</td><td class="${(flowNumber(item.whaleFlow) || 0) >= 0 ? "positive" : "negative"}">${(flowNumber(item.whaleFlow) || 0) >= 0 ? "ACCUM" : "DISTRIB"}</td><td>${item.confidence == null ? "UNKNOWN" : `${item.confidence}%`}</td><td class="health-muted">PENDING</td><td class="health-muted">PENDING</td><td class="health-muted">PENDING</td><td class="${String(item.priceChange).startsWith("-") ? "negative" : "positive"}">${esc(item.priceChange)}</td></tr>`).join("")}</tbody></table></div><div class="data-note">Short-horizon outcomes become measurable after subsequent persisted scans. Current 24h values reflect provider data where available.</div></section>`;
}
let tokenSearchQuery = "";
function tokenSearch() {
  const query = tokenSearchQuery.trim().toLowerCase();
  const items = snapshot.tokens.filter(item => !query || [item.symbol, item.name, item.mint].some(value => String(value || "").toLowerCase().includes(query)));
  return head("Discovery", "Token Search", "Search the current provider universe by symbol, name, or mint address.", "") +
    `<section class="card page-panel"><div class="search-panel"><input id="token-search-input" class="search search-wide" value="${esc(tokenSearchQuery)}" placeholder="Search symbol, token name, or mint…" oninput="setTokenSearch(this.value)" /><span class="health-muted">${items.length} result${items.length === 1 ? "" : "s"}</span></div><div class="table-wrap"><table><thead><tr><th>#</th><th>Token</th><th>Price</th><th>Market cap</th><th>Liquidity</th><th>Radar</th><th>Risk</th><th>Status</th><th></th></tr></thead><tbody>${items.map((item, index) => `<tr><td class="rank">${String(index + 1).padStart(2, "0")}</td><td><div class="token-cell"><div class="token-logo">${esc(item.symbol.slice(0,2))}</div><div class="token-meta"><strong>${esc(item.symbol)}</strong><span>${esc(item.name)} · ${esc(item.mint)}</span></div></div></td><td>${esc(item.price)}</td><td>${compact(item.marketCap)}</td><td>${compact(item.liquidity)}</td><td class="score">${item.radar ?? "UNKNOWN"}</td><td>${item.risk ?? "UNKNOWN"}</td><td>${statusBadge(item)}</td><td><button class="btn btn-small btn-quiet" onclick="showToken('${encodeURIComponent(item.mint)}')">View</button></td></tr>`).join("")}</tbody></table></div></section>`;
}
function watchlist() { const items = snapshot.tokens.filter(t => snapshot.watchlist.includes(t.mint)); return head("Permanent research memory", "Watchlist", "Historical records are never removed automatically. Remove from the active view without losing the evidence trail.", `<button class="btn btn-primary" onclick="go('radar')">＋ Add token</button>`) + `<section class="card page-panel">${items.length ? `<div class="table-wrap"><table><thead><tr><th>Token</th><th>Radar</th><th>Previous</th><th>Risk</th><th>Whale flow</th><th>Momentum</th><th>Price</th><th>Status</th><th>Last update</th><th></th></tr></thead><tbody>${items.map(item => `<tr><td><div class="token-cell"><div class="token-logo">${esc(item.symbol.slice(0,2))}</div><div class="token-meta"><strong>${esc(item.symbol)}</strong><span>${esc(item.name)}</span></div></div></td><td class="score">${item.radar ?? "UNKNOWN"}</td><td>${Math.max(0,(item.radar || 0)-6)}</td><td class="${item.risk > 55 ? "negative":""}">${item.risk ?? "UNKNOWN"}</td><td class="positive">${esc(item.whaleFlow)}</td><td>${item.momentum ?? "UNKNOWN"}</td><td>${esc(item.price)}</td><td>${statusBadge(item)}</td><td class="health-muted">${esc(item.age)} ago</td><td><button class="btn btn-small btn-danger" onclick="removeWatch('${encodeURIComponent(item.mint)}')">Remove view</button></td></tr>`).join("")}</tbody></table></div><div class="data-note">Permanent memory contains ${snapshot.watchlistHistory.length + items.length} recorded watchlist events. Active view shows ${items.length} tokens.</div>` : `<div class="empty"><strong>No active tokens in view</strong>Add candidates from the Radar board. Historical records remain preserved when removed.</div>`}</section>`; }
function portfolio() { const p=snapshot.portfolio; return head("Paper research", "Virtual portfolio", "A fixed $100 entry model using recorded market conditions. No wallet connection, private key, or real funds.", `<button class="btn btn-primary" onclick="go('radar')">Paper buy from Radar</button>`) + `<div class="grid metrics">${stat("Starting capital", money(p.starting), "fixed virtual balance", "◫")}${stat("Current equity", money(p.equity), `${p.roi >= 0 ? "+" : ""}${p.roi.toFixed(2)}% ROI`, "↗", p.roi >= 0 ? "metric-positive":"metric-negative")}${stat("Available cash", money(p.cash), `${p.positions.length} open positions`, "○")}${stat("Unrealized P/L", `${p.unrealized >= 0 ? "+" : ""}${money(p.unrealized)}`, "marked to latest price", "Δ", p.unrealized >= 0 ? "metric-positive":"metric-negative")}</div><div class="grid main-grid"><section class="card page-panel"><div class="card-head"><div><div class="card-title">Open positions</div><div class="card-kicker">Live mark-to-market · 0.3% simulated fee</div></div></div>${p.positions.length ? `<div class="table-wrap"><table><thead><tr><th>Token</th><th>Entry</th><th>Current</th><th>Invested</th><th>Value</th><th>P/L</th><th>Holding</th><th></th></tr></thead><tbody>${p.positions.map(pos => `<tr><td><div class="token-cell"><div class="token-logo">${esc(pos.symbol.slice(0,2))}</div><div class="token-meta"><strong>${esc(pos.symbol)}</strong><span>${esc(pos.name)}</span></div></div></td><td>$${pos.entry.toFixed(4)}</td><td>$${pos.currentPrice.toFixed(4)}</td><td>${money(pos.invested)}</td><td>${money(pos.currentValue)}</td><td class="${pos.pnl >= 0 ? "positive":"negative"}">${pos.pnl >= 0 ? "+":""}${money(pos.pnl)} (${pos.pnlPct.toFixed(1)}%)</td><td>${esc(pos.holding)}</td><td><button class="btn btn-small btn-danger" onclick="trade('${encodeURIComponent(pos.mint)}','SELL')">Sell</button></td></tr>`).join("")}</tbody></table></div>` : `<div class="empty"><strong>No open positions</strong>Paper buys are always exactly $100.</div>`}</section><section class="card page-panel"><div class="card-head"><div><div class="card-title">Paper trade journal</div><div class="card-kicker">Every decision is traceable</div></div></div>${p.history.slice(0,5).map(t => `<div class="alert"><span class="alert-mark ${t.side === "BUY" ? "mark-green":"mark-red"}"></span><div class="alert-copy"><div class="alert-title">${esc(t.side)} · ${esc(t.symbol)}</div><div class="alert-text">${money(t.amount)} at $${Number(t.price).toFixed(5)} · Radar ${t.score}</div></div><span class="alert-time">${formatDate(t.time)}</span></div>`).join("")}</section></div>`; }
function patterns() {
  const patterns = snapshot.patterns || [];
  return head("Historical memory", "Pattern intelligence", "These metrics are calculated from the current provider records and persisted scan history. No synthetic outcomes are shown.", `<button class="btn btn-primary" onclick="analyzePatterns()">↻ Analyze current data</button>`) +
    `<div class="grid section-grid">${patterns.map(p => `<section class="card insight-card"><div class="insight-label">${esc(p.id)} · ${p.sample} current records</div><div class="insight-number" style="font-size:20px">${esc(p.name)}</div><div class="insight-note">${esc(p.desc)}</div><div class="progress" style="margin-top:14px"><span style="width:${p.match}%;background:${p.tone === "red" ? "var(--red)" : p.tone === "yellow" ? "#efb83e" : "var(--green)"}"></span></div><div class="insight-note"><strong>${p.match}% coverage</strong> · ${esc(p.outcome)}</div></section>`).join("")}</div><section class="card page-panel" style="margin-top:14px"><div class="card-head"><div><div class="card-title">Analysis provenance</div><div class="card-kicker">What the engine can prove from stored data</div></div><span class="badge badge-blue">${snapshot.scanRuns.length} SCANS</span></div><div class="grid metrics" style="padding:14px;margin:0">${stat("Provider records", snapshot.tokens.length, "current LIVE universe", "◈")}${stat("Successful scans", snapshot.scanRuns.filter(run => run.status === "SUCCESS").length, "persisted executions", "✓", "metric-positive")}${stat("Watchlist records", snapshot.watchlistHistory.length, "event history", "☆")}${stat("Last analysis", snapshot.lastScan ? formatDate(snapshot.lastScan) : "NOT RUN", "based on latest provider data", "◷")}</div></section>`;
}
 function health() { const s=snapshot.system; const rows=[["Scheduler",s.scheduler,"health-ok"],["Worker",s.worker,"health-ok"],["Database",s.database,"health-muted"],["Solana RPC",s.rpc,"health-ok"],["Market provider",s.market,"health-ok"],["Last scan",snapshot.lastScan ? formatDate(snapshot.lastScan) : "NOT RUN YET","health-muted"],["Average scan duration",s.avgDuration,"health-muted"],["Tokens / scan",s.tokensPerScan || "—","health-muted"],["Transactions / scan",s.transactionsPerScan ?? "—","health-muted"],["Provider errors",s.errors,"health-ok"]]; return head("Operations", "System health", "The operational view separates provider freshness, scan execution, and storage health.", `<button class="btn btn-primary" onclick="scan()">↻ Run health scan</button>`) + `<section class="card page-panel">${rows.map(row => `<div class="health-row"><span>${row[0]}</span><span class="health-value ${row[2]}">${row[1]}</span></div>`).join("")}<div class="data-note">LIVE MODE ONLY: missing provider fields are surfaced as UNKNOWN rather than filled with estimates.</div></section>`; }
function settingsBase() { return head("Configuration", "Provider settings", "DexScreener is the only market-data source. No API keys are stored in the browser.", `<button class="btn btn-primary" onclick="scan()">↻ Test provider</button>`) + `<div class="grid settings-grid"><section class="card settings-card"><h3>Live data source</h3><p>The server always uses DexScreener LIVE data and keeps unavailable provider values as UNKNOWN.</p><div class="health-row"><span>Runtime mode</span><strong class="health-value health-ok">LIVE ONLY</strong></div><div class="health-row"><span>Market provider</span><strong class="health-value health-ok">DEXSCREENER</strong></div></section><section class="card settings-card"><h3>Engine defaults</h3><p>Current policy values used by the server-side scan and paper trading engine.</p><div class="health-row"><span>Automatic scan</span><strong class="health-value health-ok">30 seconds</strong></div><div class="health-row"><span>Watchlist analysis</span><strong class="health-value health-muted">6 hours</strong></div><div class="health-row"><span>Paper buy size</span><strong class="health-value health-muted">$100 fixed</strong></div><div class="health-row"><span>Virtual starting capital</span><strong class="health-value health-muted">$100,000</strong></div></section><section class="card settings-card"><h3>Provider coverage</h3><p>Data coverage is shown honestly. RPC/indexed holders, social intelligence, and deep historical data may require additional provider configuration.</p><div class="health-row"><span>Current provider</span><strong class="health-value">${esc(snapshot.provider)}</strong></div><div class="health-row"><span>Market / price</span><strong class="health-value health-ok">LIVE WHEN PROVIDED</strong></div><div class="health-row"><span>Social intelligence</span><strong class="health-value health-warn">PARTIAL</strong></div></section><section class="card settings-card"><h3>Safety boundary</h3><p>Solana 20× Radar is analytics and paper trading only. It never requests seed phrases, private keys, wallet signing, or real transactions.</p><span class="badge badge-blue">VIRTUAL FUNDS ONLY</span></section></div>`; }
function settings() {
  return liveSettings();
}
function liveSettings() {
  return head("Configuration", "Provider settings", "DexScreener LIVE is the only data mode. No API keys are stored in the browser.", `<button class="btn btn-primary" onclick="scan()">↻ Test provider</button>`) +
    `<div class="grid settings-grid"><section class="card settings-card"><h3>Live provider</h3><p>The server always reads the DexScreener provider. Provider metadata is persisted; market and intelligence fields remain UNKNOWN when the endpoint does not supply them.</p><div class="health-row"><span>Data mode</span><strong class="health-value health-ok">LIVE ONLY</strong></div><div class="health-row"><span>Provider</span><strong class="health-value">${esc(snapshot.provider)}</strong></div><div class="health-row"><span>Endpoint</span><strong class="health-value">TOKEN BOOSTS</strong></div></section><section class="card settings-card"><h3>Engine defaults</h3><p>Current policy values used by the server-side scan and paper trading engine.</p><div class="health-row"><span>Automatic scan</span><strong class="health-value health-ok">30 seconds</strong></div><div class="health-row"><span>Paper buy size</span><strong class="health-value health-muted">$100 fixed</strong></div><div class="health-row"><span>Virtual starting capital</span><strong class="health-value health-muted">$100,000</strong></div><div class="health-row"><span>Real funds connected</span><strong class="health-value health-ok">NO</strong></div></section><section class="card settings-card"><h3>Provider coverage</h3><p>DexScreener token-boost responses provide metadata. RPC/indexed holders, social intelligence, pair prices, and deep historical data require additional provider coverage.</p><div class="health-row"><span>Market / price</span><strong class="health-value health-warn">UNKNOWN WHEN MISSING</strong></div><div class="health-row"><span>Social metadata</span><strong class="health-value health-ok">PROVIDER REPORTED</strong></div><div class="health-row"><span>Whale volume</span><strong class="health-value health-warn">UNKNOWN WHEN MISSING</strong></div></section><section class="card settings-card"><h3>Safety boundary</h3><p>Solana 20× Radar is analytics and paper trading only. It never requests seed phrases, private keys, wallet signing, or real transactions.</p><span class="badge badge-blue">VIRTUAL FUNDS ONLY</span></section></div>`;
}
function formatDate(value) { if (!value) return "—"; return new Date(value).toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" }); }
function render() {
  if (!snapshot) return;
  const pages = {
    dashboard,
    radar,
    "new-tokens": newTokens,
    whales,
    "smart-money": smartMoney,
    watchlist,
    portfolio,
    trades,
    alerts,
    patterns,
    backtest,
    model: modelIntelligence,
    "token-search": tokenSearch,
    settings,
    health
  };
  layout((pages[activePage] || dashboard)());
}
async function refresh() { if (refreshInFlight) return; refreshInFlight = true; try { const previous = snapshot; const next = await api("/api/state"); if (previous) { const known = new Set(previous.alerts.map(alert => `${alert.type}|${alert.token}|${alert.text}`)); next.alerts.filter(alert => !known.has(`${alert.type}|${alert.token}|${alert.text}`)).slice(0, 3).forEach(alert => toast(`Potential token: ${alert.token} · ${alert.text}`, false)); } snapshot = next; if (selectedToken) await showToken(selectedToken.mint, false); else render(); } finally { refreshInFlight = false; } }
function go(page) { selectedToken = null; activePage = page; window.location.hash = page; render(); }
async function scan() { toast("Scan started · checking provider and recalculating signals."); try { const result = await api("/api/scan", { method:"POST", body:"{}" }); if (!result.ok) throw new Error(result.message); toast(`Scan complete · ${result.tokens} token records updated.`); await refresh(); } catch (error) { toast(error.message, true); await refresh(); } }
async function showToken(id) { const tokenId = decodeURIComponent(id); const data = await api(`/api/tokens/${encodeURIComponent(tokenId)}`); selectedToken = data.token; const t = selectedToken; const watch = snapshot.watchlist.includes(t.mint); layout(head("Token intelligence", `${esc(t.symbol)} / ${esc(t.name)}`, "Evidence-first profile. Scores stay separate from confidence, and unavailable fields remain explicit.", `<button class="btn btn-primary" onclick="trade('${encodeURIComponent(t.mint)}','BUY')">Paper buy $100</button>`) + `<div class="token-detail"><section class="card detail-hero"><div class="detail-heading"><div class="big-token"><div class="big-logo">${esc(t.symbol.slice(0,2))}</div><div><h2>${esc(t.symbol)}</h2><p>${esc(t.name)} · ${esc(t.mint)}</p></div></div><div class="score-hero"><strong>${t.radar ?? "?"}</strong><span>Radar score</span></div></div><div class="detail-stats"><div class="detail-stat"><label>Opportunity</label><strong>${t.opportunity ?? "UNKNOWN"}</strong></div><div class="detail-stat"><label>Smart money</label><strong>${t.smartMoney ?? "UNKNOWN"}</strong></div><div class="detail-stat"><label>Confidence</label><strong>${t.confidence ?? "UNKNOWN"}${t.confidence != null ? "%" : ""}</strong></div><div class="detail-stat"><label>Risk</label><strong class="${t.risk > 55 ? "negative":""}">${t.risk ?? "UNKNOWN"}</strong></div><div class="detail-stat"><label>Market cap</label><strong>${compact(t.marketCap)}</strong></div><div class="detail-stat"><label>Liquidity</label><strong>${compact(t.liquidity)}</strong></div><div class="detail-stat"><label>Holders</label><strong>${t.details.holders?.toLocaleString() || "UNKNOWN"}</strong></div><div class="detail-stat"><label>Potential</label><strong>${esc(t.potential)}</strong></div></div><div class="chart"><svg viewBox="0 0 500 90" preserveAspectRatio="none"><defs><linearGradient id="fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#2f6fed" stop-opacity=".18"/><stop offset="1" stop-color="#2f6fed" stop-opacity="0"/></linearGradient></defs><path class="chart-grid" d="M0 20H500M0 45H500M0 70H500"/><path class="chart-area" d="M0 70 L40 63 L75 67 L112 45 L145 52 L183 32 L220 39 L258 21 L302 30 L341 18 L380 28 L420 13 L460 20 L500 8 L500 90 L0 90Z"/><path class="chart-line" d="M0 70 L40 63 L75 67 L112 45 L145 52 L183 32 L220 39 L258 21 L302 30 L341 18 L380 28 L420 13 L460 20 L500 8"/></svg></div><div class="data-note" style="margin:16px -22px -22px">Data quality ${t.dataQuality ?? "UNKNOWN"} · social coverage ${esc(t.details.social)} · status ${statusBadge(t)}</div></section><section class="card evidence"><h3>Why this score?</h3><ul>${t.details.evidence.map(e => `<li>${esc(e)}</li>`).join("")}</ul><h3 style="margin-top:26px">Token security</h3><div class="health-row"><span>Mint authority</span><strong class="health-value">${esc(t.details.authorities.mint)}</strong></div><div class="health-row"><span>Freeze authority</span><strong class="health-value">${esc(t.details.authorities.freeze)}</strong></div><div class="health-row"><span>Metadata authority</span><strong class="health-value health-warn">${esc(t.details.authorities.metadata)}</strong></div><div class="health-row"><span>Pattern match</span><strong class="health-value health-ok">${t.details.patternMatch ?? "UNKNOWN"}%</strong></div><button class="btn ${watch ? "btn-danger":"btn-quiet"}" style="margin-top:18px;width:100%" onclick="toggleWatch('${encodeURIComponent(t.mint)}')">${watch ? "Remove from active watchlist" : "☆ Add to permanent watchlist"}</button></section></div>`); }
async function showToken(id, reload = true) {
  const tokenId = decodeURIComponent(id);
  const data = reload ? await api(`/api/tokens/${encodeURIComponent(tokenId)}`) : { token: snapshot.tokens.find(item => item.mint === tokenId) };
  if (!data.token) { toast("Token is no longer present in the latest filtered provider data.", true); selectedToken = null; render(); return; }
  selectedToken = data.token;
  const t = selectedToken;
  const pnl = tokenPnl(t);
  const evidence = t.details?.evidence || [];
  const security = t.details?.security || {};
  const holderPercent = security.topHolderPercent == null ? "UNKNOWN" : `${Number(security.topHolderPercent).toFixed(2)}%`;
  layout(head("Token intelligence", `${esc(t.symbol)} / ${esc(t.name)}`, "Filtered LIVE token profile with security verification, provider evidence, and virtual P/L.", tokenActions(t)) +
    `<div class="token-detail"><section class="card detail-hero"><div class="detail-heading"><div class="big-token">${tokenLogo(t, true)}<div><h2>${esc(t.symbol)}</h2><p>${esc(t.name)} · ${esc(t.mint)}</p></div></div><div class="score-hero"><strong>${t.radar ?? "?"}</strong><span>Radar score</span></div></div><div class="detail-stats"><div class="detail-stat"><label>Opportunity</label><strong>${t.opportunity ?? "UNKNOWN"}</strong></div><div class="detail-stat"><label>Smart money</label><strong>${t.smartMoney ?? "UNKNOWN"}</strong></div><div class="detail-stat"><label>Confidence</label><strong>${t.confidence ?? "UNKNOWN"}${t.confidence != null ? "%" : ""}</strong></div><div class="detail-stat"><label>Risk</label><strong class="${t.risk > 55 ? "negative" : ""}">${t.risk ?? "UNKNOWN"}</strong></div><div class="detail-stat"><label>Market cap</label><strong>${compact(t.marketCap)}</strong></div><div class="detail-stat"><label>Liquidity</label><strong>${compact(t.liquidity)}</strong></div><div class="detail-stat"><label>Price</label><strong>${esc(t.price)}</strong></div><div class="detail-stat"><label>P/L</label><strong class="${pnl.className}">${pnl.text}</strong></div></div><div class="data-note">Security: ${esc(security.status || "UNKNOWN")} · Largest holder: ${holderPercent} · ${statusBadge(t)}</div></section><section class="card evidence"><h3>Radar review</h3><p class="review-copy">${esc(t.rationale || "No provider-backed review is available.")}</p><h3>Security checks</h3><div class="health-row"><span>Mint authority</span><strong class="health-value health-ok">${esc(t.details?.authorities?.mint)}</strong></div><div class="health-row"><span>Freeze authority</span><strong class="health-value health-ok">${esc(t.details?.authorities?.freeze)}</strong></div><div class="health-row"><span>Largest holder</span><strong class="health-value ${security.topHolderPercent > 80 ? "health-warn" : "health-ok"}">${holderPercent}</strong></div><h3 style="margin-top:26px">Provider evidence</h3><ul>${evidence.map(item => `<li>${esc(item)}</li>`).join("") || "<li>No evidence supplied by the provider.</li>"}</ul><button class="btn btn-quiet" style="margin-top:18px;width:100%" onclick="go('radar')">Back to Radar</button></section></div>`);
}
function detailNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function detailMoney(value, digits = 2) {
  const number = detailNumber(value);
  return number == null ? "UNKNOWN" : money(number, digits);
}
function detailCount(value) {
  const number = detailNumber(value);
  return number == null ? "UNKNOWN" : number.toLocaleString("en-US", { maximumFractionDigits: 2 });
}
function detailPercent(value) {
  const number = detailNumber(value);
  return number == null ? "UNKNOWN" : `${number >= 0 ? "+" : ""}${number.toFixed(2)}%`;
}
function providerLinkLabel(link) {
  const type = String(link?.type || link?.label || "Link").toLowerCase();
  if (type.includes("twitter") || type === "x") return "𝕏 Twitter";
  if (type.includes("telegram")) return "◈ Telegram";
  if (type.includes("discord")) return "◉ Discord";
  if (type.includes("website") || type.includes("web")) return "◉ Website";
  return link?.label || "Open link";
}
function externalLinks(links, emptyText = "No external links supplied by DexScreener.") {
  const safeLinks = (Array.isArray(links) ? links : []).filter(link => safeHttpUrl(link?.url));
  if (!safeLinks.length) return `<span class="detail-muted">${emptyText}</span>`;
  return safeLinks.map(link => `<a class="provider-link" href="${esc(safeHttpUrl(link.url))}" target="_blank" rel="noopener noreferrer">${esc(providerLinkLabel(link))} ↗</a>`).join("");
}
function detailStat(label, value, className = "") {
  return `<div class="detail-stat ${className}"><label>${esc(label)}</label><strong>${value}</strong></div>`;
}
async function showToken(id, reload = true) {
  const tokenId = decodeURIComponent(id);
  const data = reload ? await api(`/api/tokens/${encodeURIComponent(tokenId)}`) : { token: snapshot.tokens.find(item => item.mint === tokenId) };
  if (!data.token) {
    toast("Token is no longer present in the latest filtered provider data.", true);
    selectedToken = null;
    render();
    return;
  }
  selectedToken = data.token;
  const t = selectedToken;
  const details = t.details || {};
  const metadata = details.providerMetadata || {};
  const profile = details.profile || {};
  const pair = details.pair || {};
  const pairChanges = pair.priceChange || {};
  const pairVolume = pair.volume || {};
  const pairTxns = pair.txns || {};
  const security = details.security || {};
  const pnl = tokenPnl(t);
  const holderPercent = security.topHolderPercent == null ? "UNKNOWN" : `${Number(security.topHolderPercent).toFixed(2)}%`;
  const headerUrl = safeHttpUrl(profile.headerUrl || metadata.header);
  const profileDescription = profile.description || metadata.description || `${t.name} profile data was not supplied by DexScreener.`;
  const links = [...(profile.websites || []), ...(profile.socials || [])];
  const quote = pair.quoteToken?.symbol || pair.quoteToken?.name || "UNKNOWN";
  const pairCreated = pair.pairCreatedAt ? new Date(pair.pairCreatedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "UNKNOWN";
  const securityReasons = Array.isArray(security.reasons) && security.reasons.length ? security.reasons : ["No additional security explanation was supplied."];
  const marketStats = [
    detailStat("Price USD", esc(t.price)),
    detailStat("Liquidity", compact(t.liquidity)),
    detailStat("FDV", detailMoney(pair.fdv, 0)),
    detailStat("Market cap", compact(t.marketCap)),
    detailStat("5m", detailPercent(pairChanges.m5)),
    detailStat("1h", detailPercent(pairChanges.h1)),
    detailStat("6h", detailPercent(pairChanges.h6)),
    detailStat("24h", detailPercent(pairChanges.h24), Number(pairChanges.h24) >= 0 ? "positive" : "negative"),
    detailStat("Volume 24h", detailMoney(pairVolume.h24, 0)),
    detailStat("Transactions 24h", detailCount((pairTxns.h24?.buys || 0) + (pairTxns.h24?.sells || 0))),
    detailStat("Buys / sells", `${detailCount(pairTxns.h24?.buys)} / ${detailCount(pairTxns.h24?.sells)}`),
    detailStat("Traders", detailCount(pair.makers?.h24))
  ].join("");
  layout(head("Token intelligence", `${esc(t.symbol)} / ${esc(t.name)}`, "DexScreener LIVE identity, market profile, external links, pair data, and independent Solana security checks.", tokenActions(t)) +
    `<div class="token-detail token-profile-detail">
      <section class="card detail-hero token-main-card">
        ${headerUrl ? `<div class="detail-banner"><img src="${esc(headerUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer"><span>DEXSCREENER PROFILE</span></div>` : ""}
        <div class="detail-heading">
          <div class="big-token">${tokenLogo(t, true)}<div><h2>${esc(t.name)} <span class="token-symbol">${esc(t.symbol)}</span></h2><p class="token-mint">${esc(t.mint)}</p></div></div>
          <div class="score-hero"><strong>${t.radar ?? "?"}</strong><span>Radar score</span></div>
        </div>
        <div class="token-link-row">${externalLinks(links)}</div>
        <div class="detail-section-title"><span>Live market data</span><small>DexScreener · refreshed every 30s</small></div>
        <div class="detail-stats market-stats">${marketStats}</div>
        <div class="detail-section-title"><span>Project profile</span><small>${esc(metadata.providerUpdatedAt ? `Provider update ${new Date(metadata.providerUpdatedAt).toLocaleString()}` : "Provider timestamp unavailable")}</small></div>
        <p class="token-description">${esc(profileDescription)}</p>
        <div class="profile-meta"><span>Base token <strong>${esc(pair.baseToken?.symbol || t.symbol)}</strong></span><span>Quote token <strong>${esc(quote)}</strong></span><span>DEX <strong>${esc(pair.dexId || "UNKNOWN")}</strong></span><span>Pair created <strong>${esc(pairCreated)}</strong></span></div>
        ${pair.url ? `<a class="pair-link" href="${esc(safeHttpUrl(pair.url))}" target="_blank" rel="noopener noreferrer">Open live pair on DexScreener ↗</a>` : ""}
      </section>
      <aside class="card evidence token-side-card">
        <div class="side-card-heading"><div><h3>Security verification</h3><span>Independent Solana RPC checks</span></div><span class="security-status ${security.verified ? "verified" : "rejected"}">${esc(security.status || "UNKNOWN")}</span></div>
        <div class="health-row"><span>Mint authority</span><strong class="health-value ${security.authorities?.mint === "RENOUNCED" ? "health-ok" : "health-warn"}">${esc(security.authorities?.mint || "UNKNOWN")}</strong></div>
        <div class="health-row"><span>Freeze authority</span><strong class="health-value ${security.authorities?.freeze === "RENOUNCED" ? "health-ok" : "health-warn"}">${esc(security.authorities?.freeze || "UNKNOWN")}</strong></div>
        <div class="health-row"><span>Largest holder</span><strong class="health-value ${security.topHolderPercent > 80 ? "health-warn" : "health-ok"}">${holderPercent}</strong></div>
        <div class="health-row"><span>Holder accounts checked</span><strong class="health-value">${security.holders ?? "UNKNOWN"}</strong></div>
        <ul class="security-reasons">${securityReasons.map(reason => `<li>${esc(reason)}</li>`).join("")}</ul>
        <div class="side-divider"></div>
        <div class="side-card-heading"><div><h3>Pair identity</h3><span>Selected by highest live liquidity</span></div></div>
        <div class="pair-identity"><span>Pair address</span><code>${esc(pair.address || "UNKNOWN")}</code></div>
        <div class="pair-identity"><span>Mint address</span><code>${esc(t.mint)}</code></div>
        <div class="pair-identity"><span>Provider status</span><strong>${statusBadge(t)}</strong></div>
        <div class="side-divider"></div>
        <div class="side-card-heading"><div><h3>Radar review</h3><span>Evidence, not a guarantee</span></div></div>
        <p class="review-copy">${esc(t.rationale || "No provider-backed review is available.")}</p>
        <button class="btn ${snapshot.watchlist.includes(t.mint) ? "btn-danger" : "btn-quiet"}" style="width:100%" onclick="toggleWatch('${encodeURIComponent(t.mint)}')">${snapshot.watchlist.includes(t.mint) ? "Remove from active watchlist" : "☆ Add to permanent watchlist"}</button>
      </aside>
    </div>`);
}
async function toggleWatch(id) { const item = snapshot.watchlist.includes(decodeURIComponent(id)); try { await api(`/api/watchlist/${id}`, { method: item ? "DELETE":"POST" }); toast(item ? "Removed from active view; history preserved." : "Added to permanent watchlist."); await refresh(); } catch(e) { toast(e.message,true); } }
async function removeWatch(id) { try { await api(`/api/watchlist/${id}`, { method:"DELETE" }); toast("Removed from active view; historical record preserved."); await refresh(); } catch(e){toast(e.message,true);} }
async function trade(id, side) { try { const result = await api("/api/trades", { method:"POST", body:JSON.stringify({ mint: decodeURIComponent(id), side }) }); if (!result.ok) throw new Error(result.error); toast(`${side === "BUY" ? "Paper buy":"Paper sell"} recorded at the latest available price.`); snapshot = result.state; if (selectedToken) await showToken(selectedToken.mint, false); else render(); } catch(e) { toast(e.message,true); } }
async function analyzePatterns() { try { const result = await api("/api/analysis", { method:"POST", body:"{}" }); snapshot = result.state; toast(`Analysis complete · ${result.patterns} evidence patterns updated.`); render(); } catch (error) { toast(error.message, true); } }
function setTokenSearch(value) { tokenSearchQuery = value; if (activePage === "token-search") render(); }
const hashPage = window.location.hash.slice(1);
if (NAV.some(([id]) => id === hashPage)) activePage = hashPage;
window.addEventListener("hashchange", () => {
  const page = window.location.hash.slice(1);
  if (NAV.some(([id]) => id === page)) { activePage = page; render(); }
});
window.go=go; window.scan=scan; window.showToken=showToken; window.toggleWatch=toggleWatch; window.removeWatch=removeWatch; window.trade=trade; window.setWhaleRange=setWhaleRange; window.setRadarSort=setRadarSort; window.setRadarStatus=setRadarStatus; window.analyzePatterns=analyzePatterns; window.setTokenSearch=setTokenSearch;
refresh().catch(error => { app.innerHTML = `<div class="empty" style="margin:40px"><strong>Unable to load radar</strong>${esc(error.message)}</div>`; });
setInterval(() => {
  const label = document.querySelector("#next-scan-label");
  if (label && snapshot) label.textContent = nextScanLabel();
}, 1000);
setInterval(() => {
  if (!document.hidden) refresh().catch(() => {});
}, 5000);