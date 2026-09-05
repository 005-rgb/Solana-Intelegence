# Radar Core System — Phased Precision Plan

**Status:** Proposed implementation blueprint  
**Scope:** Radar core only — discovery, market features, Solana security, scoring, alerts, and outcome measurement  
**Mode:** Paper trading only; no wallet, signing, or real-fund execution  
**Primary objective:** Maximize precision of actionable token candidates while preserving fail-closed security behavior and auditable evidence

---

## 1. Executive decision

The current application is live as a polling monitor, but it is not yet a true scoring Radar.

The current pipeline is:

```text
DexScreener token-boosts/latest/v1
  → latest 10 Solana boosted records
  → highest-liquidity pair per token
  → live pair metrics
  → batched Solana RPC security checks
  → hard filters
  → accepted token list
```

The current hard filters are:

- mint authority is renounced;
- freeze authority is renounced;
- largest token account is at or below 80% of supply;
- price is available;
- liquidity is at least $10,000;
- 24-hour price change is positive;
- DexScreener CTO flag is not true.

The fields named `radar`, `opportunity`, `smartMoney`, `momentum`, `hype`, `risk`, and `confidence` are currently not calculated by a scoring engine. A successful scan therefore proves that the provider and security pipeline worked; it does **not** prove that the selected token has a high probability of a favorable forward outcome.

This plan changes the system in phases. No phase may claim predictive effectiveness until it has outcome data.

---

## 2. Precision principles

These rules are mandatory for every phase:

1. **Security and opportunity are separate.** A safe token is not automatically a good trade candidate.
2. **Unknown is not zero.** Missing data lowers confidence or blocks eligibility; it is never silently converted into a favorable value.
3. **Boost is attention, not quality.** Boost metadata may be a feature but must never be the discovery universe by itself or dominate the score.
4. **A score must have evidence.** Every score component must expose its source, timestamp, freshness, and calculation version.
5. **Hard risk gates precede ranking.** A high momentum score cannot override a failed security gate.
6. **Time-series beats snapshots.** A single 24-hour change is insufficient to infer current momentum.
7. **Precision before recall.** The primary Radar view should show fewer, higher-quality candidates rather than a large noisy list.
8. **No unvalidated prediction language.** Until outcome metrics exist, the UI must call results `candidate`, `upward evidence`, or `watch`, not `likely winner` or `guaranteed`.
9. **Every alert is an experiment.** Alerts need a timestamp, feature snapshot, decision version, and later forward outcome.
10. **Paper trading remains isolated.** Radar research data must not introduce wallets, private keys, signing, or real transactions.

---

## 3. Target architecture

```text
                    ┌────────────────────────┐
                    │  Discovery connectors   │
                    │ Dex pairs, boosts, RPC  │
                    └────────────┬───────────┘
                                 │
                    ┌────────────▼───────────┐
                    │  Canonical observations │
                    │ source + slot + time    │
                    └────────────┬───────────┘
                                 │
                    ┌────────────▼───────────┐
                    │  Data quality / freshness│
                    │ complete, stale, unknown │
                    └────────────┬───────────┘
                                 │
                    ┌────────────▼───────────┐
                    │   Hard risk gates       │
                    │ fail-closed eligibility  │
                    └────────────┬───────────┘
                                 │
                    ┌────────────▼───────────┐
                    │  Feature engineering    │
                    │ momentum, flow, quality │
                    └────────────┬───────────┘
                                 │
                    ┌────────────▼───────────┐
                    │  Deterministic scoring  │
                    │ score + risk + confidence│
                    └────────────┬───────────┘
                                 │
                    ┌────────────▼───────────┐
                    │ Candidate state machine │
                    │ watch → qualify → stale │
                    └────────────┬───────────┘
                                 │
                    ┌────────────▼───────────┐
                    │ Forward outcomes/backtest│
                    │ precision and drawdown  │
                    └────────────────────────┘
```

The existing `server.js` provider and RPC boundaries can remain. The change is to introduce explicit observation, feature, decision, and outcome layers instead of assigning a token directly to the accepted list.

---

## 4. Phase 0 — Freeze the current baseline

### Goal

