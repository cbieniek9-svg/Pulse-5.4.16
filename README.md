# TGP v5.3.0 — Financial Log (EWM receiving workbook)

Adds the manager Financial Log portal; all existing floor URLs unchanged.

## Highlights

- **`/financial`** — Edmonton Wholesale Market 35-day receiving workbook (shadow mode ON by default until rollout)
- **`/log`** — Redirects to `/financial` (bookmarks kept)
- **`/rec`, `/markdown`, `/cs`, `/reports`, `/settings`, `/count`, `/safe`, `/`** — Unchanged; existing shortcuts and home-screen bookmarks keep working
- Store transfers workbook + receiving temp tweaks from 5.2.7 unchanged

## Headless / Windows service (active in 5.3.0)

- **`server.cjs`** — Headless API (Express + DB + schedulers) without an Electron window
- **Windows service** — WinSW under `service/` starts at boot before login on **port 3001**; `/rec`, `/financial`, mobile, and TV survive reboot
- **Install once** — `service/INSTALL.cmd` (Administrator UAC); confirm `http://127.0.0.1:3001/api/ready`
- **Desktop .exe** — UI-only when the service already owns `:3001` (attach-or-serve)
- **Deploy docs** — `STORE_DEPLOY.txt`, `STORE_SERVICE_DEPLOY.txt`, `service/README.txt`
