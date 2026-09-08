---
name: Node runtime compatibility
description: The imported project roadmap targets Node 24 while the active Replit workflow currently runs Node 20.
---

The current workflow runs on Node 20 even though the project roadmap names Node 24. The M2 cache, Prisma client, server, and full test suite were verified successfully on the active Node 20 runtime.

**Why:** Runtime metadata and project documentation are temporarily out of sync; future upgrades should be deliberate rather than assumed during feature work.

**How to apply:** Treat the active workflow runtime as the compatibility baseline until a dedicated runtime-upgrade task changes it, and re-run Prisma generation and the full suite after any Node upgrade.