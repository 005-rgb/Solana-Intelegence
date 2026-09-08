# PRD: Provider-Resilient Solana Radar Data Platform

## Dokumen Persyaratan Produk dan Implementasi

---

**Versi:** 1.0  
**Tanggal:** 2026-09-08  
**Status:** Draft implementable  
**Owner/Driver:** Product owner Solana Radar  
**Approver:** Product owner Solana Radar  
**Kontributor:** Engineering backend, data/reliability engineering, QA/security  
**Informed:** Operator Radar, reviewer Phase 7, future wallet/execution team  
**Dokumen terkait:** `docs/integrated-radar-core-market-brain-prd.md`, `replit.md`, `docs/solana-rpc-pool-template.md`

### Changelog

| Versi | Tanggal | Perubahan |
|---|---|---|
| 1.0 | 2026-09-08 | PRD awal untuk seluruh usulan reliability data provider dan anti-rate-limit |

---

## 1. Ringkasan eksekutif

Solana Radar saat ini sudah memiliki DexScreener, Solana RPC pool, Jupiter quote
adapter, database PostgreSQL/Prisma, fail-closed evidence, provider lineage,
retry terbatas, circuit breaker, dan scheduler scan.

Risiko utama berikutnya bukan lagi sekadar “menambah API”. Risiko utamanya adalah
pipeline terlalu sering meminta data yang sama, semua workload berbagi quota yang
sama, discovery dan deep verification berjalan pada ritme yang sama, serta
fallback publik tidak cocok untuk beban production.

PRD ini mendefinisikan pembangunan lanjutan untuk mengubah pipeline menjadi
platform data yang:

1. tidak bergantung pada satu market-data provider;
2. tidak menganggap fallback provider sebagai sumber data setara tanpa lineage;
3. tidak melakukan full rescan pada seluruh token setiap 15 detik;
4. menggunakan cache, TTL, priority queue, quota budget, backoff, dan circuit
   breaker secara terpisah per provider dan workload;
5. memisahkan market discovery, chain truth, execution quote, event ingestion,
   project evidence, dan outcome labeling;
6. tetap fail-closed ketika data tidak tersedia;
7. mempertahankan last-known-good board tanpa menyamarkan data stale sebagai
   data fresh;
8. dapat mengukur kesehatan provider, konsumsi quota, freshness, coverage,
   disagreement, dan kualitas hasil scan;
9. dapat berjalan pada satu workflow Replit terlebih dahulu, tetapi memiliki
   boundary yang siap dipisahkan menjadi worker terpisah;
10. tidak mengaktifkan wallet signing, real-fund execution, atau probability
    claims.

PRD ini menerima seluruh usulan reliability yang telah disepakati:

- secondary market-data provider;
- minimal dua RPC dedicated dari provider berbeda;
- event-driven Solana ingestion;
- tiered scanning;
- TTL cache per tipe data;
- request deduplication;
- adaptive backoff;
- per-provider quota budget;
- priority queue;
- workload isolation;
- disagreement reporting;
- persistent provider telemetry;
- dead-letter handling;
- replayable request lineage;
- worker separation sebagai target arsitektur.

---

## 2. Masalah yang diselesaikan

### 2.1 Masalah pengguna/operator

Operator membutuhkan board Radar yang tetap berguna ketika:

- DexScreener memberi HTTP 429;
- satu RPC provider timeout;
- data market terlambat diperbarui;
- holder enrichment terlalu mahal;
- quote provider sedang gagal;
- satu scan manual berjalan bersamaan dengan scheduler;
- provider kedua memiliki data berbeda;
- jumlah token dan histori bertumbuh;
- network Solana sedang padat;
- aplikasi harus mempertahankan last-known-good state.

### 2.2 Masalah sistem saat ini

Baseline saat ini memiliki beberapa batasan arsitektur:

1. Discovery provider dan deep verification dipicu oleh scheduler yang sama.
2. Market discovery berpotensi memanggil endpoint yang sama berulang kali.
3. Scan 15 detik terlalu agresif jika diterapkan ke semua token.
4. RPC pool sudah failover, tetapi belum memiliki budget terpisah per workload.
5. Fallback public RPC dapat terkena limit dan tidak cocok untuk bulk enrichment.
6. Cache belum memiliki kebijakan TTL yang eksplisit per jenis evidence.
7. Belum ada priority queue persisten untuk membagi pekerjaan berdasarkan
   urgensi.
8. Belum ada secondary market provider yang benar-benar terintegrasi sebagai
   sumber pembanding.
9. Belum ada event-driven on-chain ingestion.
10. Belum ada dead-letter/replay flow yang lengkap untuk request gagal.
11. Satu process menangani HTTP API, scheduler, provider call, RPC call, dan
    persistence.
12. Provider disagreement belum menjadi output operasional yang eksplisit.

### 2.3 Prinsip utama

> Rate limit bukan error yang boleh disembunyikan. Rate limit adalah evidence
> operasional yang harus dicatat, dihormati, dan memicu pengurangan beban.

---

## 3. Tujuan dan hasil yang diharapkan

### 3.1 Tujuan produk

Menyediakan Radar research platform yang tetap:

- hidup ketika satu provider gagal;
- akurat dalam membedakan fresh, stale, failed, dan unknown;
- hemat quota;
- dapat menjelaskan asal setiap angka;
- dapat menurunkan frekuensi scan secara adaptif;
- dapat memprioritaskan kandidat yang paling bernilai;
- tidak membuat kandidat lolos hanya karena fallback atau data parsial;
- dapat diaudit sampai level request dan response.

### 3.2 Tujuan teknis

Pada akhir implementasi:

- setiap provider memiliki adapter, health state, quota budget, dan circuit
  sendiri;
- setiap workload memiliki queue dan budget sendiri;
- discovery, security, holder taxonomy, quotes, project evidence, dan outcomes
  memiliki cadence berbeda;
- request identik dapat dideduplikasi;
- cache menyimpan freshness dan lineage;
- HTTP 429 menghormati `Retry-After`;
- retry memakai exponential backoff dengan jitter dan batas biaya;
- secondary source tidak menggantikan source utama secara diam-diam;
- data disagreement terlihat pada audit;
- worker gagal tidak memblokir API read surface;
- request gagal dapat direplay berdasarkan lineage;
- smoke test dan load test memverifikasi anti-rate-limit behavior.

