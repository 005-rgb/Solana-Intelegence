const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

function tokenData(item) {
  return {
    mint: item.mint,
    symbol: item.symbol,
    name: item.name,
    price: item.price,
    marketCap: item.marketCap,
    liquidity: item.liquidity,
    radar: item.radar,
    opportunity: item.opportunity,
    smartMoney: item.smartMoney,
    momentum: item.momentum,
    hype: item.hype,
    risk: item.risk,
    confidence: item.confidence,
    priceChange: item.priceChange,
    whaleFlow: item.whaleFlow,
    holderGrowth: item.holderGrowth,
    status: item.status,
    age: item.age,
    rationale: item.rationale,
    riskLabel: item.riskLabel,
    dataQuality: item.dataQuality,
    potential: item.potential,
    providerUrl: item.providerUrl || null,
    details: item.details || {}
  };
}

function fromToken(row) {
  return {
    mint: row.mint,
    symbol: row.symbol,
    name: row.name,
    price: row.price,
    marketCap: row.marketCap,
    liquidity: row.liquidity,
    radar: row.radar,
    opportunity: row.opportunity,
    smartMoney: row.smartMoney,
    momentum: row.momentum,
    hype: row.hype,
    risk: row.risk,
    confidence: row.confidence,
    priceChange: row.priceChange,
    whaleFlow: row.whaleFlow,
    holderGrowth: row.holderGrowth,
    status: row.status,
    age: row.age,
    rationale: row.rationale,
    riskLabel: row.riskLabel,
    dataQuality: row.dataQuality,
    potential: row.potential,
    providerUrl: row.providerUrl,
    details: row.details,
    updatedAt: row.updatedAt.toISOString()
  };
}

function whalePointData(point) {
  return {
    recordedAt: new Date(point.at),
    buyVolume: point.buyVolume ?? null,
    sellVolume: point.sellVolume ?? null,
    netFlow: point.netFlow ?? null,
    totalVolume: point.totalVolume ?? null,
    source: point.source,
    dataQuality: point.dataQuality ?? null
  };
}

function fromWhalePoint(row) {
  return {
    at: row.recordedAt.toISOString(),
    buyVolume: row.buyVolume,
    sellVolume: row.sellVolume,
    netFlow: row.netFlow,
    totalVolume: row.totalVolume,
    source: row.source,
    dataQuality: row.dataQuality
  };
}

async function seedState(state) {
  await prisma.$transaction(async tx => {
    await tx.radarState.create({
      data: {
        id: 1,
        mode: state.mode,
        provider: state.provider,
        lastScan: state.lastScan ? new Date(state.lastScan) : null,
        nextScanAt: state.nextScanAt ? new Date(state.nextScanAt) : null,
        scanRunning: false,
        watchlistHistory: state.watchlistHistory || [],
        system: state.system || {}
      }
    });
    for (const point of state.whaleActivity || []) {
      await tx.whaleActivityPoint.create({ data: whalePointData(point) });
    }

    const tokens = new Map();
    for (const item of state.tokens) {
      const created = await tx.token.create({ data: tokenData(item) });
      tokens.set(item.mint, created.id);
    }

    for (const mint of state.watchlist || []) {
      const tokenId = tokens.get(mint);
      if (tokenId) await tx.watchlistEntry.create({ data: { tokenId, active: true } });
    }
    for (const event of state.watchlistHistory || []) {
      const tokenId = tokens.get(event.mint);
      if (tokenId) await tx.watchlistEvent.create({ data: { tokenId, action: event.action, createdAt: event.at ? new Date(event.at) : undefined } });
    }
    for (const alert of state.alerts || []) {
      await tx.alert.create({ data: { type: alert.type, token: alert.token, text: alert.text, tone: alert.tone, timeLabel: alert.time } });
    }
    for (const pattern of state.patterns || []) {
      await tx.pattern.create({ data: { patternId: pattern.id, name: pattern.name, detail: pattern.desc, match: pattern.match, sample: pattern.sample, outcome: pattern.outcome, tone: pattern.tone } });
    }

    const portfolio = state.portfolio;
    await tx.paperAccount.create({
      data: {
        id: 1,
        starting: portfolio.starting,
        cash: portfolio.cash,
        realized: portfolio.realized,
        fees: portfolio.fees,
        trades: portfolio.trades
      }
    });
    for (const position of portfolio.positions || []) {
      const tokenId = tokens.get(position.mint);
      if (tokenId) {
        await tx.paperPosition.create({
          data: { accountId: 1, tokenId, invested: position.invested, quantity: position.quantity, entry: position.entry, peakPnl: position.peakPnl, openedAt: new Date(position.openedAt) }
        });
      }
    }
    for (const trade of portfolio.history || []) {
      const tokenId = [...tokens.entries()].find(([mint]) => state.tokens.some(item => item.mint === mint && item.symbol === trade.symbol))?.[1] || null;
      await tx.paperTrade.create({
        data: { accountId: 1, tokenId, symbol: trade.symbol, side: trade.side, amount: trade.amount, price: trade.price, fee: trade.fee || 0, score: trade.score, time: new Date(trade.time) }
      });
    }
  });
}

