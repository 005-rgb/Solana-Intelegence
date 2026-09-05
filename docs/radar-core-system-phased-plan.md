# Radar Core System — Phased Precision Plan

**Status:** Proposed implementation blueprint — expanded gap-audit edition  
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

---

## 16. Second-audit gap closure

The first version of this roadmap covered the analytical path, but a precision Radar also needs data integrity, execution safety, security boundaries, statistical validity, and recovery controls. This section is mandatory scope, not optional polish.

### 16.1 Source contract and data-lineage controls

Every external response must be treated as an untrusted, versioned input.

Persist or derive:

```text
source_name
source_endpoint_or_method
source_request_id
source_response_hash
source_schema_version
ingested_at
source_updated_at
observed_at
provider_clock_skew_ms
rpc_endpoint_class
rpc_commitment
rpc_slot_or_context
quality_status
quality_reason_codes[]
```

Provider adapters must validate:

- response shape;
- required field types;
- numeric finiteness;
- non-negative quantities;
- percentage bounds;
- timestamp bounds and clock skew;
- chain and mint identity;
- duplicate records;
- pair identity consistency;
- impossible relationships such as volume, liquidity, or supply being negative.

An invalid record is `INVALID`, not silently dropped. A missing field is `UNKNOWN`, not zero. A stale record is `STALE`, not current.

The system must retain an immutable normalized observation or a content-addressed raw payload reference. A mutable `Token.details` JSON snapshot alone is not sufficient to reproduce a past decision.

### 16.2 Discovery bias and universe integrity

The discovery layer must report source-specific denominators:

```text
boost_feed_seen
new_pair_feed_seen
watchlist_seen
indexed_source_seen
unique_mints_before_dedup
unique_pairs_before_dedup
unique_mints_after_dedup
source_overlap
source_only_candidates
```

The system must explicitly show whether a candidate came from a promoted/boosted feed. Precision results must distinguish:

```text
precision within boosted universe
precision within non-boosted universe
precision across the combined universe
```

Otherwise a high score may only describe the provider's promotional selection bias.

Discovery requirements:

- preserve every eligible pair observation before selecting a primary pair;
- use a stable `mint + pair_address` identity;
- handle pair migration without merging unrelated pools;
- retain delisted or disappeared pairs as historical observations;
- include active watchlist mints even when they leave the discovery feed;
- record exclusion reasons for candidates that cannot be normalized.

### 16.3 Pair, pool, and account taxonomy

A token account address is not automatically a wallet. The system must classify accounts before using them for concentration or insider analysis.

Required account classes:

```text
EOA_OR_WALLET
ASSOCIATED_TOKEN_ACCOUNT
AMM_POOL
POOL_VAULT
PROGRAM_OWNED
ESCROW_OR_LOCK
TREASURY
UNKNOWN_ACCOUNT
```

Required pool evidence where available:

```text
pool_program_id
amm_type
amm_version
base_vault
quote_vault
lp_mint
lp_supply
lp_holder_distribution
lp_burn_status
lp_lock_provider
lp_lock_expiry
withdraw_authority
pool_creation_slot
pool_last_update_slot
```

Concentration outputs must be separated:

```text
top_1_account_percent
top_5_account_percent
top_10_account_percent
top_20_account_percent
top_1_wallet_percent
top_5_wallet_percent
top_10_wallet_percent
pool_adjusted_top_1_wallet_percent
pool_adjusted_top_10_wallet_percent
```

If account ownership or pool classification is unavailable, the output must say `ACCOUNT_CONCENTRATION_ONLY` and confidence must be capped. The UI must never label an unresolved token account as a wallet holder.

### 16.4 Chain provenance and token-program coverage

Security checks must identify the token program and account type:

- legacy SPL Token;
- Token-2022;
- unsupported or unknown program.

For Token-2022, inspect relevant extensions where supported, including:

- transfer fees;
- transfer hooks;
- permanent delegate;
- default account state;
- non-transferable restrictions;
- confidential transfer behavior;
- metadata pointer and authority behavior.

Metadata evidence must be distinguished from provider presentation metadata. Where supported, capture:

```text
metadata_account
update_authority
is_mutable
metadata_uri
uri_fetch_status
uri_content_hash
name_symbol_mint_consistency
verified_collection
metadata_last_observed
```

Metadata is not a safety guarantee, but hidden mutability or transfer extensions can affect execution and confidence.

### 16.5 Deployer, funding, and relationship evidence

The security layer must define a graph evidence contract before claiming wallet intelligence.

Required entities where coverage is available:

```text
creator_or_deployer
mint_creation_signature
mint_creation_slot
deployer_funding_source
deployer_previous_tokens
deployer_previous_outcomes
holder_owner
holder_first_funder
holder_cluster_id
cluster_confidence
transfer_signature
transfer_slot
```

Relationship flags should include:

- deployer-to-holder overlap;
- shared funder;
- synchronized acquisition;
- coordinated distribution;
- repeated launch history;
- rapid concentration;
- funding from known program or mixer-like source;
- cluster size and percentage of supply.

An indexed graph provider may be required. If the project does not connect one, these fields remain `UNKNOWN`; the current Bubble Map must not imply relationships it cannot observe.

### 16.6 Sellability and execution safety — new mandatory phase

Security authority checks do not prove that a token can be sold.

Before a token becomes `ACTIONABLE_RESEARCH`, the system must attempt an independent route/quote or simulation for:

```text
buy quote for configured order sizes
sell quote for configured order sizes
route availability
minimum received
price impact
estimated slippage
transfer fee
transfer hook result
compute failure
account creation requirement
quote freshness
```

At minimum, configure research sizes such as:

```text
$100
$500
$1,000
```

The size must be explicit because a token can be sellable for $10 but not for $1,000.

Eligibility rules:

- failed sell simulation is a blocking risk;
- missing sell simulation is `UNKNOWN`, not `PASS`;
- stale quotes cannot qualify a candidate;
- provider mid-price must not be used as executable return;
- paper trade P/L must disclose that it is not execution-tested until a quote/simulation exists.

### 16.7 Trade-level microstructure and manipulation evidence

Pair-level counters alone are not sufficient to call a signal `smart money`.

Where an indexed transaction source is available, capture:

```text
trade_signature
slot
block_time
pool
side
base_amount
quote_amount
effective_price
trader_or_owner
transaction_size_bucket
priority_fee
compute_units
inner_instruction_summary
```

Derived manipulation checks:

- volume without unique-maker growth;
- repeated wallet round trips;
- same-wallet buy/sell churn;
- synchronized wallet entry;
- identical or highly repetitive trade sizes;
- burst activity concentrated in a few slots;
- buyer/seller overlap;
- pool drain or liquidity pull;
- price movement without reserve support;
- same-slot sandwich or backrun indicators;
- abnormal priority-fee or bundle behavior.

A minimum sample size is required for every manipulation flag. When sample size is insufficient, return `UNKNOWN_SAMPLE`, not “no manipulation detected.”

### 16.8 Concurrency, idempotency, and atomicity

The in-process `scanRunning` flag is not enough for multiple processes or restart recovery.

Required controls:

- database advisory lock or equivalent distributed scan lock;
- one active scan per environment;
- explicit skipped/overlapping scan record;
- deadline and `AbortSignal` propagated to every provider/RPC request;
- no orphan background request after a timeout;
- idempotency key for manual scan requests;
- run correlation ID;
- optimistic version or transaction guard for mutable state;
- atomic account/trade/position/ledger update;
- atomic watchlist mutation plus event record;
- atomic alert state change plus durable outbox event.

The system must reconcile orphan `RUNNING` scans at startup and mark them as interrupted with a reason.

### 16.9 Provider and RPC resilience

For each provider and endpoint, record:

```text
request_count
success_count
timeout_count
429_count
4xx_count
5xx_count
schema_error_count
latency_ms
retry_count
retry_after_ms
last_success_at
last_failure_at
health_state
```

Required behavior:

- bounded concurrency;
- separate timeout budgets for discovery, pair lookup, and security;
- exponential backoff with jitter;
- honor `Retry-After`;
- circuit breaker for repeated provider failures;
- endpoint health and recovery;
- no silent conversion of pair failures into an empty successful response;
- partial batch responses are recorded per token;
- fallback endpoint policy is explicit and does not claim equivalent data quality.

If a scan completes with partial coverage, status must be `PARTIAL`, not `SUCCESS`.

### 16.10 Alert integrity and lifecycle

The current alert model is not enough for a research-grade lifecycle.

Required models/concepts:

```text
CandidateState
CandidateTransition
AlertEvent
AlertDelivery
AlertAcknowledgement
AlertResolution
```

Every transition must contain:

```text
mint
from_state
to_state
transition_reason
feature_snapshot_id
decision_id
decision_version
occurred_at
dedupe_key
cooldown_bucket
```

Use a durable unique dedupe policy such as:

```text
mint + transition + decision_version + cooldown_bucket
```

Alert counts must distinguish:

```text
open
acknowledged
resolved
expired
invalidated
stale
```

