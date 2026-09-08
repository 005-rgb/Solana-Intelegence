# Roadmap Pembangunan: Provider-Resilient Solana Radar

## Roadmap Eksekusi Presisi Tinggi dari PRD

---

**Versi:** 1.0  
**Tanggal:** 2026-09-08  
**Status:** Ready for implementation planning  
**Parent PRD:** `docs/provider-resilient-data-pipeline-prd.md`  
**Dokumen produk utama:** `docs/integrated-radar-core-market-brain-prd.md`  
**Runtime baseline:** Node.js 24, workflow `Start application`, port 5000  
**Database baseline:** PostgreSQL melalui Prisma  
**Owner/Driver:** Product owner Solana Radar  
**Approver:** Product owner Solana Radar  

### Changelog

| Versi | Tanggal | Perubahan |
|---|---|---|
| 1.0 | 2026-09-08 | Roadmap implementasi lengkap dari provider gateway sampai worker separation |
| 1.1 | 2026-09-08 | M0 baseline inventory, bounded observability, synthetic fixtures, and gate report completed |

---

## 1. Cara menggunakan roadmap ini

Dokumen ini adalah urutan kerja pembangunan, bukan daftar ide. Setiap fase
memiliki:

- tujuan yang dapat diverifikasi;
- work package dengan ID stabil;
- dependency;
- target file/komponen;
- perubahan database atau API;
- test yang wajib dibuat;
- acceptance criteria;
- gate go/no-go;
- rollback plan;
- exit artifact.

Aturan eksekusi:

1. Kerjakan fase berurutan kecuali dependency menyatakan parallel.
2. Jangan memulai fase berikutnya jika gate fase sebelumnya belum lulus.
3. Setiap perubahan provider harus dimulai sebagai shadow/observe-only.
4. Setiap schema change development harus melalui Prisma development flow.
5. Jangan menambahkan DDL startup atau deploy-time `db:push`.
6. Jangan menambahkan credential ke source, test fixture committed, atau log.
7. Jangan membuat data unavailable menjadi angka nol atau skor positif.
8. Jangan mengubah Phase 2 safety gate hanya demi meningkatkan coverage.
9. Jika provider gagal, board terakhir yang valid tetap dipertahankan.
10. Setiap work package harus menambah atau memperbarui test sebelum gate
    ditutup.

### 1.1 Status pekerjaan awal

Komponen berikut dianggap sudah tersedia dan tidak diulang dalam roadmap:

| Komponen | Status |
|---|---|
| Node.js 24 | Selesai |
| Workflow `Start application` | Selesai |
| PostgreSQL development schema | Selesai |
| Prisma Client generation | Selesai |
| DexScreener discovery baseline | Selesai |
| Solana RPC pool baseline | Selesai |
| Jupiter research quote baseline | Selesai |
| Provider lineage dasar | Selesai |
| Retry dan circuit behavior dasar | Selesai |
| Phase 0A–7 core pipeline | Selesai sebagai baseline |
| Bounded evaluation/snapshot query baseline | Selesai |
| Production mutation auth guard | Selesai sebagai guard dasar |
| Runtime smoke test dasar | Selesai |
| Test suite baseline | 85 test lulus pada baseline terakhir |

Roadmap dimulai dari penguatan fondasi tersebut, bukan mengganti pipeline core.

---

## 2. Target keadaan akhir

Target akhir:

```text
                 ┌─────────────────────────┐
                 │     Read API / UI       │
                 │  last-known-good state  │
                 └────────────┬────────────┘
                              │
                       PostgreSQL/cache
                              │
                 ┌────────────▼────────────┐
                 │ Evidence normalization  │
                 │ lineage + quality gate  │
                 └────────────┬────────────┘
                              │
                 ┌────────────▼────────────┐
                 │ Bounded priority queue  │
                 │ lease + retry + DLQ     │
                 └───────┬────────┬────────┘
                         │        │
             ┌───────────▼──┐  ┌──▼───────────┐
             │ Provider     │  │ Event        │
             │ gateway      │  │ ingestion    │
             │ quota/cache  │  │ webhook/RPC  │
             └───────┬──────┘  └──────┬────────┘
                     │                │
       ┌─────────────┼────────────────┼────────────┐
       │             │                │            │
   DexScreener   Secondary       RPC pools      Jupiter
   market        market          security       quotes
                   provider      truth
```

Keadaan akhir harus memiliki:

- minimal dua failure domain untuk RPC;
- minimal satu secondary market provider dalam shadow mode lalu active mode;
- provider gateway tunggal untuk semua outbound request;
- queue yang bounded dan dapat dipulihkan;
- tiered scheduler;
- cache fresh/stale/expired/failed/unknown;
- disagreement evidence;
- event-driven targeted refresh;
- dead-letter/replay;
- API read path yang tidak menunggu provider;
- provider and queue SLO;
- worker separation yang dapat diaktifkan bertahap.

---

## 3. Urutan milestone tingkat tinggi

| Milestone | Nama | Dependency | Ukuran | Exit utama |
|---|---|---|---|---|
| M0 | Baseline freeze dan observability | None | S | Baseline metrics dan contract map |
| M1 | Provider gateway core | M0 | L | Semua outbound call lewat gateway |
| M2 | Cache dan request deduplication | M1 | M | Duplicate request turun dan lineage utuh |
| M3 | Queue dan tiered scheduler | M1, M2 | L | Full scan 15 detik dihentikan |
| M4 | Secondary market provider | M1, M2 | L | Cross-source disagreement aktif |
| M5 | RPC workload isolation | M1, M2, M3 | M | RPC budget terpisah per workload |
| M6 | Event-driven ingestion | M1, M3, M5 | XL | Targeted refresh dari event |
| M7 | Evidence/outcome worker | M2, M3 | L | Slow workloads tidak mengganggu scan |
| M8 | Worker separation dan production hardening | M3–M7 | XL | Read API terisolasi, chaos gate lulus |

