---
name: Audit count semantics
description: How to interpret baseline scan counts when a candidate can have multiple rejection reasons.
---

Baseline scan reports use mutually exclusive row outcomes for reconciliation: checked = accepted + rejected + unresolved. Rejection reason counters are diagnostic and multi-label, so their sum can exceed the rejected-row count.

**Why:** A single candidate can fail more than one deterministic gate; treating reason totals as row totals creates a false audit mismatch.

**How to apply:** Use outcome counters for completeness checks, and present reason counters as explanations rather than another partition of the provider universe.