### 3.3 Non-goals

PRD ini tidak mencakup:

- wallet custody;
- penyimpanan private key;
- wallet signing;
- real-fund trading;
- autonomous trading;
- profit guarantee;
- probability claims;
- penggantian Phase 2 safety gate;
- penghapusan DexScreener;
- penggabungan angka lintas provider secara diam-diam;
- scraping yang melanggar terms provider;
- bypass rate limit;
- rotating proxy untuk menghindari quota;
- menaruh API key di source code;
- startup-time DDL production;
- deploy-time `db:push`;
- migrasi production secara langsung dari agent.

---

## 4. Keputusan arsitektur yang wajib

### 4.1 Hierarki kebenaran

Setiap sumber memiliki boundary kebenaran yang berbeda:

| Domain evidence | Sumber utama | Sumber pembanding | Aturan |
|---|---|---|---|
| Market discovery | DexScreener | Birdeye/GeckoTerminal/indexer | Discovery tidak sama dengan quality |
| Pair market data | DexScreener | Secondary market provider | Disagreement disimpan, tidak dirata-rata otomatis |
| Mint/token program | Solana RPC | RPC provider kedua | On-chain evidence lebih tinggi dari metadata provider |
| Supply/largest accounts | Solana RPC | RPC provider kedua | Harus punya slot context dan freshness |
| Account taxonomy | Solana RPC + pool evidence | Indexer/event source | Unknown tetap unknown |
| Route/quote | Jupiter | Quote adapter kedua | Quote bukan bukti security |
| Project reality | Verified project adapters | Multiple independent sources | Market activity tidak boleh menjadi traction |
| Trade events | Event/indexer provider | RPC backfill | Event source harus punya lineage |
| Outcome labels | Persisted observations | Tidak ada source pengganti | Tidak boleh mengarang coverage |

### 4.2 Multi-provider bukan multi-credential semata

Reliability dianggap valid hanya jika ada provider berbeda secara infrastruktur.
Beberapa API key pada provider yang sama tidak dihitung sebagai independent
failover kecuali provider menyatakan quota dan failure domain terpisah.

### 4.3 Fail-closed

Jika evidence wajib tidak tersedia:

- status menjadi `UNKNOWN`, `STALE`, `FAILED`, atau `UNVERIFIED`;
- kandidat tidak boleh naik menjadi qualifying hanya karena source lain kosong;
- last-known-good board dapat tetap ditampilkan, tetapi diberi umur dan status;
- scan audit harus mencatat sumber kegagalan;
- provider failure tidak boleh dihitung sebagai zero liquidity, zero volume,
  zero holders, atau zero return.

### 4.4 Read path dan write/ingestion path terpisah

API dashboard harus dapat membaca last-known-good state tanpa menunggu
provider request. Provider call hanya dilakukan oleh ingestion worker/scheduler.

---

## 5. Source registry

### 5.1 DexScreener

#### Peran

- discovery boosts;
- token profiles;
- latest/new pairs;
- pair price;
- liquidity;
- market cap/FDV;
- volume;
- transactions;
- makers;
- price change;
- pair age;
- metadata link.

#### Aturan

- DexScreener tidak boleh menjadi bukti security on-chain.
- Boost tidak boleh menjadi quality score.
- Response payload harus divalidasi terhadap `dexscreener-v1`.
- Pair discovery dan pair detail memiliki lineage request terpisah.
- Response hash wajib dipersist pada observation.
- HTTP 429 wajib menurunkan provider health dan memicu backoff.
- Endpoint yang gagal tidak boleh dianggap sebagai empty successful feed.

#### Environment

```env
DEXSCREENER_API_URL
DEXSCREENER_PROFILES_API_URL
DEXSCREENER_NEW_PAIRS_API_URL
DEXSCREENER_LATEST_PAIRS_API_URL
DEXSCREENER_PAIR_API_URL
```

### 5.2 Solana RPC pool

#### Peran

- `getAccountInfo`;
- `getTokenSupply`;
- `getTokenLargestAccounts`;
- account owner enrichment;
- Token-2022 extension inspection;
- slot context;
- batch request;
- optional event backfill.

#### Aturan

- production minimal dua provider dedicated berbeda;
- fallback public hanya untuk emergency/development;
- setiap endpoint memiliki health, cooldown, failure count, HTTP status,
  provider label, dan last success;
- batch size harus bounded;
- workload holder enrichment tidak boleh menghabiskan quota security check;
- commitment dan slot context wajib dicatat;
- endpoint dashboard/API-management ditolak;
- secret hanya melalui Replit Secrets.

#### Environment

```env
SOLANA_RPC_URL
SOLANA_RPC_URLS
SOLANA_RPC_PRIMARY_PROVIDER
SOLANA_RPC_SECONDARY_PROVIDER
SOLANA_RPC_EMERGENCY_PROVIDER
```

### 5.3 Jupiter quote adapter

#### Peran

- research-only buy quote;
- research-only sell quote;
- route availability;
- slippage;
- price impact;
- fee evidence;
- freshness.

#### Aturan

- quote tidak berarti transaction executable;
- missing sell evidence tetap `UNKNOWN`;
- quote failure harus memiliki reason code;
- quote endpoint memiliki cache failure singkat untuk mencegah retry storm;
- quote hanya dipanggil setelah kandidat melewati market/security gates;
- quote tidak boleh dipanggil untuk seluruh discovery universe.

#### Environment

```env
RADAR_EXECUTION_QUOTES_ENABLED
RADAR_EXECUTION_QUOTE_URL
RADAR_EXECUTION_QUOTE_SECONDARY_URL
RADAR_EXECUTION_QUOTE_MINT
```

### 5.4 Secondary market provider

Provider sekunder dapat berupa Birdeye, GeckoTerminal, atau provider
market-data lain yang memiliki API resmi dan kontrak penggunaan yang sesuai.

#### Peran

- cross-check harga/liquidity/volume;
- memperluas discovery;
- mengisi gap ketika DexScreener unavailable;
- membangun disagreement evidence;
- bukan untuk menghapus source lineage utama.

#### Persyaratan adapter

Setiap adapter harus mengimplementasikan:

```js
{
  providerId,
  adapterVersion,
  capabilities,
  discover({ signal, cursor }),
  fetchPair({ mint, pairAddress, signal }),
  fetchMetadata({ mint, signal }),
  normalize(payload),
  validate(normalized),
  classifyError(error),
  health(),
}
```

Capability harus eksplisit:

```text
DISCOVERY
PAIR_MARKET
TOKEN_METADATA
HISTORICAL_CANDLES
TRADE_ACTIVITY
HOLDER_DATA
PROJECT_METADATA
```

Provider tidak boleh dipanggil untuk capability yang tidak dimilikinya.

### 5.5 Indexed discovery adapter

`RADAR_INDEXED_DISCOVERY_URL` dapat mengembalikan:

```json
[
  {
    "tokenAddress": "...",
    "chainId": "solana",
    "updatedAt": "2026-09-08T00:00:00.000Z",
    "source": "indexed-provider",
    "sourceRequestId": "...",
    "confidence": "UNKNOWN"
  }
]
```

Indexed discovery hanya memperluas universe. Ia tidak boleh:

- menaikkan score dengan sendirinya;
- dianggap sebagai security verification;
- menggantikan RPC;
- menghapus token yang berasal dari source lain.

### 5.6 Event-driven Solana ingestion

Target provider/teknologi:

- Helius webhooks;
- Yellowstone Geyser gRPC;
- Solana WebSocket subscriptions;
- enhanced transaction/webhook provider;
- AMM/program-specific event indexer.

#### Peran

- mendeteksi token/pair yang berubah;
- mendeteksi liquidity add/remove;
- mendeteksi swap burst;
- mendeteksi authority/account change;
- memicu targeted revalidation;
- mengurangi full polling.

#### Aturan

- webhook harus idempotent;
- signature/event ID disimpan;
- event yang terlambat tidak boleh menimpa observation baru;
- event harus memiliki observed time dan provider received time;
- event source tidak boleh dianggap benar jika schema invalid;
- event gap memicu bounded RPC backfill, bukan infinite retry.

### 5.7 Project evidence sources

Project evidence memerlukan source yang benar-benar relevan terhadap:

- product reality;
- users and growth;
- revenue/fees;
- TVL/economic activity;
- developer activity;
- token utility/tokenomics;
- ecosystem integrations.

Contoh source yang dapat diintegrasikan:

- official project documentation;
- verified project API;
- protocol analytics;
- GitHub activity;
- chain-level usage;
- verified integrations;
- revenue/fee analytics.

Social link dari DexScreener hanya metadata discovery. Ia tidak cukup untuk
menyatakan product traction.

---

## 6. Model data dan lineage

### 6.1 Provider request record

Tambahkan model/struktur setara `ProviderRequest`:

| Field | Tipe | Wajib | Keterangan |
|---|---|---:|---|
| id | string | Ya | ID internal |
| providerId | string | Ya | `dexscreener`, `helius`, dll |
| adapterVersion | string | Ya | Versi adapter |
| capability | enum | Ya | Discovery, pair, security, quote, dll |
| endpointLabel | string | Ya | Label aman tanpa secret |
| requestHash | string | Ya | Hash method + normalized params |
| correlationId | string | Ya | Korelasi scan |
| requestId | string | Ya | ID provider/request |
| startedAt | datetime | Ya | Waktu mulai |
| completedAt | datetime | Tidak | Waktu selesai |
| status | enum | Ya | SUCCESS/429/TIMEOUT/5XX/SCHEMA/REJECTED |
| httpStatus | integer | Tidak | Status HTTP |
| retryAfterMs | integer | Tidak | Nilai dari provider |
| attempt | integer | Ya | Nomor attempt |
| latencyMs | integer | Tidak | Durasi |
| responseHash | string | Tidak | Hash payload |
| responseBytes | integer | Tidak | Ukuran response |
| errorCode | string | Tidak | Reason code |
| quotaClass | string | Ya | Budget bucket |
| createdAt | datetime | Ya | Audit creation |

### 6.2 Provider health record

| Field | Keterangan |
|---|---|
| providerId | Provider |
| capability | Workload |
| state | HEALTHY/DEGRADED/OPEN/EXHAUSTED/DISABLED |
| consecutiveFailures | Failure berturut-turut |
| rateLimitCount | Jumlah 429 |
| timeoutCount | Jumlah timeout |
| p50/p95 latency | Latency window |
| lastSuccessAt | Success terakhir |
| cooldownUntil | Cooldown |
| remainingBudget | Estimasi budget |
| lastRetryAfterMs | Retry-After terakhir |
| updatedAt | Waktu update |

### 6.3 Cache entry

Cache harus memiliki:

```text
cacheKey
providerId
capability
entityType
entityId
payload
payloadHash
sourceObservedAt
cachedAt
expiresAt
staleUntil
status
sourceRequestId
responseHash
slot
schemaVersion
```

`expiresAt` dan `staleUntil` berbeda:

- sebelum `expiresAt`: `FRESH`;
- setelah `expiresAt` tetapi sebelum `staleUntil`: `STALE_BUT_USABLE`;
- setelah `staleUntil`: `EXPIRED`;
- request failure: `FAILED`;
- bukti tidak cukup: `UNKNOWN`.

### 6.4 Work item

Work item harus memiliki:

```text
id
kind
priority
entityType
entityId
providerPreference
dedupeKey
payload
notBefore
attemptCount
maxAttempts
leaseOwner
leaseUntil
status
lastErrorCode
lastProviderRequestId
createdAt
updatedAt
```

Jenis work:

```text
DISCOVERY
PAIR_REFRESH
SECURITY_VERIFY
HOLDER_ENRICHMENT
EXECUTION_QUOTE
EVENT_BACKFILL
PROJECT_EVIDENCE
OUTCOME_LABEL
EVALUATION
```

### 6.5 Dead-letter item

Work item masuk dead-letter jika:

- max attempts tercapai;
- schema response invalid berulang;
- provider configuration invalid;
- entity tidak valid;
- semua provider capability gagal;
- operator menandai permanent failure.

Dead-letter wajib menyimpan:

- work item asli;
- seluruh request lineage;
- error terakhir;
- error chain;
- provider attempts;
- replay eligibility;
- operator resolution.