### 3.1 Jalur kritis

```text
M0 → M1 → M2 → M3 → M5 → M6 → M8
             └────→ M4 ────┘
             └────→ M7 ────┘
```

M4 dan M7 dapat berjalan paralel setelah M2/M3 sesuai kapasitas, tetapi M8
menunggu semua operational contract stabil.

---

## 4. Workstream ownership

| Workstream | Driver | Reviewer | Output |
|---|---|---|---|
| Provider gateway | Backend | Reliability | Gateway, adapters, request audit |
| Scheduling/queue | Backend | Operations | Work item, lease, priority, retry |
| Market sources | Data integration | Product/data quality | Secondary adapter, disagreement |
| RPC/on-chain | Chain integration | Security | RPC isolation, batching, events |
| Persistence | Backend/data | Database reviewer | Prisma schema, retention, indexes |
| UI/operator surface | Full-stack | Product | Health, queue, lineage, DLQ |
| QA/reliability | QA/engineering | Product + backend | Contract/load/chaos test |
| Rollout | Product owner | Phase 7 reviewer | Gates, flags, rollback |

Jika hanya satu engineer yang mengerjakan, workstream tetap dipisahkan secara
logis dan tidak boleh dicampur dalam satu perubahan besar tanpa checkpoint.

---

## 5. M0 — Baseline freeze dan observability

**Tujuan:** mengunci perilaku saat ini sebelum provider gateway mengubah jalur
request.

**Ukuran:** S, estimasi 2–4 hari kerja.  
**Dependency:** None.  
**Mode:** Tidak mengubah keputusan Radar.
**Status:** COMPLETE — gate report: [`provider-resilient-m0-gate-report.md`](provider-resilient-m0-gate-report.md)

### M0.1 Baseline contract inventory

**Target file:**

- `server.js`
- `solana-rpc-pool.js`
- `db.js`
- `radar-core.js`
- `prisma/schema.prisma`
- `test/*.test.js`

**Pekerjaan:**

- daftar semua outbound provider call;
- daftar semua scheduler interval;
- daftar semua mutation endpoint;
- daftar semua tabel observation/audit;
- daftar semua test yang memerlukan database;
- tandai call yang sudah memakai retry/batch/circuit;
- tandai call yang masih langsung memakai `fetch`.

**Output:**

```text
docs/provider-call-inventory.md
```

Dokumen inventory minimal memuat:

| Call site | Provider | Capability | Cadence saat ini | Retry | Cache | Target phase |
|---|---|---|---|---|---|---|

### M0.2 Baseline metrics

Tambahkan counter non-blocking untuk:

- provider request;
- provider status;
- latency;
- retry;
- cache placeholder hit/miss jika belum ada cache;
- scan duration;
- queue placeholder;
- provider freshness;
- last-known-good age.

Jika metrics backend belum dipilih, gunakan struktur JSON yang konsisten pada
audit scan sebagai tahap awal.

### M0.3 Baseline load fixture

Buat fixture sintetis tanpa credential:

- 10 token;
- 100 token;
- 1.000 token;
- 100 watchlist;
- provider 429;
- provider timeout;
- malformed provider response.

Fixture tidak boleh memakai network live.

### M0 gate

**Pass jika:**

- seluruh outbound call terinventarisasi;
- test baseline tetap lulus;
- `npm test` lulus;
- baseline runtime smoke lulus;
- tidak ada perubahan pada acceptance gate Phase 2;
- baseline scan metrics dapat dibaca.

**No-go jika:**

- ada provider call yang tidak diketahui;
- test baseline flaky;
- source lineage hilang;
- scan result berubah tanpa requirement.

**Exit artifacts:**

- call inventory;
- baseline metrics output;
- baseline load fixture;
- gate report.

---

## 6. M1 — Provider gateway dan quota foundation

**Tujuan:** semua outbound provider request melewati satu boundary yang aman,
terukur, dan configurable.

**Ukuran:** L, estimasi 2–4 minggu.  
**Dependency:** M0.  
**Criticality:** P0.

### M1.1 Provider adapter interface

**Target file baru:**

- `provider-gateway.js`
- `provider-adapters/base-provider.js`
- `provider-adapters/dexscreener.js`
- `provider-adapters/solana-rpc.js`
- `provider-adapters/jupiter.js`

**Pekerjaan:**

- definisikan `providerId`;
- definisikan `capabilities`;
- normalisasi error;
- normalisasi request metadata;
- normalisasi response metadata;
- larang adapter mengembalikan secret URL;
- expose health snapshot;
- expose provider-specific configuration hash.

**Kontrak minimum:**

```js
{
  providerId,
  adapterVersion,
  capabilities,
  request(context),
  normalize(payload, context),
  validate(normalized),
  classifyError(error),
  health()
}
```

### M1.2 Error taxonomy

Buat reason code canonical:

```text
RATE_LIMITED
RETRY_AFTER_INVALID
TIMEOUT
NETWORK_ERROR
HTTP_4XX
HTTP_5XX
SCHEMA_INVALID
CHAIN_MISMATCH
AUTH_FAILED
PROVIDER_DISABLED
BUDGET_EXHAUSTED
CIRCUIT_OPEN
REQUEST_ABORTED
UNKNOWN_PROVIDER_ERROR
```

Mapping provider-specific error ke reason code harus deterministic.

### M1.3 Quota token bucket

**Target file:**

- `provider-gateway.js`
- `quota-manager.js`
- `config/provider-budget.js`

**Pekerjaan:**

- global bucket;
- capability bucket;
- workload bucket;
- emergency reservation;
- atomic consume/refund;
- `notBefore` calculation;
- budget exhaustion event.

**Konfigurasi awal:**

```js
{
  providerId: "dexscreener",
  capability: "PAIR_MARKET",
  capacity: 100,
  refillPerMinute: 60,
  reservedEmergency: 10,
  maxConcurrency: 4
}
```

