---
name: Provider lineage fallback
description: Rules for provenance when discovery succeeds but pair detail fetches are missing or fail.
---

If a pair-detail request fails or returns no usable pair, keep the candidate's original discovery source, request ID, endpoint, and response hash when available. Leave the response hash null when no external response exists; never hash a synthesized fallback snapshot and present it as provider provenance.

**Why:** A synthetic hash cannot reproduce or identify an external response, so it makes audit lineage look stronger than the evidence actually is.

**How to apply:** Prefer pair-fetch lineage for pair observations and discovery-feed lineage for metadata-only observations. Watchlist-only candidates may have no external response lineage and must remain explicit about that absence.