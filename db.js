const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();
const LIVE_ONLY_MIGRATION = "liveOnlyInitialized";

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

function toDate(value) {
  if (value instanceof Date) return value;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value);
  if (typeof value === "string" && /^\d{10,}$/.test(value.trim())) return new Date(Number(value));
  return new Date(value);
}

async function seedState(state) {
  await prisma.$transaction(async tx => {
    await tx.radarState.upsert({
      where: { id: 1 },
      update: {
        mode: state.mode,
        provider: state.provider,
        lastScan: state.lastScan ? new Date(state.lastScan) : null,
        nextScanAt: state.nextScanAt ? new Date(state.nextScanAt) : null,
        scanRunning: false,
        watchlistHistory: state.watchlistHistory || [],
        system: state.system || {}
      },
      create: {
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
    for (const item of state.tokens || []) {
      const created = await tx.token.upsert({ where: { mint: item.mint }, update: tokenData(item), create: tokenData(item) });
      tokens.set(item.mint, created.id);
    }

    for (const mint of state.watchlist || []) {
      const tokenId = tokens.get(mint);
      if (tokenId) await tx.watchlistEntry.upsert({ where: { tokenId }, update: { active: true }, create: { tokenId, active: true } });
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
    await tx.paperAccount.upsert({
      where: { id: 1 },
      update: {
        starting: portfolio.starting,
        cash: portfolio.cash,
        realized: portfolio.realized,
        fees: portfolio.fees,
        trades: portfolio.trades
      },
      create: {
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

async function ensureLiveOnly() {
  const radar = await prisma.radarState.findUnique({ where: { id: 1 } });
  if (!radar) return;
  const currentSystem = radar.system && typeof radar.system === "object" && !Array.isArray(radar.system) ? radar.system : {};
  if (currentSystem[LIVE_ONLY_MIGRATION] === true && radar.mode === "live" && radar.provider === "DexScreener") return;

  await prisma.$transaction(async tx => {
    await tx.watchlistEvent.deleteMany({});
    await tx.watchlistEntry.deleteMany({});
    await tx.paperPosition.deleteMany({ where: { accountId: 1 } });
    await tx.paperTrade.deleteMany({ where: { accountId: 1 } });
    await tx.token.deleteMany({ where: { providerUrl: null } });
    await tx.whaleActivityPoint.deleteMany({ where: { source: { not: "live" } } });
    await tx.alert.deleteMany({});
    await tx.pattern.deleteMany({});
    await tx.scanRun.deleteMany({});
    await tx.paperAccount.upsert({
      where: { id: 1 },
      update: { starting: 100000, cash: 100000, realized: 0, fees: 0, trades: 0 },
      create: { id: 1, starting: 100000, cash: 100000, realized: 0, fees: 0, trades: 0 }
    });
    await tx.radarState.update({
      where: { id: 1 },
      data: {
        mode: "live",
        provider: "DexScreener",
        lastScan: null,
        nextScanAt: new Date(Date.now() + 15000),
        scanRunning: false,
        watchlistHistory: [],
        system: {
          scheduler: "RUNNING · 15s",
          worker: "READY",
          database: "POSTGRESQL / PRISMA",
          rpc: "LIVE PROVIDER",
          market: "LIVE PROVIDER",
          lastScanStatus: "NOT RUN YET",
          avgDuration: "—",
          tokensPerScan: 0,
          transactionsPerScan: 0,
          errors: 0,
          [LIVE_ONLY_MIGRATION]: true
        }
      }
    });
  });
}

async function readState(fallback) {
  let radar = await prisma.radarState.findUnique({ where: { id: 1 } });
  if (!radar) {
    await seedState(fallback);
  }
  await ensureLiveOnly();
  await ensureScanLease();
  await reconcileInterruptedScans();
  radar = await prisma.radarState.findUnique({ where: { id: 1 } });

  const tokenFilter = { providerUrl: { not: null } };
  const [dbTokens, activeWatchlist, events, alerts, patterns, account, whalePoints, scanRuns] = await Promise.all([
    prisma.token.findMany({ where: tokenFilter, orderBy: [{ radar: "desc" }, { updatedAt: "desc" }] }),
    prisma.watchlistEntry.findMany({ where: { active: true, token: tokenFilter }, include: { token: true } }),
    prisma.watchlistEvent.findMany({ include: { token: true }, orderBy: { createdAt: "asc" } }),
    prisma.alert.findMany({ orderBy: { createdAt: "desc" }, take: 20 }),
    prisma.pattern.findMany({ orderBy: { match: "desc" } }),
    prisma.paperAccount.findUnique({ where: { id: 1 }, include: { positions: { include: { token: true } }, history: { orderBy: { time: "desc" }, take: 100 } } }),
    prisma.whaleActivityPoint.findMany({ where: { source: "live" }, orderBy: { recordedAt: "asc" }, take: 96 }),
    prisma.scanRun.findMany({ orderBy: { startedAt: "desc" }, take: 100 })
  ]);

  const tokens = dbTokens.filter(token => token.details?.security?.verified === true);
  const safeMints = new Set(tokens.map(token => token.mint));
  const activityRows = whalePoints;

  const dbPortfolio = account ? {
    starting: account.starting,
    cash: account.cash,
    realized: account.realized,
    fees: account.fees,
    trades: account.trades,
    positions: account.positions.filter(position => safeMints.has(position.token.mint)).map(position => ({
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
    mode: "live",
    provider: "DexScreener",
    lastScan: radar.lastScan?.toISOString() || null,
    nextScanAt: radar.nextScanAt?.getTime() || Date.now() + 15000,
    scanRunning: false,
    tokens: tokens.map(fromToken),
    watchlist: activeWatchlist.filter(item => safeMints.has(item.token.mint)).map(item => item.token.mint),
    watchlistHistory: events.filter(event => safeMints.has(event.token.mint)).map(event => ({ mint: event.token.mint, action: event.action, at: event.createdAt.toISOString() })),
    alerts: alerts.map(alert => ({ type: alert.type, token: alert.token, text: alert.text, tone: alert.tone, time: alert.timeLabel || alert.createdAt.toISOString() })),
    patterns: patterns.map(pattern => ({ id: pattern.patternId, name: pattern.name, desc: pattern.detail, match: pattern.match, sample: pattern.sample, outcome: pattern.outcome, tone: pattern.tone })),
    whaleActivity: activityRows.map(fromWhalePoint),
    scanRuns: scanRuns.map(run => ({
      id: run.id,
      manual: run.manual,
      status: run.status,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() || null,
      durationMs: run.durationMs,
      tokensScanned: run.tokensScanned,
      transactionsProcessed: run.transactionsProcessed,
      errorCount: run.errorCount,
      recordsChecked: run.recordsChecked,
      acceptedCount: run.acceptedCount,
      rejectedCount: run.rejectedCount,
      unresolvedCount: run.unresolvedCount,
      rejectionReasons: run.rejectionReasons || [],
      filterConfig: run.filterConfig || null,
      providerAgeMs: run.providerAgeMs,
      providerRecords: run.providerRecords,
      pairRequests: run.pairRequests,
      pairFailures: run.pairFailures,
      rpcStatus: run.rpcStatus,
      qualityStatus: run.qualityStatus,
      discoveryUniverseSize: run.discoveryUniverseSize,
      providerRecordsWithPair: run.providerRecordsWithPair,
      providerRecordsWithPrice: run.providerRecordsWithPrice,
      providerRecordsWithLiquidity: run.providerRecordsWithLiquidity,
      securityVerified: run.securityVerified,
      securityUnknown: run.securityUnknown,
      securityRejected: run.securityRejected,
      liquidityRejected: run.liquidityRejected,
      momentumRejected: run.momentumRejected,
      ctoRejected: run.ctoRejected,
      tokensPersisted: run.tokensPersisted,
      providerFreshnessMs: run.providerFreshnessMs,
      rpcFreshnessMs: run.rpcFreshnessMs,
      rpcCommitment: run.rpcCommitment,
      timedOut: run.timedOut,
      timeoutReason: run.timeoutReason,
      decisionVersion: run.decisionVersion,
      correlationId: run.correlationId,
      requestId: run.requestId,
      idempotencyKey: run.idempotencyKey,
      sourceMetrics: run.sourceMetrics || null,
      provider: run.provider
    })),
    portfolio: dbPortfolio,
    system: { ...(fallback.system || {}), ...(radar.system || {}), database: "POSTGRESQL / PRISMA" }
  };
}

async function persistState(state, mutation = {}) {
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

    if (mutation.watchlistEvent) {
      const item = await tx.token.findUnique({ where: { mint: mutation.watchlistEvent.mint } });
      if (item) {
        await tx.watchlistEvent.create({
          data: { tokenId: item.id, action: mutation.watchlistEvent.action }
        });
      }
    }

    if (mutation.tradeRecord) {
      const trade = mutation.tradeRecord;
      const item = await tx.token.findUnique({ where: { mint: trade.mint } });
      await tx.paperTrade.create({
        data: {
          accountId: 1,
          tokenId: item?.id || null,
          symbol: trade.symbol,
          side: trade.side,
          amount: trade.amount,
          price: trade.price,
          fee: trade.fee || 0,
          score: trade.score,
          idempotencyKey: trade.idempotencyKey || null,
          idempotencyFingerprint: trade.idempotencyFingerprint || null,
          time: new Date(trade.time)
        }
      });
    }

    if (mutation.scanRun) {
      await tx.scanRun.update({
        where: { id: mutation.scanRun.id },
        data: mutation.scanRun.data
      });
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

async function recordAlert(alert) {
  return prisma.alert.create({
    data: {
      type: alert.type,
      token: alert.token,
      text: alert.text,
      tone: alert.tone,
      timeLabel: alert.time
    }
  });
}

async function recordAlertsAtomic(alerts) {
  if (!Array.isArray(alerts) || !alerts.length) return [];
  return prisma.$transaction(async tx => {
    const created = [];
    for (const alert of alerts) {
      const row = await tx.alert.create({
        data: {
          type: alert.type,
          token: alert.token,
          text: alert.text,
          tone: alert.tone,
          timeLabel: alert.time
        }
      });
      await tx.alertOutbox.create({
        data: {
          alertId: row.id,
          eventType: "ALERT_CREATED",
          payload: alert
        }
      });
      created.push(row);
    }
    return created;
  });
}
async function createScanRun(data) {
  return prisma.scanRun.create({ data });
}

async function finishScanRun(id, data) {
  return prisma.scanRun.update({ where: { id }, data });
}

async function ensureScanLease() {
  return prisma.scanLease.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1, owner: "", expiresAt: new Date(0) }
  });
}

async function ensureMutationLease() {
  return prisma.mutationLease.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1, owner: "", expiresAt: new Date(0) }
  });
}

async function acquireMutationLease(owner, ttlMs = 15_000) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);
  await ensureMutationLease();
  const updated = await prisma.mutationLease.updateMany({
    where: {
      id: 1,
      OR: [{ owner }, { expiresAt: { lt: now } }]
    },
    data: { owner, acquiredAt: now, expiresAt }
  });
  return updated.count === 1;
}

async function releaseMutationLease(owner) {
  await prisma.mutationLease.updateMany({
    where: { id: 1, owner },
    data: { owner: "", acquiredAt: null, expiresAt: new Date(0) }
  });
}

async function acquireScanLease(owner, ttlMs = 30_000) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);
  await ensureScanLease();
  const updated = await prisma.scanLease.updateMany({
    where: {
      id: 1,
      OR: [{ owner }, { expiresAt: { lt: now } }]
    },
    data: { owner, acquiredAt: now, expiresAt }
  });
  if (updated.count === 1) {
    await prisma.scanRun.updateMany({
      where: { status: "RUNNING" },
      data: {
        status: "INTERRUPTED",
        finishedAt: now,
        qualityStatus: "FAILED",
        errorCount: 1,
        timeoutReason: "lease_expired"
      }
    });
  }
  return updated.count === 1;
}

async function releaseScanLease(owner) {
  await prisma.scanLease.updateMany({
    where: { id: 1, owner },
    data: { owner: "", acquiredAt: null, expiresAt: new Date(0) }
  });
}

async function reconcileInterruptedScans() {
  const finishedAt = new Date();
  const lease = await prisma.scanLease.findUnique({ where: { id: 1 } });
  if (lease?.owner && lease.expiresAt > finishedAt) {
    return { interrupted: 0, active: true };
  }
  await prisma.scanRun.updateMany({
    where: { status: "RUNNING" },
    data: {
      status: "INTERRUPTED",
      finishedAt,
      qualityStatus: "FAILED",
      errorCount: 1,
      timeoutReason: "process_restart"
    }
  });
  await prisma.scanLease.updateMany({
    where: { id: 1 },
    data: { owner: "", acquiredAt: null, expiresAt: new Date(0) }
  });
  return { interrupted: true, active: false };
}

async function recordSkippedScan({ manual = true, provider, correlationId, requestId, idempotencyKey, idempotencyFingerprint, reason }) {
  try {
    return await prisma.scanRun.create({
      data: {
        manual,
        status: "SKIPPED",
        startedAt: new Date(),
        finishedAt: new Date(),
        provider,
        correlationId,
        requestId,
        idempotencyKey,
        idempotencyFingerprint: idempotencyFingerprint || null,
        qualityStatus: "SKIPPED",
        timeoutReason: reason
      }
    });
  } catch (error) {
    if (error.code === "P2002" && idempotencyKey) {
      return findScanByIdempotencyKey(idempotencyKey);
    }
    throw error;
  }
}

async function findScanByIdempotencyKey(idempotencyKey) {
  if (!idempotencyKey) return null;
  return prisma.scanRun.findUnique({ where: { idempotencyKey } });
}

async function findTradeByIdempotencyKey(idempotencyKey) {
  if (!idempotencyKey) return null;
  return prisma.paperTrade.findUnique({ where: { idempotencyKey } });
}

async function recordTokenObservations(observations, scanRunId) {
  if (!Array.isArray(observations) || !observations.length) return;
  await prisma.tokenObservation.createMany({
    data: observations.map(observation => ({
      ...observation,
      scanRunId: scanRunId || null,
      observedAt: toDate(observation.observedAt),
      providerUpdatedAt: observation.providerUpdatedAt ? toDate(observation.providerUpdatedAt) : null,
      pairCreatedAt: observation.pairCreatedAt ? toDate(observation.pairCreatedAt) : null,
      accountTaxonomy: observation.accountTaxonomy || null,
      poolEvidence: observation.poolEvidence || null,
      concentration: observation.concentration || null
    }))
  });
}

function reactivationReason(observation) {
  const reasons = Array.isArray(observation?.qualityReasons) ? observation.qualityReasons : [];
  return reasons.slice(0, 4).join(" · ") || "No decision reason recorded";
}

function reactivationPoint(observation) {
  return {
    at: observation.observedAt.toISOString(),
    status: observation.decisionOutcome || "UNKNOWN",
    decisionVersion: observation.decisionVersion || "UNKNOWN",
    source: observation.source,
    dataQuality: observation.dataQuality,
    pairAddress: observation.pairAddress,
    priceUsd: observation.priceUsd,
    marketCap: observation.marketCap,
    liquidityUsd: observation.liquidityUsd,
    priceChange: observation.priceChange,
    reason: reactivationReason(observation),
    responseHash: observation.sourceResponseHash,
    scanRunId: observation.scanRunId
  };
}

async function readTokenHistory(mint) {
  const observations = await prisma.tokenObservation.findMany({
    where: { mint },
    orderBy: { observedAt: "desc" },
    take: 100
  });
  return observations.map(reactivationPoint);
}

async function readReactivationHistory() {
  const tokens = (await prisma.token.findMany({ where: { providerUrl: { not: null } } }))
    .filter(token => token.details?.security?.verified === true);
  const acceptedMints = tokens.map(token => token.mint);
  const observations = acceptedMints.length
    ? await prisma.tokenObservation.findMany({
      where: { mint: { in: acceptedMints } },
      orderBy: { observedAt: "desc" }
    })
    : [];
  const tokenByMint = new Map(tokens.map(token => [token.mint, token]));
  const records = new Map(tokens.map(token => [token.mint, {
    mint: token.mint,
    symbol: token.symbol,
    name: token.name,
    sourceBoards: ["REAL_PROJECT", "SPECULATIVE_MEME"],
    current: {
      status: "PASSED_RADAR",
      providerStatus: token.status,
      price: token.price,
      marketCap: token.marketCap,
      liquidity: token.liquidity,
      updatedAt: token.updatedAt.toISOString()
    },
    firstSeenAt: token.createdAt.toISOString(),
    lastSeenAt: token.updatedAt.toISOString(),
    observationCount: 0,
    statusCounts: {},
    latest: null,
    history: []
  }]));

  for (const observation of observations) {
    const point = reactivationPoint(observation);
    const status = point.status;
    const existing = records.get(observation.mint);
    if (!existing) continue;
    existing.firstSeenAt = new Date(Math.min(new Date(existing.firstSeenAt).getTime(), observation.observedAt.getTime())).toISOString();
    existing.lastSeenAt = new Date(Math.max(new Date(existing.lastSeenAt).getTime(), observation.observedAt.getTime())).toISOString();
    existing.observationCount += 1;
    existing.statusCounts[status] = (existing.statusCounts[status] || 0) + 1;
    if (!existing.latest) existing.latest = point;
    if (existing.history.length < 12) existing.history.push(point);
  }

  return [...records.values()]
    .map(record => ({ ...record, recurrence: record.observationCount > 1 ? "RECURRING" : "FIRST SEEN" }))
    .sort((a, b) => new Date(b.lastSeenAt) - new Date(a.lastSeenAt));
}

async function persistPatterns(patterns) {
  await prisma.$transaction(async tx => {
    const ids = patterns.map(pattern => pattern.id);
    await tx.pattern.deleteMany({ where: { patternId: { notIn: ids } } });
    for (const pattern of patterns) {
      await tx.pattern.upsert({
        where: { patternId: pattern.id },
        update: {
          name: pattern.name,
          detail: pattern.desc,
          match: pattern.match,
          sample: pattern.sample,
          outcome: pattern.outcome,
          tone: pattern.tone
        },
        create: {
          patternId: pattern.id,
          name: pattern.name,
          detail: pattern.desc,
          match: pattern.match,
          sample: pattern.sample,
          outcome: pattern.outcome,
          tone: pattern.tone
        }
      });
    }
  });
}

async function disconnectDb() {
  await prisma.$disconnect();
}

module.exports = {
  prisma,
  readState,
  persistState,
  persistPatterns,
  recordTrade,
  recordWatchlistEvent,
  recordWhaleActivity,
  recordAlert,
  recordAlertsAtomic,
  createScanRun,
  finishScanRun,
  ensureScanLease,
  ensureMutationLease,
  acquireMutationLease,
  releaseMutationLease,
  acquireScanLease,
  releaseScanLease,
  reconcileInterruptedScans,
  recordSkippedScan,
  findScanByIdempotencyKey,
  findTradeByIdempotencyKey,
  recordTokenObservations,
  readTokenHistory,
  readReactivationHistory,
  disconnectDb
};