Nilai ini adalah placeholder configuration, bukan asumsi quota provider.

### M1.4 Retry-After dan backoff

Implementasikan:

- parse detik;
- parse HTTP date;
- clamp minimum/maksimum;
- exponential backoff;
- jitter;
- abort signal;
- max attempt;
- no retry untuk schema/auth/invalid request;
- retry hanya untuk error retryable.

### M1.5 Circuit breaker standard

State:

```text
CLOSED
DEGRADED
OPEN
HALF_OPEN
DISABLED
```

Circuit key:

```text
providerId + capability + endpointLabel
```

Jangan membuka seluruh provider jika hanya satu capability yang gagal, kecuali
health policy menyatakan provider benar-benar unavailable.

### M1.6 Integrasi call site

Migrasikan outbound call berikut secara berurutan:

1. DexScreener discovery;
2. DexScreener pair fetch;
3. DexScreener profiles/boosts;
4. Solana RPC single request;
5. Solana RPC batch request;
6. Jupiter quotes;
7. optional indexed discovery.

Setiap migrasi harus:

- mempertahankan response shape existing;
- menambah request audit;
- menambah test contract;
- tidak mengubah score.

### M1.7 Provider request persistence

**Target:**

- `prisma/schema.prisma`
- `db.js`

Tambahkan entity `ProviderRequest` atau struktur yang ekuivalen dengan field:

```text
providerId
adapterVersion
capability
endpointLabel
requestHash
correlationId
requestId
attempt
status
httpStatus
retryAfterMs
startedAt
completedAt
latencyMs
responseHash
responseBytes
quotaClass
errorCode
```

Index wajib:

```text
(providerId, capability, startedAt)
(correlationId)
(requestHash, createdAt)
(status, createdAt)
```

### M1 test package

File target:

- `test/provider-gateway.test.js`
- `test/quota-manager.test.js`
- `test/provider-error-taxonomy.test.js`
- `test/provider-contract.test.js`

Test minimum:

- 429 dengan Retry-After;
- 429 tanpa Retry-After;
- timeout;
- 5xx;
- schema invalid;
- budget exhausted;
- circuit open;
- concurrency bounded;
- no secret in logs;
- request audit created exactly once per attempt.

### M1 gate

**Pass jika:**

- semua outbound provider call lewat gateway;
- provider requests memiliki request ID dan correlation ID;
- 429 tidak retry langsung;
- concurrency bounded;
- budget exhaustion tidak melakukan request;
- test lulus;
- scan output tetap ekuivalen dengan baseline untuk fixture yang sama.

**Operational canary:**

- gateway aktif dengan `RADAR_PROVIDER_GATEWAY_ENABLED=true`;
- fallback legacy tidak dipakai pada provider yang sudah migrated;
- observe selama minimal satu siklus scan operasional.

**Rollback:**

- flag mematikan gateway untuk capability tertentu;
- request audit tetap dipertahankan;
- tidak rollback schema dengan destructive operation.

---

## 7. M2 — Cache dan request deduplication

**Tujuan:** mencegah request identik dan membaca data yang sama berulang kali.

**Ukuran:** M, estimasi 1–2 minggu.  
**Dependency:** M1.  
**Criticality:** P0.

### M2.1 Cache contract

**Target file:**

- `cache/provider-cache.js`
- `cache/cache-policy.js`
- `cache/cache-key.js`

Status cache:

```text
FRESH
STALE_BUT_USABLE
EXPIRED
FAILED
UNKNOWN
```

Cache key harus memasukkan:

- provider;
- capability;
- chain;
- mint/pair/entity;
- normalized request parameter;
- commitment/slot bucket jika RPC.

### M2.2 TTL policy

Implementasikan policy terpusat:

| Capability | Fresh | Stale |
|---|---:|---:|
| Discovery | 2m | 10m |
| Pair candidate | 15s | 60s |
| Pair ordinary | 2m | 10m |
| Token metadata | 6h | 24h |
| Mint account | 30m | 2h |
| Supply | 10m | 30m |
| Largest accounts | 10m | 30m |
| Taxonomy | 30m | 2h |
| Quote | 5s | 15s |
| Project evidence | 6h | 24h |

TTL harus tersimpan dalam config hash.

### M2.3 Persistent versus memory cache

Implementasi awal:

- memory cache untuk request coalescing saat process aktif;
- PostgreSQL cache/observation untuk last-known-good dan restart;
- tidak menggunakan file cache sebagai source of truth.

Cache memory boleh hilang saat restart; lineage database tidak boleh hilang.

### M2.4 Request coalescing

Jika request key sama sedang `RUNNING`:

- caller kedua menunggu promise/result yang sama;
- tidak membuat provider request kedua;
- timeout caller tidak membatalkan request utama kecuali owner abort.

### M2.5 Latest-write-wins

Response yang lebih lama tidak boleh menimpa data lebih baru:

```text
incoming.observedAt > stored.observedAt
atau incoming.slot > stored.slot
```

Jika timestamp provider tidak valid, response menjadi `UNKNOWN` dan tidak boleh
mengalahkan evidence valid.

### M2.6 M2 tests

File target:

- `test/provider-cache.test.js`
- `test/request-dedupe.test.js`
- `test/cache-freshness.test.js`

Skenario:

- hit fresh;
- stale fallback;
- expired miss;
- failed cache short TTL;
- concurrent coalescing;
- out-of-order response;
- cache key collision prevention;
- cache survives restart through database lineage.

### M2 gate

**Pass jika:**

- duplicate request rate fixture turun menjadi <5%;
- stale state selalu visible;
- cache failure tidak mengubah feed menjadi empty success;
- response out-of-order tidak menimpa data baru;
- scan baseline tetap sama secara keputusan;
- API read tidak melakukan provider fetch.

---

## 8. M3 — Tiered scheduler dan priority queue

**Tujuan:** mengganti full-universe scan 15 detik menjadi pekerjaan bounded yang
diprioritaskan.

