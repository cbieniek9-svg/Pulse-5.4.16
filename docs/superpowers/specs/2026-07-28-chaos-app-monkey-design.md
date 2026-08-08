# Chaos App Monkey — Design Spec

**Date:** 2026-07-28 (ops notes updated 2026-07-29)  
**Status:** Approved (user choices locked) + implemented  
**Rule:** Produce a findings **report before any product fixes**.  
**See also:** [../../TESTING.md](../../TESTING.md)

## Locked decisions

| Topic | Choice |
|--------|--------|
| Target | Whatever `TGP_BASE_URL` is (caller owns risk) |
| Surfaces | API crawl **+** Playwright UI gremlin |
| Destructive | Full exercise including successful wipes (`clear-db`, etc.) |
| Failure model | Keep going; record every finding; exit non-zero at end |
| Product code | Unchanged unless a finding is later approved to fix |

## Goal

One command that crawls every major portal and API domain, applies bounded stress without cascading the server to death, exercises destructive paths for real, and emits a machine-readable report of everything wrong.

## Non-goals

- Replacing hell3000 / unit tests
- Auto-fixing application bugs
- Unbounded thundering-herd that intentionally kills the process

## Layout

```
tests/chaos-monkey/
  run.cjs
  lib/report.cjs
  lib/ctx.cjs
  phases/*.cjs
  ui-gremlin.spec.js
  playwright.config.js
```

Report: `tests/chaos-monkey-report.json`

## Cascade controls

- Caps: ≤25 concurrent sync, ≤10 writers, ≤40 SSE clients
- Soft health probe between phases (finding if down; continue attempts)
- Malformed/oversized probes expect 4xx; unexpected 5xx = fail
- UI gremlin **before** destructive phase
- Destructive **last**

## npm

`npm run test:chaos-monkey` → `node tests/chaos-monkey/run.cjs`

## Ops lessons (2026-07-29)

- Always use a **throwaway** `TGP_DATA_DIR` + port. Never aim destructive phases at production `:3001` data.
- **Hell 3000 before monkey:** run `test:hell3000` **without** `TGP_PORT` / `TGP_DATA_DIR` set. Inherited bind env caused `ui-shell.test.cjs` to fight the throwaway API and hang ~12h on rhythm watchdog ticks. `chaos-hell-3000.cjs` now deletes those keys from child env.
- “Chaos × infinity” = Hell 3000 → start throwaway API → monkey looped N times → optional classic SSE/DB stress. Log: `tests/chaos-infinity-run.log`.