---

## 7. Ingestion architecture

### 7.1 Komponen

```text
Provider adapters
        │
        ▼
Provider gateway
        │
        ├── quota manager
        ├── retry/backoff manager
        ├── circuit breaker
        ├── request deduper
        └── response validator
        │
        ▼
Priority work queue
        │
        ├── discovery worker
        ├── market worker
        ├── security worker
        ├── holder worker
        ├── quote worker
        ├── event backfill worker
        └── evaluation worker
        │
        ▼
Normalization + evidence gate
        │
        ▼
Immutable observations + cache + audit
        │
        ▼
Radar state / API read surface
```

### 7.2 Mode transisi

Implementasi boleh dimulai dalam satu Node process, tetapi interface worker harus
tidak bergantung pada HTTP request lifecycle.

Tahap awal:

```text
server.js
 ├── HTTP API
 ├── scheduler
 └── in-process workers
```

Target:

```text
web process
 └── read API + operator mutation

worker process
 ├── scheduler
 ├── provider gateway
 ├── queues
 └── persistence
```

Tidak boleh ada perubahan kontrak evidence ketika worker dipisah.

### 7.3 Read path

API dashboard:

- hanya membaca database/cache;
- tidak memanggil DexScreener secara sinkron;
- tidak memanggil RPC secara sinkron kecuali endpoint operator eksplisit;
- mengembalikan freshness dan source health;
- tidak membuat evaluation run pada GET;
- tidak memblokir karena provider sedang down.

---

## 8. Quota dan rate-limit management

### 8.1 Budget hierarchy

Budget harus memiliki hierarchy:

```text
global provider budget
  └── capability budget
       └── workload budget
            └── priority reservation
```

Contoh:

```text
DexScreener
 ├── discovery: 30%
 ├── pair refresh: 45%
 ├── metadata: 10%
 └── emergency/manual: 15%

Solana RPC
 ├── security: 35%
 ├── holder taxonomy: 20%
 ├── event backfill: 20%
 ├── outcome labeling: 15%
 └── emergency/manual: 10%
```

Angka awal dapat dikonfigurasi. Yang wajib adalah adanya reservasi agar workload
murah tidak menghabiskan quota workload kritis.

### 8.2 Token bucket

Setiap provider/capability memiliki:

```text
capacity
refillRate
reservedCapacity
priority
cooldown
```

Request baru boleh dijalankan hanya jika budget tersedia. Jika tidak:

- work item ditunda;
- `notBefore` dihitung;
- status scan menjadi `DEFERRED` atau `PARTIAL`;
- last-known-good state tetap tersedia;
- tidak dilakukan retry busy-loop.

### 8.3 Response 429

Jika provider mengirim HTTP 429:

1. parse `Retry-After`;
2. clamp ke batas aman minimum/maksimum;
3. set `cooldownUntil`;
4. kurangi concurrency provider;
5. tandai quota class;
6. schedule ulang work item dengan jitter;
7. jangan retry langsung;
8. catat request sebagai `RATE_LIMITED`.

Prioritas `Retry-After`:

```text
provider Retry-After
→ provider documented reset
→ exponential backoff
→ default cooldown
```

### 8.4 Exponential backoff

Formula:

```text
delay = min(maxDelay, baseDelay * 2^attempt) + random(0, jitter)
```

Rekomendasi:

| Parameter | Nilai awal |
|---|---:|
| Base delay | 250 ms |
| Jitter | 250–1000 ms |
| Max retry delay | 60 detik |
| Max provider attempts | 3 |
| Max work-item attempts | 5 |
| Circuit threshold | 3 failure |
| Initial cooldown | 30 detik |
| Maximum cooldown | 15 menit |

Nilai provider-specific boleh berbeda, tetapi wajib tercatat dalam configuration
hash.

### 8.5 Concurrency

Concurrency harus dikontrol per:

- provider;
- capability;
- endpoint;
- work class;
- scan correlation;
- emergency/manual request.

Default awal:

```text
DexScreener discovery: 1
DexScreener pair: 2–4
RPC security batch: 2
RPC holder enrichment: 1
Quote provider: 2
Project evidence: 1
```

Tidak boleh memakai `Promise.all` tanpa batas pada provider response.

### 8.6 Request deduplication

Request dianggap duplikat jika memiliki `dedupeKey` sama dan status:

- `QUEUED`;
- `RUNNING`;
- `SUCCESS` dalam TTL aktif;
- `STALE_BUT_USABLE` jika caller menerima stale data.

Contoh dedupe key:

```text
pair-refresh:dexscreener:solana:<mint>:<pair>:<bucket-30s>
security:solana-rpc:<mint>:<slot-or-time-bucket>
quote:jupiter:<mint>:<side>:<size>:<bucket-5s>
```

Request manual dapat mem-bypass cache hanya jika operator memilih force refresh
dan memiliki quota emergency.

---

## 9. Scheduling dan priority

### 9.1 Discovery cadence

| Workload | Cadence default | Prioritas |
|---|---:|---|
| Watchlist active | 10–15 detik | P0 |
| Candidate passed Phase 2 | 15–30 detik | P0 |
| Candidate nearly complete | 30–60 detik | P1 |
| New pair discovery | 2–5 menit | P1 |
| Token profiles/metadata | 6–24 jam | P3 |
| Rejected token retry | 5–30 menit | P3 |
| Security refresh | 5–15 menit | P1 |
| Holder taxonomy | 30–60 menit | P2 |
| Project traction | 6–24 jam | P3 |
| Event backfill | Triggered | P1 |
| Outcome checkpoints | Background batch | P2 |
| Evaluation | Operator/scheduled batch | P3 |

### 9.2 Priority rules

Priority tertinggi:

1. active watchlist;
2. security invalidation/event;
3. candidate yang sedang qualifying;
4. candidate yang hampir lengkap evidence;
5. pair dengan liquidity/price event;
6. new discovery;
7. stale rejected;
8. metadata dan project refresh.

### 9.3 Adaptive cadence

Cadence harus berubah berdasarkan:

- provider health;
- token volatility;
- recent event activity;
- candidate lifecycle state;
- data freshness;
- quota remaining;
- previous request cost;
- manual operator priority.

Jika provider degraded:

- turunkan discovery frequency;
- pertahankan watchlist critical;
- hentikan holder enrichment;
- hentikan quote untuk non-qualifying;
- gunakan cache stale dengan label;
- jangan menghapus board.

### 9.4 Scan budget

Setiap scheduled scan memiliki budget:

```text
maxDurationMs
maxProviderRequests
maxRpcUnits
maxTokensDiscovered
maxDeepChecks
maxQuotes
```

Jika budget habis:

- scan diselesaikan sebagai `PARTIAL_BUDGET`;
- work item yang belum berjalan dikembalikan ke queue;
- board lama dipertahankan;
- audit mencatat reason code.

---

## 10. Cache policy

### 10.1 TTL awal

| Data | Fresh TTL | Stale usable | Catatan |
|---|---:|---:|---|
| Discovery feed | 2 menit | 10 menit | Tidak boleh menghapus universe |
| Pair price/liquidity kandidat | 15 detik | 60 detik | Watchlist lebih prioritas |
| Pair price/liquidity biasa | 2 menit | 10 menit | Tidak untuk actionability |
| Token metadata | 6 jam | 24 jam | Metadata bukan market truth |
| Mint account | 30 menit | 2 jam | Authority/security |
| Supply | 10 menit | 30 menit | Slot dicatat |
| Largest accounts | 10 menit | 30 menit | Holder evidence |
| Account taxonomy | 30 menit | 2 jam | Expensive enrichment |
| Execution quote | 5 detik | 15 detik | Stale quote tidak actionable |
| Quote failure | 10 detik | Tidak ada | Hindari retry storm |
| Project evidence | 6 jam | 24 jam | Sumber harus fresh sesuai domain |
| Event cursor | Immediate | N/A | Gap memicu backfill |

### 10.2 Cache correctness

Cache tidak boleh:

- menghapus source lineage;
- mencampur chain;
- menyamakan pair berbeda;
- menggunakan data future terhadap `asOf`;
- mengubah stale menjadi fresh;
- mengubah failure menjadi empty feed;
- menimpa data lebih baru dengan response lebih lama.

### 10.3 Last-known-good

Last-known-good board menyimpan:

```text
boardGeneratedAt
lastSuccessfulScanAt
sourceFreshness
staleReason
providerHealth
```

UI wajib menampilkan perbedaan:

```text
LIVE
STALE BUT USABLE
DEGRADED
FAILED
UNKNOWN
```

---

## 11. RPC batching dan event strategy

### 11.1 Batch policy

Batch harus:

- memiliki ukuran maksimal;
- memiliki timeout;
- dapat di-retry per sub-request;
- menyimpan status setiap item;
- tidak membuat satu item gagal menggagalkan semua item valid;
- mempertahankan slot context tiap response;
- memisahkan batch security dan batch holder.

### 11.2 Slot-aware cache

Key RPC:

```text
<method>:<normalized-params>:<commitment>:<slot-bucket>
```

Response dengan slot lebih tua tidak boleh mengalahkan response slot lebih baru.

### 11.3 Event-triggered refresh

Event berikut memicu targeted work:

- mint authority change;
- freeze authority change;
- supply change;
- liquidity add/remove;
- swap burst;
- pool account change;
- holder concentration change;
- Token-2022 extension relevant change.

Tanpa event, scheduler tetap melakukan periodic revalidation dengan TTL.

### 11.4 Backfill

Backfill memiliki:

- cursor;
- max slots;
- max transactions;
- max duration;
- provider budget;
- dead-letter setelah gagal berulang.

Tidak boleh ada backfill tanpa batas berdasarkan “selama masih ada data”.

---

## 12. Provider disagreement

### 12.1 Jenis disagreement

Disagreement minimum:

- price delta;
- liquidity delta;
- market cap delta;
- volume delta;
- pair existence;
- pair address;
- token metadata;
- token decimals;
- security slot/freshness;
- holder count.

### 12.2 Threshold awal

Threshold harus configurable dan versioned:

| Field | Warning | Blocking |
|---|---:|---:|
| Price | >2% | >10% |
| Liquidity | >10% | >30% |
| Market cap | >15% | >40% |
| Volume | >25% | >60% |
| Pair identity | Any mismatch | Any mismatch |
| Security state | Any mismatch | Any mismatch |

Threshold bukan keputusan trading. Threshold hanya memengaruhi:

- confidence;
- freshness;
- evidence quality;
- actionability;
- operator alert.

### 12.3 Output disagreement

Contoh:

```json
{
  "status": "DISAGREEMENT",
  "fields": ["liquidityUsd", "priceUsd"],
  "sources": ["dexscreener", "secondary-market"],
  "observedAt": "2026-09-08T00:00:00.000Z",
  "blocking": false,
  "reasonCodes": ["MARKET_SOURCE_DIVERGENCE"]
}
```

---

## 13. API dan operator contract

### 13.1 Read endpoints

Tambahkan/pertahankan endpoint:

```text
GET /api/state
GET /api/phase7
GET /api/evaluation
GET /api/outcomes
GET /api/alerts
GET /api/reactivation
GET /api/provider-health
GET /api/provider-requests
GET /api/queue
GET /api/dead-letter
GET /api/tokens/:mint/lineage
```

Endpoint read:

- tidak memicu provider fetch;
- tidak membuat evaluation run;
- memiliki `X-Request-ID`;
- mengembalikan freshness;
- membatasi pagination;
- tidak mengembalikan secret URL atau credential.

### 13.2 Operator mutation endpoints

```text
POST /api/scan
POST /api/scan/:id/replay
POST /api/work-items/:id/retry
POST /api/dead-letter/:id/requeue
POST /api/provider/:id/disable
POST /api/provider/:id/enable
POST /api/phase7/rollback
POST /api/alerts/:id/acknowledge
POST /api/alerts/:id/resolve
```

Semua mutation:

- membutuhkan origin validation;
- membutuhkan auth ketika `RADAR_REQUIRE_AUTH=true` atau production;
- menggunakan rate limit mutation;
- memiliki idempotency key untuk operasi yang dapat diulang;
- menyimpan operator audit event;
- tidak menerima secret melalui body;
- tidak menampilkan credential dalam error.

### 13.3 Manual force refresh

Force refresh:

- hanya berlaku untuk satu entity atau bounded list;
- memakai emergency quota;
- memiliki cooldown operator;
- tidak membypass safety gate;
- tidak boleh mengaktifkan full universe rescan;
- harus menyatakan `force=true` pada audit request.

---

## 14. Observability dan SLO

### 14.1 Metrics provider

Minimum metrics:

```text
provider_requests_total
provider_requests_success_total
provider_requests_rate_limited_total
provider_requests_timeout_total
provider_requests_schema_error_total
provider_request_latency_ms
provider_retry_total
provider_circuit_open_total
provider_budget_remaining
provider_concurrency_current
provider_cache_hit_ratio
provider_cache_stale_ratio
provider_disagreement_total
```

### 14.2 Metrics queue

```text
work_items_queued
work_items_running
work_items_completed
work_items_deferred
work_items_failed
work_items_dead_lettered
queue_age_p50/p95/p99
queue_depth_by_kind
queue_depth_by_priority
worker_lease_expired
```

### 14.3 Metrics kualitas data

```text
freshness_ms_by_source
coverage_by_capability
unknown_rate
stale_rate
partial_scan_rate
last_known_good_age
security_verified_rate
provider_overlap
provider_disagreement_rate
observation_persistence_success
```

### 14.4 SLO awal

| SLO | Target |
|---|---:|
| API read response p95 | <500 ms dari cache/database |
| API read availability | 99.5% dev/preview, 99.9% production target |
| Scheduler adherence | >=95% pada health provider normal |
| Scan completion under budget | >=95% |
| Scan persistence success | >=99% |
| Duplicate provider request rate | <5% |
| Provider 429 retry storm | 0 sustained storm |
| Last-known-good board | <15 menit pada provider normal |
| Queue dead-letter tanpa alert | 0 |
| Secret leakage | 0 |

SLO tidak boleh dihitung sebagai sehat jika evidence operasional missing.

### 14.5 Alerts

Alert operator jika:

- semua RPC provider unhealthy;
- DexScreener rate-limit > threshold;
- secondary provider disagreement meningkat;
- queue age melebihi SLA;
- dead-letter bertambah;
- cache stale ratio tinggi;
- last-known-good terlalu tua;
- persistence failure;
- scan overlap;
- quota budget kritis;
- provider schema berubah.

---

## 15. Security dan privacy

### 15.1 Secret handling

- API key hanya Replit Secrets;
- tidak disimpan di database payload;
- endpoint URL di log harus direduksi;
- error response tidak boleh memuat query string secret;
- response provider yang mengandung credential tidak boleh dipersist;
- health endpoint hanya menampilkan provider label.

### 15.2 Mutation auth

Production harus:

```env
RADAR_REQUIRE_AUTH=true
RADAR_AUTH_TOKEN=<Replit Secret>
NODE_ENV=production
```

Jika auth diwajibkan tetapi token tidak tersedia, mutation harus mengembalikan
403 dan tidak melakukan pekerjaan.

### 15.3 Provider abuse prevention

Aplikasi tidak boleh:

- mengakali 429 dengan proxy rotation;
- melakukan retry tanpa delay;
- mengirim request di luar capability;
- melakukan unbounded batch;
- memanggil provider dari browser;
- menyebarkan API key melalui client.

---

## 16. Roadmap implementasi

### Phase A — Provider gateway dan quota foundation

**Ukuran:** L, estimasi 2–4 minggu untuk satu engineer backend + QA parsial.

Deliverables:

- provider adapter interface;
- request classification;
- provider request audit;
- token bucket budget;
- per-capability concurrency;
- Retry-After;
- exponential backoff;
- circuit breaker standardization;
- safe health API.

Acceptance:

- provider 429 tidak menghasilkan retry storm;
- satu provider open circuit tidak memblokir provider lain;
- request audit lengkap;
- budget exhaustion menghasilkan deferred work.

### Phase B — Cache dan deduplication

**Ukuran:** M, estimasi 1–2 minggu.

Deliverables:

- cache entry;
- TTL/stale policy;
- request dedupe;
- stale-but-usable response;
- cache hit/miss metrics;
- response hash validation;
- latest-write-wins berdasarkan observed time/slot.

Acceptance:

- refresh dashboard tidak menambah provider request;
- request identik dalam TTL hanya menghasilkan satu provider call;
- stale data terlihat stale;
- data future tidak masuk feature snapshot.

### Phase C — Tiered scheduler dan priority queue

**Ukuran:** L, estimasi 2–4 minggu.

Deliverables:

- persistent work item;
- priority queue;
- per-kind cadence;
- per-provider budget;
- scan budget;
- worker lease;
- retry/defer/dead-letter state;
- manual force refresh.

Acceptance:

- watchlist tetap diprioritaskan;
- rejected token tidak dipolling setiap 15 detik;
- scan dapat selesai sebagai partial tanpa mengganti good board;
- queue item tidak dijalankan dua worker bersamaan.

### Phase D — Secondary market provider

**Ukuran:** M–L, estimasi 2–4 minggu setelah provider dipilih.

Deliverables:

- provider adapter kedua;
- capability registry;
- normalized market observation;
- disagreement engine;
- source comparison UI/API;
- contract tests provider.

Acceptance:

- primary provider gagal dan secondary tersedia: discovery tetap berjalan dengan
  status lineage yang jelas;
- disagreement tidak diam-diam dirata-rata;
- provider unavailable tidak dianggap empty feed.

### Phase E — Dedicated RPC pool dan workload isolation

**Ukuran:** M, estimasi 1–3 minggu.

Deliverables:

- minimal dua RPC provider dedicated;
- security/holder/backfill budget terpisah;
- slot-aware cache;
- bounded JSON-RPC batch;
- per-item batch result;
- provider quota metrics.

Acceptance:

- holder enrichment tidak menghabiskan security budget;
- 429 satu RPC provider memindahkan request ke provider sehat;
- semua security response memiliki slot context atau fail closed.

### Phase F — Event-driven ingestion

**Ukuran:** XL, estimasi 4–8 minggu tergantung provider.

Deliverables:

- webhook/WebSocket/Geyser adapter;
- idempotent event store;
- cursor;
- gap detector;
- bounded backfill;
- targeted refresh work item.

Acceptance:

- event duplicate tidak membuat observation duplicate;
- event out-of-order tidak menimpa data baru;
- event gap menghasilkan bounded backfill;
- backfill tidak berjalan tanpa batas.

### Phase G — Project evidence dan outcome worker

**Ukuran:** L, estimasi 3–5 minggu.

Deliverables:

- project evidence adapters;
- source verification;
- 6–24 hour cadence;
- outcome batch worker;
- evaluation queue;
- bounded retention/partition strategy.

Acceptance:

- market activity tidak mengangkat product traction;
- stale project evidence tidak mengangkat quality cap;
- outcome labeling tidak memblokir market scan;
- evaluation GET tetap read-only.

### Phase H — Worker separation dan production hardening

**Ukuran:** XL, estimasi 4–8 minggu.

Deliverables:

- web/worker process boundary;
- deploy-safe workflow;
- graceful shutdown;
- queue recovery;
- dead-letter replay UI;
- load test;
- chaos test;
- Phase 7 operational gate.

Acceptance:

- worker crash tidak membuat API read surface down;
- queued work dapat dilanjutkan setelah restart;
- lease orphan direcover;
- provider outage dapat disimulasikan;
- rollout fail closed.

---

## 17. Acceptance criteria utama

### 17.1 Provider failover

**Given** primary DexScreener provider mengembalikan 429  
**When** discovery worker menjalankan request berikutnya  
**Then** sistem menghormati `Retry-After`, menurunkan concurrency, dan tidak
melakukan retry langsung  
**And** source health menjadi `DEGRADED` atau `OPEN`  
**And** secondary discovery dapat digunakan jika capability tersedia  
**And** scan audit mencatat provider dan reason code.

### 17.2 RPC failover

**Given** RPC provider utama timeout tiga kali  
**When** security verification masih membutuhkan request  
**Then** circuit provider utama terbuka  
**And** request dialihkan ke provider RPC berikutnya  
**And** slot context dan provider label dipersist  
**And** jika semua provider gagal, security menjadi `UNVERIFIED`.

### 17.3 No retry storm

**Given** provider mengembalikan 429 pada seluruh request  
**When** scheduler berjalan selama lima menit  
**Then** jumlah request tidak melebihi budget yang dikonfigurasi  
**And** work item masuk `DEFERRED` atau `DEAD_LETTER` sesuai policy  
**And** CPU dan queue tidak meningkat tanpa batas.

### 17.4 Cache

**Given** pair yang sama diminta dua kali dalam TTL fresh  
**When** dua work item dieksekusi  
**Then** hanya satu provider request terjadi  
**And** work item kedua membaca cache  
**And** lineage response tetap dapat ditelusuri.

### 17.5 Stale evidence

**Given** cache telah melewati fresh TTL tetapi belum melewati stale TTL  
**When** provider unavailable  
**Then** board dapat menggunakan `STALE_BUT_USABLE` jika endpoint mengizinkan  
**And** UI menampilkan umur data  
**And** kandidat tidak boleh menjadi `ACTIONABLE_RESEARCH` hanya dari stale
evidence.

### 17.6 Priority

**Given** queue berisi watchlist, candidate, discovery, dan metadata work  
**When** quota hanya cukup untuk sebagian pekerjaan  
**Then** watchlist dan security invalidation diproses lebih dahulu  
**And** metadata ditunda  
**And** keputusan urutan tersimpan di audit.

### 17.7 Disagreement

**Given** DexScreener dan secondary market provider berbeda di atas blocking
threshold  
**When** normalized observation dibuat  
**Then** status menjadi `DISAGREEMENT`  
**And** reason code tersimpan  
**And** evidence quality turun atau menjadi unknown sesuai policy  
**And** tidak ada rata-rata harga otomatis.

### 17.8 Event idempotency

**Given** webhook event yang sama diterima dua kali  
**When** ingestion memproses keduanya  
**Then** hanya satu event canonical yang tersimpan  
**And** hanya satu targeted work item yang dibuat.

### 17.9 Dead-letter replay

**Given** work item gagal sampai batas maksimum  
**When** item masuk dead-letter  
**Then** seluruh request lineage tersedia  
**And** operator dapat melihat reason  
**And** replay membuat attempt baru dengan correlation ID baru  
**And** replay tidak menghapus histori failure.

### 17.10 Production mutation auth

**Given** `NODE_ENV=production` dan `RADAR_AUTH_TOKEN` belum tersedia  
**When** client memanggil mutation endpoint  
**Then** response 403  
**And** tidak ada provider request, database mutation, atau queue item baru.

### 17.11 Read API isolation

**Given** seluruh provider sedang down  
**When** client membuka dashboard  
**Then** `/api/state` tetap merespons dari last-known-good state  
**And** response menyatakan provider degraded/stale  
**And** GET tidak memanggil provider sinkron.

---

## 18. Test strategy

### 18.1 Unit tests

Wajib mencakup:

- token bucket;
- Retry-After parsing;
- exponential backoff;
- jitter bounds;
- circuit state transition;
- dedupe key;
- TTL state;
- stale policy;
- queue priority;
- lease expiration;
- provider error classification;
- schema validation;
- disagreement thresholds;
- slot ordering;
- event idempotency;
- dead-letter transition.

### 18.2 Contract tests

Setiap provider adapter harus memiliki:

- valid payload;
- malformed payload;
- missing field;
- future timestamp;
- negative value;
- invalid chain;
- 429;
- 5xx;
- timeout;
- Retry-After;
- schema version mismatch.

### 18.3 Integration tests

- Prisma transaction;
- work item lease;
- two-worker race;
- dedupe under concurrency;
- provider failover;
- cache persistence;
- dead-letter/replay;
- evaluation retention;
- startup with initialized database;
- graceful shutdown.

### 18.4 Load tests

Load scenarios:

1. 10.000 token universe dengan 100 watchlist.
2. DexScreener 429 selama 10 menit.
3. RPC primary timeout 30%.
4. Secondary provider delay 5 detik.
5. 100 manual force refresh bersamaan.
6. Duplicate webhook burst.
7. Database latency p95 meningkat 10x.

Load test harus membuktikan:

- queue tetap bounded;
- provider request tetap dalam budget;
- API read tetap responsif;
- tidak ada retry storm;
- last-known-good state tersedia.