**Ukuran:** L, estimasi 2–4 minggu.  
**Dependency:** M1 dan M2.  
**Criticality:** P0.

### M3.1 Work item schema

**Target:**

- `prisma/schema.prisma`
- `db.js`
- `queue/work-item.js`

Field minimum:

```text
kind
priority
entityType
entityId
dedupeKey
payload
status
notBefore
attemptCount
maxAttempts
leaseOwner
leaseUntil
lastErrorCode
lastProviderRequestId
createdAt
updatedAt
```

Enum status:

```text
QUEUED
RUNNING
SUCCEEDED
DEFERRED
FAILED
DEAD_LETTER
CANCELLED
```

Index:

```text
(status, priority, notBefore)
(dedupeKey, status)
(leaseUntil)
(kind, createdAt)
```

### M3.2 Lease dan worker recovery

Implementasikan:

- claim atomik;
- lease TTL;
- owner ID;
- heartbeat untuk job panjang;
- orphan lease recovery;
- no double execution;
- shutdown requeue;
- idempotent completion.

### M3.3 Priority function

Priority dihitung dari:

```text
basePriority
+ watchlistBoost
+ lifecycleBoost
+ securityEventBoost
+ freshnessDebt
+ volatilityBoost
- quotaCostPenalty
- staleRejectedPenalty
```

Priority function harus versioned dan disimpan dalam queue audit.

### M3.4 Scheduler cadence

Pindahkan scheduler dari satu full scan ke enqueue job:

| Job | Cadence |
|---|---:|
| Active watchlist refresh | 10–15s |
| Qualifying candidate refresh | 15–30s |
| New discovery | 2–5m |
| Security refresh | 5–15m |
| Holder taxonomy | 30–60m |
| Metadata | 6–24h |
| Rejected retry | 5–30m |
| Project evidence | 6–24h |
| Outcome label | batch |
| Evaluation | batch/operator |

### M3.5 Scan budget

Setiap scheduler cycle memiliki:

```text
maxDurationMs
maxProviderRequests
maxRpcUnits
maxTokens
maxDeepChecks
maxQuotes
```

Budget exhaustion:

- mark `PARTIAL_BUDGET`;
- requeue unprocessed work;
- persist audit;
- do not replace last-known-good board.

### M3.6 API compatibility

`POST /api/scan` tetap tersedia, tetapi berubah menjadi:

1. membuat bounded discovery work;
2. mengembalikan correlation ID;
3. tidak melakukan unbounded synchronous provider call;
4. menyediakan status melalui scan run/queue.

Jika mode synchronous tetap diperlukan sementara, harus memiliki hard timeout
dan request budget yang sama.

### M3.7 M3 tests

File target:

- `test/work-item-lease.test.js`
- `test/priority-queue.test.js`
- `test/scheduler-cadence.test.js`
- `test/scan-budget.test.js`
- `test/queue-recovery.test.js`

Skenario:

- two-worker race;
- lease expiration;
- shutdown requeue;
- priority ordering;
- dedupe queue;
- budget exhaustion;
- watchlist starvation prevention;
- rejected token backoff;
- manual scan cannot starve scheduled scan.

### M3 gate

**Pass jika:**

- tidak ada full-universe polling setiap 15 detik;
- watchlist refresh memenuhi cadence;
- queue depth bounded;
- queue age p95 sesuai SLO;
- duplicate work item rate <5%;
- worker crash dapat direcover;
- API read tetap tersedia saat queue penuh;
- Phase 2 decision output tidak berubah untuk fixture sama.

---

## 9. M4 — Secondary market provider dan disagreement

**Tujuan:** menyediakan failure domain market kedua dan mendeteksi perbedaan
evidence tanpa merusak lineage.

**Ukuran:** L, estimasi 2–4 minggu setelah provider dipilih.  
**Dependency:** M1 dan M2.  
**Parallel:** Dapat dimulai setelah M2 walau M3 masih berjalan, tetapi active
mode menunggu M3 queue.

### M4.1 Provider selection gate

Sebelum coding, provider harus memenuhi:

- API resmi;
- terms yang sesuai;
- capability yang jelas;
- rate limit terdokumentasi;
- chain/pair coverage sesuai;
- response timestamp;
- error semantics;
- endpoint health;
- biaya dan quota dapat diprediksi.

Provider yang hanya menyediakan scraping tanpa kontrak tidak boleh menjadi
production dependency.

### M4.2 Adapter

Target:

- `provider-adapters/secondary-market.js`
- `test/secondary-market-contract.test.js`

Capability minimal:

```text
DISCOVERY
PAIR_MARKET
TOKEN_METADATA
```

### M4.3 Normalized observation

Secondary data masuk sebagai observation terpisah:

```text
source = secondary-provider
sourceRole = SECONDARY_MARKET
primarySource = false
```

Jangan overwrite pair primary sebelum reconciliation selesai.

### M4.4 Disagreement engine

Target:

- `evidence/provider-disagreement.js`
- `test/provider-disagreement.test.js`

Field:

```text
field
sourceA
sourceB
valueA
valueB
relativeDelta
threshold
severity
blocking
reasonCode
```

Threshold awal:

| Field | Warning | Blocking |
|---|---:|---:|
| Price | 2% | 10% |
| Liquidity | 10% | 30% |
| Market cap | 15% | 40% |
| Volume | 25% | 60% |
| Pair identity | any | any |

### M4.5 Shadow rollout

Urutan:

1. adapter disabled;
2. request shadow tanpa memengaruhi decision;
3. persist normalized observation;
4. hitung disagreement;
5. tampilkan health/coverage;
6. non-blocking warning;
7. blocking hanya setelah sample cukup;
8. active failover untuk discovery;
9. active cross-check untuk market quality.

### M4 gate

**Pass jika:**

- primary provider outage dapat memakai secondary discovery;
- source lineage tidak hilang;
- pair mismatch tidak diterima diam-diam;
- disagreement terlihat pada UI/API;
- secondary outage tidak mengubahnya menjadi empty feed;
- decision tetap fail-closed pada mismatch blocking;
- provider cost/request budget berada dalam target.

