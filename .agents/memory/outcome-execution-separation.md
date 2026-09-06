---
name: Outcome and execution separation
description: Phase 6 must keep market-price outcomes distinct from executable outcomes when sell-route evidence is missing.
---

Price observations can support return, MFE, MAE, and drawdown labels without proving that a trade could have been executed. The executable return, slippage, and fee fields therefore stay unknown unless a later observation carries explicit sell-route evidence.

**Why:** The live market provider supplies price and liquidity history more reliably than walletless sell execution evidence; collapsing the two would turn unavailable execution into false performance.

**How to apply:** Keep price-based and executable metrics separate in labels, reports, UI, and any future promotion gate. Unknown execution evidence must never be converted to zero slippage or a price-only success claim.

Numeric normalization must also reject null and empty values before calling `Number(...)`; JavaScript otherwise coerces `null` to zero and can silently manufacture an executable return.