Create a trustworthy baseline before changing behavior. This phase prevents later improvements from being confused with changes in provider conditions.

### Work

- Record the current discovery universe size per scan.
- Record provider records checked separately from accepted records.
- Record every rejection reason with a stable reason code.
- Record the exact active filter configuration.
- Record scan start, end, provider freshness, RPC freshness, and timeout status.
- Keep the current accepted-token behavior available behind a `baseline-v1` decision version.
- Correct observability semantics:
  - `recordsChecked` = all provider candidates examined;
  - `tokensAccepted` = candidates that passed all active gates;
  - `tokensPersisted` = records written to the current Radar board.
- Remove UI copy that implies a computed score where the field is still unknown.

### Required baseline metrics

```text
provider_records_checked
provider_records_with_pair
provider_records_with_price
provider_records_with_liquidity
security_verified
security_unknown
security_rejected
liquidity_rejected
momentum_rejected
cto_rejected
accepted_count
scan_duration_ms
provider_age_ms
rpc_age_or_commitment
```

### Acceptance criteria

- Every scan can be audited from one persisted run record.
- Checked, rejected, and accepted counts reconcile exactly.
- No `radar >= threshold` metric is shown while Radar score is unavailable.
- A failed scan never overwrites the last known good candidate set.

---

## 5. Phase 1 — Expand discovery and normalize observations

### Goal

Stop treating the boosted-token feed as the complete market universe and create one canonical observation format.

### Discovery sources

The first implementation should support these source categories:

1. DexScreener latest/new pair discovery where available.
2. DexScreener token boosts, retained as an `attention` feature.
3. Existing token addresses already in the active watchlist.
4. Optional indexed Solana source later for token creation, transfer, and holder activity.

The provider adapter must deduplicate by mint and pair address. A token may have multiple pairs; the primary pair is selected by an explicit policy, not silently by a single metric.

### Canonical observation fields

Each observation must include:

```text
mint
pair_address
chain_id
dex_id
base_token
quote_token
observed_at
provider_updated_at
pair_created_at
price_usd
market_cap
fdv
liquidity_usd
volume_5m
volume_1h
volume_6h
volume_24h
buys_5m / sells_5m
buys_1h / sells_1h
buys_6h / sells_6h
buys_24h / sells_24h
makers_5m / makers_1h when available
price_change_5m / 1h / 6h / 24h
boost_amount
cto_flag
source
source_request_id
freshness_ms
data_quality
```

If a provider does not supply a field, store `null` plus a quality reason. Do not manufacture a zero.

### Pair selection policy

For each mint:

1. Exclude non-Solana pairs.
2. Exclude pairs with missing price or liquidity from the primary candidate calculation.
3. Prefer the pair with sufficient liquidity and the freshest observation.
4. If multiple pairs remain, preserve all pair observations and mark the primary pair explicitly.
5. Never mix volume from one pair with liquidity from another without labeling the aggregation.

### Acceptance criteria

- The Radar can discover a token that is not boosted if it has a qualifying market signal.
- Every feature has a source and timestamp.
- A stale pair cannot receive a full-confidence decision.
- Multi-pair token selection is deterministic and testable.

---

## 6. Phase 2 — Strengthen security and market-quality gates

### Goal

Preserve the current fail-closed security model while reducing false positives that pass authority checks but remain structurally unsafe.

### Security gates

#### Mandatory hard gates

- mint account must parse as the expected SPL token mint;
- mint authority must be renounced;
- freeze authority must be renounced;
- token supply must be available and positive;
- largest-holder data must be available;
- RPC response must be internally complete;
- RPC result must identify commitment and request time;
- malformed, missing, or timed-out security data must be `UNKNOWN` and fail closed.

#### Concentration checks

Keep the current largest-account metric, but add:

```text
top_1_percent
top_5_percent
top_10_percent
top_20_percent
non_pool_top_1_percent
non_pool_top_10_percent
```

The last two require identifying known pool/program accounts. Until that mapping is available, show concentration as `account concentration`, not wallet concentration.

#### Additional security data

Add where provider coverage permits:

- deployer and mint-authority history;
- metadata mutability;
- pool ownership;
- LP lock or burn status;
- deployer overlap with largest holders;
- known program/account labels;
- sellability or route simulation status;
- recent suspicious transfer patterns.

If these are unavailable, they must reduce confidence. They must not be represented as passed.

### Dynamic market-quality gates

Replace the single fixed liquidity rule with a combination of:

```text
minimum absolute liquidity
liquidity / market_cap
expected $100 entry impact
volume / liquidity ratio
pool age
price and volume freshness
```

The fixed minimum can remain as a safety floor, but it is not sufficient by itself.

### Acceptance criteria

- Pool accounts are not incorrectly presented as wallet owners.
- Security status distinguishes `VERIFIED`, `REJECTED`, `UNKNOWN`, and `STALE`.
- Market-quality gates are visible in the rejection report.
- No missing security field can increase a token's score.

---

## 7. Phase 3 — Build time-series storage and feature engineering

### Goal

Convert repeated 15-second scans into usable market history.

### Proposed persistence model

The exact schema may use Prisma models or a normalized event table, but it must support these concepts:

#### `TokenObservation`

One provider observation per token/pair/time:

```text
id, mint, pair_address, observed_at, provider,
price, market_cap, fdv, liquidity,
volume windows, transaction windows, maker windows,
price-change windows, source_updated_at, quality
```

#### `SecurityObservation`

One RPC security result per token/time:

```text
mint, observed_at, commitment, slot_context,
mint_authority, freeze_authority,
supply, holder concentration,
top-holder accounts, pool-account classification,
status, reasons
```

#### `RadarFeatureSnapshot`

Derived features used for a decision:

```text
mint, observed_at, feature_version,
price_acceleration,
volume_acceleration,
buy_sell_imbalance,
maker_growth,
liquidity_growth,
volume_liquidity_ratio,
volatility,
drawdown,
concentration_penalty,
manipulation_flags,
freshness,
completeness
```

Retention should start conservatively, for example recent high-resolution data plus daily summaries. Retention is an implementation decision, but deleting the only data needed for outcome measurement is not acceptable.

### Feature definitions

#### Price acceleration

Compare short and long horizons instead of using only 24-hour change:

```text
price_acceleration = normalized(change_5m - change_1h_baseline)
```

#### Volume acceleration

Compare recent volume to a rolling baseline:

```text
volume_acceleration = volume_5m / expected_volume_5m
```

Guard against division by zero and mark low-sample values unknown.

#### Flow imbalance

Use both counts and volume:

```text
buy_sell_imbalance =
  weighted(buy_volume - sell_volume)
  + weighted(buy_count - sell_count)
```

Do not call this smart money until wallet identity or an indexed wallet source exists.

#### Maker growth

Track new/active makers across windows. High transaction count with flat makers is a manipulation warning, not automatically positive momentum.

#### Liquidity quality

Use liquidity relative to market cap and expected trade size. A high volume/liquidity ratio without maker growth should be penalized.

### Acceptance criteria

- A token's current decision can be reproduced from persisted observations.
- Features expose null/unknown state and calculation version.
- A 24-hour price change alone cannot produce a high momentum score.
- The system can compare two scans for the same token without relying on in-memory state.

---

## 8. Phase 4 — Implement deterministic scoring

### Goal

Create transparent, testable scores before considering machine learning.

### Score outputs

Every eligible token receives:

```text
radar_score: 0–100
opportunity_score: 0–100
momentum_score: 0–100
risk_score: 0–100 (higher = more risk)
confidence_score: 0–100
decision_state
decision_version
score_reasons[]
score_warnings[]
```

`UNKNOWN` is allowed when the minimum feature set is incomplete. A token must not receive a fabricated numerical score.

### Initial score formula

Use an explicitly versioned baseline:

```text
opportunity_score =
  35% momentum_quality
  25% market_quality
  20% flow_quality
  20% security_quality
```

Apply penalties after component scoring:

```text
manipulation_penalty
liquidity_fragility_penalty
stale_data_penalty
concentration_penalty
excessive_pump_penalty
```

The exact coefficients must be configuration data and must be stored with each decision. They are hypotheses until validated.

### Momentum component

Suggested starting inputs:

```text
25% price acceleration
25% volume acceleration
20% buy/sell volume imbalance
15% maker growth
15% liquidity growth
```

### Market-quality component

Suggested starting inputs:

```text
30% liquidity / market-cap quality
25% expected $100 execution impact
20% volume consistency across windows
15% pair age suitability
10% FDV / market-cap consistency
```

### Flow-quality component

Until wallet identity exists, name this `flow_quality`, not `smart_money`:

```text
40% buyer/seller volume quality
30% maker growth
20% transaction-size distribution quality
10% persistence across scans
```

### Security-quality component

This is not merely a binary authority check:

```text
35% mint/freeze authority state
25% concentration quality
20% pool/LP classification
10% deployer quality
10% metadata and source completeness
```

Unavailable optional fields lower confidence and may cap the maximum score.

### Confidence score

Confidence measures evidence quality:

```text
25% data freshness
25% feature completeness
20% cross-source agreement
15% persistence across scans
15% security verification quality
```

Confidence must never be used to make a weak token appear stronger. It controls eligibility and ranking reliability.

### Precision-first eligibility

Initial high-precision candidate gate:

```text
security_state = VERIFIED
confidence_score >= 70
risk_score <= 35
momentum_score >= 65
no blocking manipulation flag
freshness within configured window
market-quality gates passed
```

The thresholds are initial hypotheses and must be evaluated, not treated as proven constants.

### Acceptance criteria

- Two identical inputs always produce the same score.
- Score output includes component values and reasons.
- Decision version is persisted.
- A score cannot be computed when mandatory features are unknown.
- UI labels distinguish score, risk, confidence, and evidence.

---

## 9. Phase 5 — Candidate state machine and alerts

### Goal

Alert on meaningful state changes, not only on first appearance.

### Candidate states

```text
OBSERVED
WATCH
QUALIFYING
ACTIONABLE_RESEARCH
STALE
REJECTED
INVALIDATED
```

Suggested transitions:

```text
OBSERVED → WATCH
WATCH → QUALIFYING
QUALIFYING → ACTIONABLE_RESEARCH
any active state → STALE when freshness expires
any active state → INVALIDATED on security or market-quality failure
```

### Alert triggers

Create an alert when:

- a token enters `QUALIFYING`;
- a token crosses the high-precision score threshold;
- score changes materially, not on every scan;
- risk changes from acceptable to blocked;
- security changes;
- liquidity changes beyond a configured percentage;
- a candidate becomes stale;
- a candidate requalifies after invalidation.

Deduplicate alerts with:

```text
mint + transition + decision_version + cooldown_window
```

### Acceptance criteria

- Existing tokens can trigger a new alert when their conditions improve.
- Repeated 15-second scans do not create alert spam.
- Every alert links to the exact feature snapshot and score reasons.
- Security invalidation takes precedence over opportunity score.

---

## 10. Phase 6 — Forward outcome measurement and real backtest

### Goal

Measure whether the Radar actually improves candidate quality.

### Outcome capture

For every qualifying or actionable research alert, capture:

```text
price at signal
price after 5m
price after 15m
price after 1h
price after 6h
maximum favorable excursion
maximum adverse excursion
drawdown
liquidity at each checkpoint
still tradable
security invalidated
```

The paper portfolio remains separate. Outcome measurement must work even if the user never places a paper trade.

### Required metrics

```text
precision@1
precision@3
precision@5
precision@10
median forward return
win rate
false-positive rate
maximum adverse excursion
candidate survival rate
stale-data rate
security-failure rate
```

Define the target before measuring. Example research labels:

```text
positive_1h =
  forward_return_1h >= target_return
  and maximum_drawdown_1h > -loss_limit
```

The target return and loss limit must be configuration values, not hidden assumptions.

### Backtest requirements

The current Backtest page only summarizes scan runs and pattern coverage. It must not be called a trading backtest until it replays persisted observations and computes forward outcomes without look-ahead bias.

Rules:

- only use features available at signal time;
- never use future liquidity, price, or security state in the signal;
- preserve the original decision version and configuration;
- include unavailable-data cases;
- report sample size and confidence intervals where practical;
- separate discovery bias from scoring performance.

