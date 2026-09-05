---
name: Core before monetization
description: Product direction is to finish and validate the Radar core before enabling wallet execution or transaction fees.
---

The project should complete and prove the core Radar system before building live wallet monetization. Wallet execution and fees are later extensions, not prerequisites for core reliability. Fee settings must be backend-configurable, versioned, and transparently shown; launch may use a zero-fee configuration.

**Why:** The user explicitly prioritizes reliable evidence, filtering, auditability, and safe operation before introducing real-money transaction risk or revenue incentives.

**How to apply:** Do not activate wallet signing or fee collection while core scans, candidate discovery, provider/RPC failure handling, history, and evaluation remain unproven. Preserve extension points for wallet execution and fee policy without hardcoding a percentage or exposing mutable public fee controls.