Security invalidation, sellability failure, LP withdrawal, and data staleness must be able to supersede a prior opportunity alert.

### 16.11 Statistical validity and label governance

Forward outcome measurement must address:

- look-ahead from provider-reported 24-hour windows;
- overlapping 15-second signals;
- correlated observations from the same token and pair;
- boosted-universe selection bias;
- survivor and availability bias;
- missing-future censoring;
- repeated requalification;
- pair migration;
- quote vs executable price;
- slippage, fees, latency, and impact;
- market-regime and provider-regime drift.

Every label needs:

```text
signal_time
label_start_time
label_end_time
entry_price_definition
exit_price_definition
target_config_hash
loss_limit_config_hash
completion_state
censoring_reason
tradability_state
security_state_at_horizon
```

Required evaluation design:

- walk-forward time splits;
- embargo around overlapping labels;
- frozen as-of feature snapshots;
- separate discovery baseline from scorer lift;
- token-cluster or block bootstrap;
- sample count and 95% confidence intervals;
- temporal holdout not used during tuning;
- minimum sample and time-window requirement before claims;
- pre-registered primary metric and guardrails.

For probability-like outputs, also report:

```text
Brier score
log loss
calibration curve
expected calibration error
calibration slope/intercept
coverage at each threshold
```

If the output is not calibrated probability, label it `score`, not `probability`.

### 16.12 Model and configuration governance

Every scoring decision must persist:

```text
decision_version
feature_version
configuration_hash
threshold_configuration
coefficient_configuration
source_set
scorer_code_or_build_identifier
```

Changes to thresholds, weights, feature definitions, data source, or eligibility gates require:

1. a new version;
2. a shadow comparison;
3. a validation report;
4. an approval record;
5. rollback capability.

Use champion/challenger mode:

```text
champion = current user-visible decision
challenger = shadow decision
```

The challenger must not affect alerts or paper trades until the promotion gate passes.

### 16.13 Calibration and drift monitoring

Monitor:

```text
feature missingness drift
feature distribution drift
source coverage drift
score distribution drift
acceptance-rate drift
precision drift
false-positive drift
provider response schema drift
security UNKNOWN-rate drift
sellability failure drift
```

Use both operational and outcome alerts. A high scan-success rate does not imply a healthy Radar if candidate precision or data completeness deteriorates.

### 16.14 Operational SLOs and recovery

Define and measure:

```text
scheduled-start adherence
scan completion rate
scan p50/p95/p99 latency
provider freshness age
RPC freshness age
database persistence success
last-known-good age
partial scan rate
timeout rate
alert creation latency
alert dedupe correctness
```

Expose readiness separately from liveness:

- liveness: process responds;
- readiness: database, provider, and required security path are usable;
- degraded: process is up but data is stale or partial.

Required recovery controls:

- database backups/PITR plan;
- migration compatibility and rollback plan;
- restore drill;
- retention and export policy;
- startup reconciliation for orphan runs and outbox events;
- destructive migration approval and audit;
- incident runbook with replay from immutable observations.

### 16.15 API and application security

Before exposing the application beyond a trusted local preview, add:

- authentication and authorization for scan, watchlist, analysis, and paper-trade mutations;
- CSRF/origin policy;
- per-client rate limits;
- request IDs and actor audit;
- body timeout and connection limits;
- security headers;
- strict input validation;
- safe error responses without provider internals;
- dependency and secret-handling review.

Paper trading endpoints must be idempotent and protected against duplicate requests, negative balances, stale quotes, and concurrent buy/sell races.

### 16.16 Testing expansion

The minimum test matrix must include:

#### Provider contract tests

- malformed JSON;
- missing fields;
- wrong chain;
- duplicate mints/pairs;
- negative or non-finite numbers;
- clock skew;
- provider schema revision;
- partial pair responses;
- 429 with and without `Retry-After`.

#### RPC/security tests

- partial batch;
- missing result;
- wrong account type;
- zero/missing supply;
- Token-2022 extension;
- stale commitment;
- pool account classified correctly;
- unknown owner remains unknown;
- authority changes between scans.

#### Scoring tests

- deterministic golden fixtures;
- null/unknown propagation;
- zero denominators;
- score caps;
- penalty precedence;
- version/config hash reproducibility;
- no score inflation from missing data.

#### Temporal tests

- out-of-order observations;
- duplicate retries;
- late provider update;
- pair migration;
- clock skew;
- future observation rejected;
- no-look-ahead fixture.

#### Concurrency and recovery tests