async function readState(fallback) {
  const radar = await prisma.radarState.findUnique({ where: { id: 1 } });
  if (!radar) {
    await seedState(fallback);
    return fallback;
  }

  const [tokens, activeWatchlist, events, alerts, patterns, account, whalePoints] = await Promise.all([
    prisma.token.findMany({ orderBy: [{ radar: "desc" }, { updatedAt: "desc" }] }),
    prisma.watchlistEntry.findMany({ where: { active: true }, include: { token: true } }),
    prisma.watchlistEvent.findMany({ include: { token: true }, orderBy: { createdAt: "asc" } }),
    prisma.alert.findMany({ orderBy: { createdAt: "desc" }, take: 20 }),
    prisma.pattern.findMany({ orderBy: { match: "desc" } }),
    prisma.paperAccount.findUnique({ where: { id: 1 }, include: { positions: { include: { token: true } }, history: { orderBy: { time: "desc" }, take: 100 } } }),
    prisma.whaleActivityPoint.findMany({ where: { source: radar.mode === "live" ? "live" : "demo" }, orderBy: { recordedAt: "asc" }, take: 96 })
  ]);

  let activityRows = whalePoints;
  if (!activityRows.length && radar.mode === "demo" && fallback.whaleActivity?.length) {
    await prisma.whaleActivityPoint.createMany({ data: fallback.whaleActivity.map(whalePointData) });
    activityRows = await prisma.whaleActivityPoint.findMany({ where: { source: "demo" }, orderBy: { recordedAt: "asc" }, take: 96 });
  }

  const dbPortfolio = account ? {
    starting: account.starting,
    cash: account.cash,
    realized: account.realized,
    fees: account.fees,
    trades: account.trades,
    positions: account.positions.map(position => ({
      mint: position.token.mint,
      symbol: position.token.symbol,
      name: position.token.name,
      invested: position.invested,
      quantity: position.quantity,
      entry: position.entry,
      peakPnl: position.peakPnl,
      openedAt: position.openedAt.getTime()
    })),
    history: account.history.map(trade => ({
      symbol: trade.symbol,
      side: trade.side,
      amount: trade.amount,
      price: trade.price,
      fee: trade.fee,
      score: trade.score,
      time: trade.time.getTime()
    }))
  } : fallback.portfolio;

  return {
    ...fallback,
    mode: radar.mode,
    provider: radar.provider,
    lastScan: radar.lastScan?.toISOString() || null,
    nextScanAt: radar.nextScanAt?.getTime() || Date.now() + 30000,
    scanRunning: false,
    tokens: tokens.map(fromToken),
    watchlist: activeWatchlist.map(item => item.token.mint),
    watchlistHistory: events.map(event => ({ mint: event.token.mint, action: event.action, at: event.createdAt.toISOString() })),
    alerts: alerts.map(alert => ({ type: alert.type, token: alert.token, text: alert.text, tone: alert.tone, time: alert.timeLabel || alert.createdAt.toISOString() })),
    patterns: patterns.map(pattern => ({ id: pattern.patternId, name: pattern.name, desc: pattern.detail, match: pattern.match, sample: pattern.sample, outcome: pattern.outcome, tone: pattern.tone })),
    whaleActivity: activityRows.map(fromWhalePoint),
    portfolio: dbPortfolio,
    system: { ...(fallback.system || {}), ...(radar.system || {}), database: "POSTGRESQL / PRISMA" }
  };
}