---

## 10. M5 — Dedicated RPC pool dan workload isolation

**Tujuan:** memisahkan quota dan prioritas RPC security, holder, backfill, dan
outcome.

**Ukuran:** M, estimasi 1–3 minggu.  
**Dependency:** M1, M2, M3.  
**Criticality:** P0.

### M5.1 Provider onboarding

Production minimum:

- RPC primary dedicated;
- RPC secondary dedicated dari provider berbeda;
- emergency fallback;
- label provider;
- endpoint disimpan sebagai Replit Secret;
- quota dan rate limit terdokumentasi.

Public RPC hanya emergency/development.

### M5.2 Workload buckets

Bucket wajib:

```text
RPC_SECURITY
RPC_HOLDER
RPC_EVENT_BACKFILL
RPC_OUTCOME
RPC_MANUAL
```

Reservation awal:

```text
security: 35%
holder: 20%
backfill: 20%
outcome: 15%
manual/emergency: 10%
```

### M5.3 Batch isolation

Pisahkan:

- mint account batch;
- supply batch;
- largest accounts batch;
- owner enrichment batch.

Setiap item batch memiliki hasil sendiri.

### M5.4 Slot-aware cache

Tambahkan cache key:

```text
method + normalizedParams + commitment + slotBucket
```

Response slot lama tidak boleh menimpa response slot baru.

### M5.5 M5 tests

Target:

- `test/rpc-workload-budget.test.js`
- `test/rpc-slot-cache.test.js`
- `test/rpc-batch-isolation.test.js`

Skenario:

- primary timeout;
- primary 429;
- holder bucket habis;
- security tetap dapat quota;
- partial batch response;
- stale slot;
- endpoint recovery;
- emergency reservation.

### M5 gate

**Pass jika:**

- security scan tetap berjalan saat holder bucket penuh;
- primary failure berpindah ke secondary;
- public fallback hanya dipakai saat emergency;
- slot evidence valid;
- semua batch bounded;
- tidak ada request unbounded per token.

---

## 11. M6 — Event-driven Solana ingestion

**Tujuan:** mengurangi polling dengan memicu targeted refresh dari perubahan on-chain.

**Ukuran:** XL, estimasi 4–8 minggu.  
**Dependency:** M1, M3, M5.  
**Criticality:** P2, tetapi menjadi target produksi jangka menengah.

### M6.1 Pilihan provider

Pilih satu jalur awal:

- webhook provider;
- Solana WebSocket;
- Yellowstone/Geyser;
- enhanced transaction provider.

Kriteria:

- event ID;
- retry semantics;
- replay/backfill;
- program/address filter;
- delivery timestamp;
- signature;
- operational quota.

### M6.2 Event schema

```text
eventId
providerId
eventType
chain
signature
slot
observedAt
receivedAt
entityType
entityId
payloadHash
schemaVersion
status
```

Unique key:

```text
providerId + eventId
```

### M6.3 Targeted refresh mapping

| Event | Work item |
|---|---|
| Liquidity change | `PAIR_REFRESH`, `SECURITY_VERIFY` |
| Swap burst | `PAIR_REFRESH`, `MANIPULATION_REFRESH` |
| Authority change | `SECURITY_VERIFY` |
| Holder account change | `HOLDER_ENRICHMENT` |
| Pool change | `SECURITY_VERIFY`, `PAIR_REFRESH` |

### M6.4 Gap detection

Jika event cursor gap:

- tandai `EVENT_GAP`;
- enqueue bounded backfill;
- jangan replay tanpa max slot/time;
- jika backfill gagal, status `UNKNOWN`;
- periodic scheduler tetap menjadi safety net.

### M6.5 M6 gate

**Pass jika:**

- duplicate event idempotent;
- out-of-order event tidak menimpa newer observation;
- event gap terdeteksi;
- backfill bounded;
- targeted refresh menurunkan polling workload;
- event provider outage tidak mematikan periodic safety scan.

---

## 12. M7 — Project evidence dan outcome worker

**Tujuan:** memisahkan workload lambat dari market/security fast path.

**Ukuran:** L, estimasi 3–5 minggu.  
**Dependency:** M2 dan M3.  
**Parallel:** Dapat dikerjakan paralel dengan M4/M5.

### M7.1 Project evidence adapter

Target:

- `provider-adapters/project-evidence.js`
- `project-evidence/normalizer.js`
- `test/project-evidence-adapter.test.js`

Evidence dimensions:

```text
PRODUCT_REALITY
USERS_GROWTH
REVENUE_FEES
TVL_ACTIVITY
DEVELOPER_ACTIVITY
TOKEN_UTILITY
ECOSYSTEM_INTEGRATIONS
```

Rules existing tetap berlaku:

- source lineage;
- freshness;
- verified adapter;
- independent source coverage;
- as-of validation;
- unknown dimensions;
- no market activity substitution.

### M7.2 Outcome worker

Pindahkan:

- outcome checkpoint labeling;
- evaluation report computation;
- retention cleanup;
- large historical reads

ke work item/background path.

Dashboard GET:

- read latest persisted report;
- tidak membuat `EvaluationRun`;
- tidak menjalankan full evaluation sinkron.

### M7.3 Retention policy

Tentukan:

| Data | Retention awal |
|---|---:|
| Provider request audit | 30–90 hari |
| Cache entries | TTL + 1 stale window |
| Work item success | 30 hari |
| Failed/dead-letter | 90 hari atau sampai resolved |
| Evaluation runs | 100 latest |
| Immutable observations | policy product, bukan purge otomatis tanpa approval |

### M7.4 M7 gate

**Pass jika:**

- project evidence tidak menghambat scan market;
- outcome labeling dapat tertunda tanpa kehilangan signal lineage;
- evaluation GET read-only;
- retention job bounded;
- large history tidak memblokir API;
- evidence stale tetap capped.

