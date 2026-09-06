---
name: Wallet concentration taxonomy
description: Durable rule for separating token-account concentration from wallet concentration in Radar evidence.
---

Token-account concentration must remain separate from wallet concentration. An `ASSOCIATED_TOKEN_ACCOUNT` is still only an ATA unless its owner is independently identified with explicit evidence; a pair address, system-owned non-executable account, or generic token-account owner must not inflate wallet percentages.

**Why:** Solana largest-account RPC results identify token accounts, not wallet ownership. Treating account type or an unresolved owner as a wallet creates false concentration and insider-analysis claims.

**How to apply:** Keep pool/vault/program/ATA/account classes explicit, filter pool accounts before wallet ranking, and calculate wallet concentration only from resolved wallet-owner evidence. Unknown owners remain UNKNOWN and cap confidence.