### 18.5 Chaos tests

- kill worker saat work item running;
- kill process saat transaction;
- corrupt cache response;
- provider schema change;
- clock skew;
- out-of-order event;
- database unavailable saat scan finalization.

### 18.6 Smoke tests

Smoke test minimal:

```text
GET /
GET /api/state
GET /api/phase7
GET /api/evaluation
GET /api/provider-health
POST /api/scan dengan invalid/missing auth
GET /api/tokens/:mint/lineage
```

---

## 19. Migration dan rollout safety

### 19.1 Development

Schema development diterapkan menggunakan flow project:

```bash
npm run db:generate
npm run db:push
```

Tidak menambahkan DDL startup.

### 19.2 Production

Perubahan schema production hanya melalui Publish flow Replit dan review diff.
Tidak boleh:

- menambahkan `db:push` ke deployment build;
- menjalankan DDL saat startup;
- menggunakan custom script untuk production;
- menghapus histori tanpa retention policy yang disetujui.

### 19.3 Feature flags

```env
RADAR_PROVIDER_GATEWAY_ENABLED=false
RADAR_SECONDARY_MARKET_ENABLED=false
RADAR_EVENT_INGESTION_ENABLED=false
RADAR_PRIORITY_QUEUE_ENABLED=false
RADAR_STALE_CACHE_ENABLED=true
RADAR_REQUIRE_AUTH=true
```

Default rollout:

1. shadow mode;
2. observe-only;
3. non-blocking disagreement;
4. blocking only after evidence;
5. active production mode;
6. rollback ke baseline.

### 19.4 Rollback

Rollback harus:

- mematikan provider/worker baru;
- mempertahankan observations dan request audit;
- tidak menghapus lineage;
- mengembalikan cadence baseline;
- menjaga last-known-good board;
- menyediakan alasan rollback di Phase 7.

---

## 20. Security dan operational gates

Fitur dianggap siap hanya jika:

- tidak ada secret pada log;
- mutation production fail-closed;
- provider URL aman;
- request budget bounded;
- queue bounded;
- dead-letter visible;
- cache stale visible;
- source lineage lengkap;
- schema validation fail-closed;
- provider disagreement tidak menghasilkan false confidence;
- RPC evidence memiliki slot context;
- no-wallet-execution boundary tetap utuh;
- smoke, integration, load, dan chaos test lulus sesuai fase.

---

## 21. Definition of Done

Program reliability ini selesai jika seluruh kondisi berikut terpenuhi:

1. Minimal dua market/RPC failure domain tersedia dan teruji.
2. Provider adapter interface digunakan oleh seluruh sumber eksternal.
3. Provider gateway menerapkan quota, retry, backoff, circuit, dan dedupe.
4. Scheduler tiered menggantikan full-universe 15-second polling.
5. Cache memiliki fresh/stale/expired/failed/unknown state.
6. Priority queue memiliki lease, retry, defer, dan dead-letter.
7. Discovery, security, holder, quote, project, event, dan outcome workload
   memiliki budget berbeda.
8. Secondary market data menghasilkan disagreement report.
9. Event-driven ingestion atau adapter yang setara tersedia untuk targeted
   refresh.
10. Read API tidak bergantung pada provider request sinkron.
11. Provider health, quota, queue, freshness, disagreement, dan SLO tersedia.
12. Production mutation authentication fail-closed.
13. Database retention dan pagination tidak tumbuh tanpa batas.
14. Semua request dapat ditelusuri ke correlation ID, request ID, response hash,
   source, dan configuration version.
15. Unit, contract, integration, smoke, load, dan chaos test tersedia sesuai
   fase.
16. Phase 7 menyetujui readiness berdasarkan evidence operasional, bukan asumsi.
17. Tidak ada wallet signing atau real execution yang aktif.

---

## 22. Keputusan yang perlu dikonfirmasi sebelum Phase D/F

PRD ini dapat mulai dikerjakan tanpa menunggu keputusan berikut, tetapi keputusan
ini harus ditetapkan sebelum secondary provider dan event ingestion masuk
production:

1. Secondary market provider yang dipilih.
2. RPC provider dedicated dan batas quota masing-masing.
3. Apakah menggunakan webhook provider atau Yellowstone/Geyser.
4. Target jumlah token universe maksimum.
5. Target watchlist maksimum.
6. Retention period untuk provider request audit.
7. Retention period untuk raw payload/hash lineage.
8. Budget biaya bulanan provider.
9. Apakah worker dipisah sebagai workflow Replit atau service deployment.
10. SLO production final dan escalation owner.

---

## 23. Ringkasan prioritas pembangunan

### P0 — wajib sebelum beban production meningkat

- provider gateway;
- quota budget;
- Retry-After;
- bounded retry;
- cache;
- dedupe;
- tiered cadence;
- priority queue;
- RPC dedicated pool;
- provider health;
- read-path isolation.

### P1 — wajib untuk reliability tingkat lanjut

- secondary market provider;
- disagreement engine;
- dead-letter/replay;
- persistent request audit;
- load test;
- mutation auth;
- project evidence cadence;
- outcome worker isolation.

### P2 — peningkatan resiliency lanjutan

- event-driven ingestion;
- Geyser/webhook integration;
- worker process separation;
- chaos test automation;
- advanced quota forecasting;
- multi-region/provider routing jika diperlukan.

---

## 24. Pernyataan produk akhir

Solana Radar yang handal bukan aplikasi yang terus-menerus menambah request untuk
mendapatkan lebih banyak data. Solana Radar yang handal adalah sistem yang tahu:

- kapan harus meminta data;
- sumber mana yang bertanggung jawab;
- berapa biaya request yang tersedia;
- kapan harus menggunakan cache;
- kapan data boleh dianggap stale;
- kapan harus berhenti dan menunggu;
- kapan provider tidak dapat dipercaya;
- kapan evidence belum cukup;
- dan kapan board terakhir yang valid lebih aman daripada data baru yang rusak.

Implementasi harus selalu menjaga prinsip:

> Lebih baik kandidat berstatus `UNKNOWN` atau board sedikit terlambat daripada
> sistem menampilkan angka palsu, menghabiskan quota, atau menganggap provider
> gagal sebagai bukti bahwa market aman.