---

## 13. M8 — Worker separation dan production hardening

**Tujuan:** memisahkan web read path dari ingestion/worker path dan menutup
reliability gap production.

**Ukuran:** XL, estimasi 4–8 minggu.  
**Dependency:** M3, M4, M5, M6, M7.  
**Criticality:** Production gate.

### M8.1 Process boundary

Target workflow:

```text
Start application
 └── web API/read surface

Radar worker
 └── scheduler + provider gateway + queue workers
```

Jika platform belum siap menambah workflow, gunakan process mode dengan feature
flag tetapi pertahankan interface boundary.

### M8.2 Graceful shutdown

Web:

- stop accepting new requests;
- finish bounded read requests;
- close server;
- preserve request IDs.

Worker:

- stop claiming new items;
- heartbeat running lease;
- requeue unfinished item;
- flush provider audit;
- close Prisma cleanly.

### M8.3 Queue recovery

Saat startup:

- recover expired leases;
- mark interrupted runs;
- requeue eligible work;
- leave permanent failure in DLQ;
- never duplicate completed idempotent work.

### M8.4 Operator surfaces

Tambahkan UI/API:

- provider health;
- budget remaining;
- queue depth;
- queue age;
- stale ratio;
- disagreement;
- DLQ;
- replay action;
- request lineage;
- last-known-good age.

### M8.5 Load/chaos gate

Wajib dijalankan:

- 1.000 token fixture;
- primary market 429;
- primary RPC timeout;
- database latency;
- worker kill;
- duplicate event burst;
- queue backlog;
- manual scan burst;
- provider schema invalid.

### M8 gate

**Pass jika:**

- web read API tetap hidup saat worker mati;
- worker restart memulihkan queue;
- no retry storm;
- p95 read API tetap dalam SLO;
- dead-letter visible;
- Phase 7 readiness report menyatakan operational evidence cukup;
- rollback ke baseline berhasil.

---

## 14. Work package dependency register

| ID | Work package | Depends on | Parallel dengan | Blocking |
|---|---|---|---|---|
| M0.1 | Call inventory | None | M0.2 | Yes |
| M0.2 | Baseline metrics | None | M0.1 | Yes |
| M0.3 | Load fixture | M0.1 | None | Yes |
| M1.1 | Adapter interface | M0 | None | Yes |
| M1.2 | Error taxonomy | M0 | M1.1 | Yes |
| M1.3 | Quota manager | M1.1 | M1.2 | Yes |
| M1.4 | Retry/backoff | M1.2 | M1.3 | Yes |
| M1.5 | Circuit standard | M1.2 | M1.3 | Yes |
| M1.6 | Call migration | M1.1–M1.5 | None | Yes |
| M1.7 | Request persistence | M0 | M1.1 | Yes |
| M2.1 | Cache contract | M1 | None | Yes |
| M2.2 | TTL policy | M2.1 | M2.3 | Yes |
| M2.3 | Cache storage | M1.7 | M2.2 | Yes |
| M2.4 | Coalescing | M2.1 | M2.2 | Yes |
| M3.1 | Work item schema | M1.7 | M2 | Yes |
| M3.2 | Worker lease | M3.1 | None | Yes |
| M3.3 | Priority | M3.1 | M3.2 | Yes |
| M3.4 | Tiered cadence | M2, M3.1 | M3.3 | Yes |
| M3.5 | Scan budget | M1.3, M3.4 | None | Yes |
| M4.1 | Provider selection | M1 | M2 | Yes |
| M4.2 | Secondary adapter | M4.1, M2 | None | Yes |
| M4.3 | Disagreement | M4.2 | M3 | No |
| M5.1 | RPC onboarding | M1 | M2 | Yes |
| M5.2 | RPC buckets | M1.3, M3 | None | Yes |
| M5.3 | Batch isolation | M5.1 | M5.2 | Yes |
| M5.4 | Slot cache | M2, M5.1 | M5.3 | No |
| M6.1 | Event provider | M5 | M4 | Yes |
| M6.2 | Event schema | M1.7 | M6.1 | Yes |
| M6.3 | Targeted refresh | M3, M6.2 | None | Yes |
| M7.1 | Project adapter | M1, M2 | M4 | No |
| M7.2 | Outcome worker | M3 | M7.1 | Yes |
| M7.3 | Retention | M1.7, M3.1 | M7.2 | Yes |
| M8.1 | Process boundary | M3, M7 | M4–M6 | Yes |
| M8.2 | Shutdown/recovery | M3.2 | M8.1 | Yes |
| M8.3 | Operator surfaces | M1.7, M3.1 | M4 | No |
| M8.4 | Chaos/load gate | All | None | Yes |

---

## 15. Database migration sequence

Schema migration harus dilakukan secara additive.

### D1 — Provider request

Tambahkan:

- `ProviderRequest`;
- indexes provider/capability/status/correlation.

Validasi:

- write one request;
- query by correlation;
- no secret persisted.

### D2 — Provider health

Tambahkan:

- `ProviderHealthSnapshot`;
- provider/capability unique key;
- time index.

Validasi:

- upsert health;
- cooldown persistence;
- read safe summary.

### D3 — Cache

Tambahkan:

- `ProviderCacheEntry`;
- unique cache key;
- expires/stale indexes.

Validasi:

- fresh read;
- stale read;
- expired deletion/eviction.

### D4 — Work queue

Tambahkan:

- `WorkItem`;
- `WorkItemAttempt`;
- lease fields;
- queue status indexes.

Validasi:

- atomic claim;
- lease expiration;
- retry;
- dead-letter.

### D5 — Event ingestion

Tambahkan:

- `ChainEvent`;
- unique provider/event ID;
- cursor table;
- backfill audit.

Validasi:

- duplicate event;
- cursor advance;
- gap state.

### D6 — Operator audit

Tambahkan:

- `OperatorAction`;
- replay/disable/enable audit;
- idempotency key.

Tidak boleh menjalankan migration production langsung dari startup.

---

## 16. API implementation sequence

### API-1 Provider health

```text
GET /api/provider-health
```

Response wajib:

```json
{
  "ok": true,
  "providers": [],
  "generatedAt": "2026-09-08T00:00:00.000Z",
  "requestId": "..."
}
```

Tidak mengembalikan URL credential.

### API-2 Queue status

```text
GET /api/queue?kind=&status=&limit=
```

Wajib:

- bounded limit;
- pagination/cursor;
- role/auth policy;
- queue age;
- priority;
- status.

### API-3 Provider request audit

```text
GET /api/provider-requests?provider=&capability=&status=&limit=
```

Wajib:

- tidak mengembalikan raw secret;
- response hash dan request ID boleh ditampilkan;
- raw payload tidak default ditampilkan;
- bounded query.

### API-4 Token lineage

```text
GET /api/tokens/:mint/lineage
```

Wajib menampilkan:

- source;
- provider;
- endpoint label;
- observed time;
- provider updated time;
- response hash;
- freshness;
- disagreement;
- security/RPC slot;
- related work item.

### API-5 Dead-letter

```text
GET /api/dead-letter
POST /api/dead-letter/:id/requeue
```

Mutation requeue:

- auth;
- idempotency;
- operator audit;
- max replay count;
- correlation ID baru.

---

## 17. Feature flag rollout matrix

| Flag | Default dev | Default production | Aktif setelah |
|---|---:|---:|---|
| `RADAR_PROVIDER_GATEWAY_ENABLED` | true | false | M1 canary |
| `RADAR_CACHE_ENABLED` | true | false | M2 gate |
| `RADAR_QUEUE_ENABLED` | false | false | M3 gate |
| `RADAR_TIERED_SCHEDULER_ENABLED` | false | false | M3 canary |
| `RADAR_SECONDARY_MARKET_ENABLED` | false | false | M4 shadow |
| `RADAR_DISAGREEMENT_BLOCKING` | false | false | M4 evidence gate |
| `RADAR_RPC_WORKLOAD_BUDGET_ENABLED` | true | false | M5 canary |
| `RADAR_EVENT_INGESTION_ENABLED` | false | false | M6 shadow |
| `RADAR_OUTCOME_WORKER_ENABLED` | false | false | M7 gate |
| `RADAR_SEPARATE_WORKER_ENABLED` | false | false | M8 gate |
| `RADAR_REQUIRE_AUTH` | false preview | true | Production |

Catatan: nama flag dapat disesuaikan saat implementasi, tetapi fungsi dan
default semantics tidak boleh berubah tanpa changelog.

---

## 18. Definition of Ready per fase

Fase siap dimulai jika:

- dependency gate sebelumnya lulus;
- owner tersedia;
- provider/config requirement jelas;
- schema impact diketahui;
- rollback tersedia;
- test plan ditulis;
- feature flag ditentukan;
- tidak ada secret yang dibutuhkan lewat chat;
- budget provider diketahui atau ditandai sebagai open decision.

Fase tidak ready jika:

- provider hanya tersedia melalui scraping tidak resmi;
- quota tidak diketahui;
- schema change membutuhkan destructive rewrite;
- acceptance criterion tidak dapat diukur;
- rollback hanya berupa “deploy versi lama” tanpa preservasi lineage.

---

## 19. Definition of Done per work package

Satu work package selesai jika:

1. code/konfigurasi sudah diimplementasikan;
2. schema development sudah disinkronkan jika diperlukan;
3. unit test lulus;
4. integration test lulus;
5. error path diuji;
6. metrics/log aman tersedia;
7. request lineage tersedia;
8. feature flag dan rollback terdokumentasi;
9. tidak ada credential di diff;
10. `git diff --check` lulus;
11. workflow restart dan smoke test lulus jika runtime berubah;
12. gate report diperbarui;
13. current PRD/roadmap changelog diperbarui jika kontrak berubah.

---

## 20. Test matrix keseluruhan

| Area | Unit | Contract | Integration | Load | Chaos | Gate |
|---|---:|---:|---:|---:|---:|---|
| Provider gateway | Yes | Yes | Yes | Yes | Yes | M1 |
| Quota/backoff | Yes | Yes | Yes | Yes | Yes | M1 |
| Cache/dedupe | Yes | No | Yes | Yes | Yes | M2 |
| Queue/lease | Yes | No | Yes | Yes | Yes | M3 |
| Scheduler | Yes | No | Yes | Yes | Yes | M3 |
| Secondary provider | Yes | Yes | Yes | Yes | No | M4 |
| RPC workload | Yes | Yes | Yes | Yes | Yes | M5 |
| Event ingestion | Yes | Yes | Yes | Yes | Yes | M6 |
| Project evidence | Yes | Yes | Yes | No | No | M7 |
| Outcome worker | Yes | No | Yes | Yes | Yes | M7 |
| Web/worker split | No | No | Yes | Yes | Yes | M8 |
| Operator APIs | Yes | No | Yes | Yes | Yes | M8 |

---

## 21. Operational runbooks yang wajib dibuat

### R1 — DexScreener 429

Isi:

- cara melihat provider health;
- cara melihat Retry-After;
- cara memastikan queue defer;
- cara mengaktifkan secondary discovery;
- cara menilai stale board;
- cara memulihkan provider.

### R2 — RPC primary down

Isi:

- cara memastikan secondary sehat;
- cara melihat slot freshness;
- cara menghentikan holder enrichment;
- cara menjaga security budget;
- cara mengaktifkan emergency provider;
- cara memverifikasi fail-closed.

### R3 — Queue backlog

Isi:

- queue depth;
- oldest item;
- provider bottleneck;
- priority starvation;
- safe rate reduction;
- replay policy.

### R4 — Dead-letter

Isi:

- klasifikasi permanent/transient;
- lineage inspection;
- safe requeue;
- max replay;
- operator audit.

