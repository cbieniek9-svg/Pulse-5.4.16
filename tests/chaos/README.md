# Chaos / load harness (optional)

This folder has its **own** `package.json`. Dependencies are **not** installed with the main app under `resources/app/`.

```bash
cd resources/app/tests/chaos
npm install
npm run chaos
```

`chaos_report.txt` is generated when you run the harness; it is gitignored at repo level patterns where applicable.

SSE stress uses the same **`/api/stream-token` → `?st=`** flow as production clients. Provide a valid session token (or run with tokenless PoC LAN mode enabled on the server).

Main Playwright smoke tests live in `resources/app/tests/*.spec.js` and use the root `resources/app/node_modules`.
