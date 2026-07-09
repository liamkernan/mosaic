# Offline Demo

Run the deterministic project walkthrough with:

```bash
pnpm demo
```

It uses fixed fixtures and in-process responses only. It does not require API keys, a Redis server, a GitHub App, or network access.

The demo exercises real Mosaic components in two scenarios:

1. A safe copy correction is classified, planned, generated as a diff, validated, checked against the implementation plan, and accepted as a PR candidate.
2. A suspicious intake message is blocked by the production abuse-assessment rules and written to an in-memory `QuarantineStore` adapter so the quarantine record is visible without Redis.

The safe fixture is at `demo/fixtures/safe-repo/src/hero.ts`. It is never modified by the demo.