### Acceptance criteria

- The system can answer whether a rule improved precision.
- Backtest output includes sample size and time window.
- Future values cannot leak into the signal snapshot.
- A score version can be compared against a previous version.

---

## 11. Phase 7 — Calibration, threshold tuning, and controlled rollout

### Goal

Tune the system using measured outcomes without overfitting.

### Tuning sequence

1. Establish baseline-v1 using current hard filters.
2. Add time-series features without changing hard security gates.
3. Compare score thresholds at fixed sample windows.
4. Tune for precision@top-k, not average score aesthetics.
5. Validate on a later time window than the tuning window.
6. Keep a shadow mode before changing user-visible candidate behavior.
7. Promote a version only when it beats baseline on predefined metrics.

### Rollout modes

```text
baseline
shadow
candidate
active-research
```

In `shadow` mode, the new scorer records decisions but does not replace the existing list. This is required for safe comparison.

### Promotion gate

A new scorer is eligible for promotion only if:

- security rejection behavior is not weakened;
- data completeness is not worse than baseline;
- precision@top-k improves over a meaningful sample;
- maximum adverse excursion does not materially worsen;
- scan latency and provider error rate stay within budget;
- decision reasons remain explainable.

---

## 12. Operational requirements

### Freshness

Each decision must show:

```text
market_data_age
security_data_age
last_observed_at
```

The decision becomes `STALE` when required data exceeds its configured age.

### Failure behavior

- Provider failure: preserve last known good state and mark it stale.
- RPC failure: fail closed for new qualification.
- Partial batch response: mark affected tokens unknown, never verified.
- Database failure: do not report a successful scan.
- Timeout: cancel downstream work when possible and record timeout reason.

### Rate and latency budget

The 15-second scheduler is acceptable only if:

- scans do not overlap;
- RPC and provider calls have bounded timeouts;
- stale results are not mistaken for current results;
- rate-limit responses are visible;
- a scan duration histogram is persisted.

### Security auditability

Never present `getTokenLargestAccounts` as wallet ownership. The UI must call it token-account concentration unless pool ownership has been resolved.

---

## 13. Proposed implementation order

The phases should be implemented in this order:

1. **Phase 0:** baseline and observability corrections.
2. **Phase 1:** discovery expansion and canonical observation contract.
3. **Phase 2:** stronger security and market-quality gates.
4. **Phase 3:** time-series persistence and feature snapshots.
5. **Phase 4:** deterministic score engine.
6. **Phase 5:** candidate state machine and alerts.
7. **Phase 6:** forward outcomes and real backtest.
8. **Phase 7:** calibration and controlled rollout.

Do not skip from the current system directly to machine learning. Without persisted observations and outcome labels, machine learning would produce an opaque score with no reliable validation.

---

## 14. Definition of done for the core Radar

The core Radar is considered production-ready only when all of the following are true:

- discovery is not limited to boosted tokens;
- provider and RPC observations are persisted with timestamps;
- market and security freshness are visible;
- hard gates fail closed;
- account concentration is not mislabeled as wallet ownership;
- `radar`, `opportunity`, `momentum`, `risk`, and `confidence` are computed or explicitly `UNKNOWN`;
- every score is reproducible from a versioned feature snapshot;
- alerts represent state transitions and are deduplicated;
- forward outcomes are captured independently from paper trades;
- the Backtest page measures forward performance without look-ahead;
- precision@top-k and adverse excursion are visible;
- new scoring versions can run in shadow mode;
- no claim of effectiveness is made without measured sample data.

---

## 15. First implementation checkpoint

The first coding checkpoint should deliver only Phase 0 and the minimum of Phase 1:

1. Add precise scan counters and rejection reason codes.
2. Persist canonical provider observations.
3. Keep the current hard-filter behavior unchanged.
4. Label the current accepted list as `baseline-v1`.
5. Remove any UI implication that current null score fields are computed.
6. Add tests for:
   - unknown security fails closed;
   - missing liquidity is not treated as zero;
   - checked/accepted counts reconcile;
   - failed scans preserve last good state;
   - duplicate mints and pairs are deterministic.

Only after this checkpoint passes should scoring weights be introduced.