async function persistState(state) {
  await prisma.$transaction(async tx => {
    await tx.radarState.upsert({
      where: { id: 1 },
      update: {
        mode: state.mode,
        provider: state.provider,
        lastScan: state.lastScan ? new Date(state.lastScan) : null,
        nextScanAt: state.nextScanAt ? new Date(state.nextScanAt) : null,
        scanRunning: Boolean(state.scanRunning),
        watchlistHistory: state.watchlistHistory || [],
        system: { ...(state.system || {}), database: "POSTGRESQL / PRISMA" }
      },
      create: {
        id: 1,
        mode: state.mode,
        provider: state.provider,
        lastScan: state.lastScan ? new Date(state.lastScan) : null,
        nextScanAt: state.nextScanAt ? new Date(state.nextScanAt) : null,
        scanRunning: Boolean(state.scanRunning),
        watchlistHistory: state.watchlistHistory || [],
        system: { ...(state.system || {}), database: "POSTGRESQL / PRISMA" }
      }
    });

    for (const item of state.tokens) {
      await tx.token.upsert({ where: { mint: item.mint }, update: tokenData(item), create: tokenData(item) });
    }
    const entries = await tx.watchlistEntry.findMany({ include: { token: true } });
    for (const entry of entries) {
      await tx.watchlistEntry.update({ where: { id: entry.id }, data: { active: state.watchlist.includes(entry.token.mint) } });
    }
    for (const mint of state.watchlist) {
      const item = await tx.token.findUnique({ where: { mint } });
      if (item) await tx.watchlistEntry.upsert({ where: { tokenId: item.id }, update: { active: true }, create: { tokenId: item.id, active: true } });
    }

    const portfolio = state.portfolio;
    await tx.paperAccount.upsert({
      where: { id: 1 },
      update: { starting: portfolio.starting, cash: portfolio.cash, realized: portfolio.realized, fees: portfolio.fees, trades: portfolio.trades },
      create: { id: 1, starting: portfolio.starting, cash: portfolio.cash, realized: portfolio.realized, fees: portfolio.fees, trades: portfolio.trades }
    });
    await tx.paperPosition.deleteMany({ where: { accountId: 1 } });
    for (const position of portfolio.positions || []) {
      const item = await tx.token.findUnique({ where: { mint: position.mint } });
      if (item) await tx.paperPosition.create({ data: { accountId: 1, tokenId: item.id, invested: position.invested, quantity: position.quantity, entry: position.entry, peakPnl: position.peakPnl, openedAt: new Date(position.openedAt) } });
    }
  });
}

async function recordTrade(trade) {
  const token = await prisma.token.findUnique({ where: { mint: trade.mint } });
  await prisma.paperTrade.create({
    data: { accountId: 1, tokenId: token?.id || null, symbol: trade.symbol, side: trade.side, amount: trade.amount, price: trade.price, fee: trade.fee || 0, score: trade.score, time: new Date(trade.time) }
  });
}

async function recordWatchlistEvent(mint, action) {
  const token = await prisma.token.findUnique({ where: { mint } });
  if (token) await prisma.watchlistEvent.create({ data: { tokenId: token.id, action } });
}

async function recordWhaleActivity(point) {
  await prisma.whaleActivityPoint.create({ data: whalePointData(point) });
  await prisma.whaleActivityPoint.deleteMany({
    where: { source: point.source, recordedAt: { lt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 30) } }
  });
}

async function createScanRun(data) {
  return prisma.scanRun.create({ data });
}

async function finishScanRun(id, data) {
  return prisma.scanRun.update({ where: { id }, data });
}

async function disconnectDb() {
  await prisma.$disconnect();
}

module.exports = { prisma, readState, persistState, recordTrade, recordWatchlistEvent, recordWhaleActivity, createScanRun, finishScanRun, disconnectDb };