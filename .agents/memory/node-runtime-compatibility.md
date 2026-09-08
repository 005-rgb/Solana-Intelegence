---
name: Node runtime compatibility
description: The imported project roadmap targets Node 24 while the active Replit workflow currently runs Node 20.
---

The workflow now runs on Node 24, matching the project roadmap and the package engine. The M2 cache, Prisma client, server, and full test suite were verified successfully on the active Node 24 runtime.

**Why:** Runtime metadata and project documentation were temporarily out of sync; the mismatch is now resolved, but future runtime changes should still be deliberate.

**How to apply:** Treat Node 24 as the compatibility baseline and re-run Prisma generation plus the full suite after any future Node upgrade.