---
name: Solana RPC verification
description: Runtime constraint for live token safety verification against public Solana RPC endpoints.
---

Public Solana RPC endpoints can return HTTP 429 during multi-token authority, supply, and holder checks.

**Why:** The Radar must never treat an unavailable security check as safe; otherwise an RPC outage can expose unverified or potentially unsafe tokens.

**How to apply:** Keep verification fail-closed, batch requests when possible, bound scan duration, expose rejection reasons in system state, and use a reliable configured RPC source for production-scale scanning. Persist provider observations even when RPC quality fails, but never promote them to the live board.