- two manual scans;
- scheduler/manual collision;
- timeout cancellation;
- orphan scan recovery;
- database retry;
- duplicate trade request;
- alert outbox replay;
- process restart during persistence.

#### Adversarial market tests

- volume with no maker growth;
- concentrated cluster below top-1 threshold;
- pool as largest account;
- liquidity pull;
- failed sell simulation;
- Token-2022 transfer fee;
- repeated wallet round trips;
- same-slot burst.

---

## 17. Revised phase map

The complete roadmap now has these implementation phases:

| Phase | Name | Primary output | Must not claim yet |
|---|---|---|---|
| 0 | Baseline and auditability | Immutable run/rejection counters and current-behavior baseline | Predictive effectiveness |
| 0A | Platform safety | Auth, limits, locks, atomicity, recovery, request IDs | Multi-process reliability before tests pass |
| 1 | Discovery and source contracts | Multi-source universe, schema validation, lineage, pair identity | Broad recall until source denominators are visible |
| 1A | Pair/pool taxonomy | Pool program, vault, LP, account classes | Wallet concentration before owner resolution |
| 2 | Security evidence | Authority, metadata, supply, holder/account evidence with UNKNOWN/STALE states | Safety guarantee |
| 2A | Execution safety | Sellability, route, quote, impact, transfer extensions | Actionable candidate without sell evidence |
| 3 | Time-series observations | Immutable market, security, pool, and trade observations | Momentum claim without sufficient sample |
| 3A | Manipulation and MEV | Wash, cluster, bot, burst, pool-drain flags | Smart-money claim without identity evidence |
| 4 | Deterministic scorer | Versioned score/risk/confidence with explanations | Probability claim without calibration |
| 4A | Calibration governance | Shadow/champion, thresholds, config hashes, drift controls | Production promotion without holdout |
| 5 | Candidate lifecycle | State transitions, dedupe, invalidation, outbox | Alert quality without lifecycle audit |
| 6 | Outcome labeling | Executable and price-based forward labels with censoring | Backtest conclusion before temporal validity |
| 6A | Evaluation | Walk-forward, embargo, confidence intervals, calibration metrics | Efficacy claims below minimum sample |
| 7 | Controlled rollout | SLOs, monitoring, rollback, challenger promotion | Permanent rollout without guardrails |

Dependencies:

```text
0 → 1 → 1A → 2 → 2A → 3 → 3A → 4 → 4A → 5 → 6 → 6A → 7
0A must be in place before mutation endpoints or multi-process scheduling.
```

Some work can be developed in parallel, but no downstream score or efficacy claim may bypass its data and evaluation dependencies.

---

## 18. Revised final acceptance gate

The Radar core is complete only when all criteria below pass:

### Reproducibility

- Any displayed decision can be rebuilt after restart from immutable observation rows.
- Source payload/schema/config versions are known.
- Feature and score versions are persisted.
- Provider revisions cannot rewrite historical decisions.

### Data integrity

- checked = accepted + rejected + unresolved/partial with no unexplained remainder;
- all rejection and UNKNOWN reasons reconcile;
- source-specific discovery denominators are visible;
- stale and partial state are distinct from healthy state.

### Security and execution

- account concentration is not mislabeled as wallet ownership;
- pool/program accounts are classified or marked unknown;
- metadata/token-program extensions are considered where relevant;
- LP, deployer, cluster, and sellability evidence are separate from authority checks;
- failed or missing sell evidence cannot silently qualify a candidate.

### Scoring

- deterministic scorer fixtures pass;
- missing mandatory features block or cap the score;
- score, risk, and confidence are distinct;
- no `smartMoney` claim exists without wallet identity methodology;
- no probability language exists without calibration evidence.

### Lifecycle

- every candidate transition is persisted;
- alerts are deduplicated and replay-safe;
- invalidation and staleness supersede outdated opportunity alerts;
- alert counts reflect open/resolved/expired state correctly.

### Evaluation

- no-look-ahead tests pass;
- walk-forward holdout is used;
- overlapping and correlated observations are handled;
- outcome labels include tradability, slippage, fees, and censoring;
- metrics include sample sizes and uncertainty;
- a pre-registered minimum sample/time window is met before effectiveness claims.

### Operations

- scan locks, cancellation, timeout, retry, and startup reconciliation work;
- provider/RPC/DB SLOs are measured;
- degraded readiness is visible;
- backups and restore procedures are tested;
- shadow, rollback, and challenger paths are available.

Until this gate passes, the product should describe the system as a **live research filter and evidence collector**, not as a validated high-precision prediction engine.