### R5 — Last-known-good terlalu tua

Isi:

- provider state;
- cache stale state;
- scan persistence;
- database health;
- safe operator communication;
- no manual data invention.

### R6 — Schema/API provider berubah

Isi:

- freeze adapter;
- mark schema error;
- preserve raw hash where safe;
- disable provider capability;
- run contract fixture;
- rollout adapter version baru.

---

## 22. Gate go/no-go global

### Gate G0 — Baseline

Go jika M0 lulus dan baseline dapat diulang.

### Gate G1 — Provider gateway

Go jika tidak ada direct outbound provider call di luar gateway.

### Gate G2 — Duplicate control

Go jika duplicate request <5% pada fixture/load baseline.

### Gate G3 — Scheduler transition

Go jika full scan 15 detik sudah digantikan oleh tiered queue tanpa kehilangan
watchlist freshness.

### Gate G4 — Multi-source

Go jika secondary provider dapat berjalan shadow dan disagreement terlihat.

### Gate G5 — RPC production readiness

Go jika minimal dua RPC provider berbeda, workload budget, slot evidence, dan
failover test lulus.

### Gate G6 — Event readiness

Go jika duplicate/out-of-order/gap/backfill test lulus dan periodic fallback
tetap aktif.

### Gate G7 — Worker isolation

Go jika slow worker tidak mengganggu API read dan recovery lulus.

### Gate G8 — Production

Go hanya jika:

- Phase 7 readiness lulus;
- operational evidence lengkap;
- no critical security finding;
- no unbounded request/query;
- mutation auth aktif;
- rollback diuji;
- SLO load test lulus;
- operator runbook tersedia.

---

## 23. Risiko dan mitigasi

| Risiko | Dampak | Mitigasi |
|---|---|---|
| Secondary provider coverage buruk | Discovery tetap terbatas | Shadow coverage metric; jangan blocking sebelum sample |
| Provider quota tidak transparan | Budget salah | Conservative budget + 429 telemetry |
| Queue terlalu kompleks | Delivery terlambat | Mulai in-process, schema stabil, worker split belakangan |
| Cache stale dipercaya sebagai fresh | False confidence | Status dan age wajib di response/score gate |
| Multi-source mismatch | Candidate salah | Disagreement evidence, no silent average |
| RPC provider sama failure domain | Failover palsu | Provider/account berbeda |
| Webhook missing event | State stale | Cursor gap + periodic backfill |
| Database queue tumbuh | Storage/performance | Retention + bounded query + DLQ policy |
| Manual force refresh abuse | Quota habis | Emergency budget + auth + rate limit |
| Schema migration mengganggu runtime | Downtime | Additive migration + publish review |
| Worker crash | Lost work | Lease recovery + idempotency |
| Feature flags tidak konsisten | Mixed behavior | Config hash + startup report |

---

## 24. Keputusan terbuka yang harus diselesaikan

Sebelum M4:

1. Provider secondary market yang dipilih.
2. Capability yang tersedia.
3. Quota dan biaya bulanan.

Sebelum M5:

1. RPC primary.
2. RPC secondary dari failure domain berbeda.
3. Emergency fallback.
4. Budget unit masing-masing provider.

Sebelum M6:

1. Webhook versus Geyser/WebSocket.
2. Program/pool yang akan dipantau.
3. Event retention.
4. Backfill maximum slot/time.

Sebelum M8:

1. Worker sebagai workflow terpisah atau process terkelola.
2. Production SLO final.
3. On-call/operator owner.
4. Audit retention dan biaya database.

Keputusan terbuka tidak boleh diisi dengan asumsi diam-diam. Jika belum
diputuskan, feature tetap shadow/disabled.

---

## 25. Checklist eksekusi pertama

Urutan yang langsung dapat dikerjakan:

- [x] Buat `docs/provider-call-inventory.md`.
- [x] Tambahkan baseline observability test tanpa mengubah runtime behavior.
- [x] Buat synthetic baseline fixture untuk 10/100/1.000 token dan provider failures.
- [x] Buat M0 gate report.
- [x] Jalankan test suite dan runtime smoke.
- [ ] Tambahkan test provider gateway tanpa mengubah runtime behavior.
- [ ] Buat error taxonomy canonical.
- [ ] Buat quota manager in-memory untuk unit test.
- [ ] Migrasikan satu capability DexScreener ke gateway.
- [ ] Tambahkan ProviderRequest additive schema.
- [ ] Jalankan Prisma development sync.
- [ ] Migrasikan capability DexScreener berikutnya.
- [ ] Migrasikan RPC single/batch request.
- [ ] Aktifkan gateway dalam shadow/canary.
- [ ] Implementasikan cache contract.
- [ ] Implementasikan request coalescing.
- [ ] Ukur duplicate request rate.
- [ ] Baru setelah itu mulai persistent queue.

---

## 26. Pernyataan keberhasilan

Roadmap ini dianggap berhasil bukan ketika jumlah provider bertambah, tetapi
ketika sistem dapat menunjukkan secara terukur bahwa:

1. provider failure tidak mematikan API read;
2. rate limit tidak menghasilkan retry storm;
3. request identik tidak dikirim berulang;
4. workload penting tetap mendapat quota;
5. scan cadence menyesuaikan nilai dan freshness token;
6. source disagreement terlihat dan tidak disembunyikan;
7. stale evidence tidak berubah menjadi confidence;
8. queue dapat pulih setelah restart;
9. setiap angka dapat ditelusuri ke source/request/response;
10. operator dapat melakukan rollback tanpa kehilangan histori;
11. Phase 2–7 safety boundary tetap utuh;
12. sistem dapat menambah provider tanpa menulis ulang core Radar.

> Urutan implementasi harus selalu mengutamakan bounded work, explicit
> uncertainty, dan preservasi last-known-good state sebelum mengejar coverage
> atau frekuensi scan yang lebih tinggi.