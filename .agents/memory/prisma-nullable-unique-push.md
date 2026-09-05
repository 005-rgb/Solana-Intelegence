---
name: Prisma nullable unique push
description: Prisma db push may require explicit confirmation when adding unique nullable idempotency fields.
---

Adding nullable unique idempotency fields can make Prisma `db push` stop with a potential data-loss warning even when the existing table has no such columns or non-null values.

**Why:** The warning is conservative and can block the schema needed for request deduplication; blindly accepting it would bypass the data-safety check.

**How to apply:** Inspect existing non-null duplicate keys first. If the new fields are nullable and the check is clean, apply the schema with the required confirmation flag and verify the resulting columns and indexes.