# /safe Incident Investigation — Design Spec

**Date:** 2026-07-19 (status note 2026-07-29)  
**Status:** Approved — implemented on React `/safe` in current 5.3.x tree (verify UI against `client/src/safe/`, not legacy `safe.html`)  
**Portal:** `/safe`  
**Export:** Generated Letter PDF using the Appendix B field schema (not a stamped scan)

## Goal

Extend `/safe` so staff can complete a full **incident investigation** with a guided wizard that walks the Appendix B process, then **export a readable PDF** that carries the same fields and answers. Keep an **archive** of past monthly inspections and investigations (separate tabs).

## Decisions (locked)

| Topic | Choice |
|--------|--------|
| Export | Generated multi-page Letter PDF (Appendix B schema; selected items + full text; no stamped blank) |
| UX | Guided wizard (one section at a time) with tips |
| Archive | Two tabs: Inspections \| Investigations |
| Attachments | Upload photos/PDFs into archive; list/appendix on PDF |
| Signatures | Drawn signature pads embedded in PDF |
| Access | Same as current `/safe` (Manager / Store Manager, or Safe permission + mobile login) |

## Non-goals (v1)

- SMS / external notification of incidents
- Auto-creating ops tasks from action-log rows
- Pixel-perfect clone of the corporate Appendix B blank
- Dual export (generated + stamped template)

## Architecture

### Hub

`/safe` home becomes a two-tab hub:

1. **Inspections** — existing monthly committee inspection flow (unchanged behavior).
2. **Investigations** — new list + “Start investigation” entry point.

### Data model (new, separate from inspection tables)

**`incident_investigations`**

- `id` (text PK, e.g. `II-<uuid-slice>`)
- `incident_number` (text, unique per store; default `INV-YYYYMMDD-###`, editable)
- `status` (`draft` \| `submitted`)
- Header fields: report date/time (+ am/pm), retail name, person involved, person type flags (FT/PT/contractor/customer), incident date/time (+ am/pm)
- Witnesses (up to 3 names)
- Incident type checkboxes (First Aid, Lost Time, Near Miss, etc. + Other text)
- Description: up to 10 chronological event lines (JSON array)
- Process answers: hazard assessment / controls / JHA / JHA followed (yes/no/na) + equipment/materials text
- Type of event checkboxes (struck against, fall, etc.)
- Immediate/direct cause selections (acts 1–20 + other; conditions 21–40 + other)
- Immediate cause contribution rows (I/D # + explanation) — JSON
- Basic/root cause selections (personal 1–8 + other; job/system 9–17 + other)
- I/D ↔ B/R contribution rows — JSON
- Corrective action area checkboxes (1–22 + other)
- I/D ↔ B/R ↔ CA contribution rows — JSON
- Action log rows (action, person responsible, due date) — JSON
- Supporting documents grid (utilized / copy attached per item) — JSON
- Sign-off meta: for each role (lead, safety_committee, senior_management): print name, date, signature blob path or inline reference
- `created_at`, `created_by`, `updated_at`, `updated_by`, `submitted_at`, `submitted_by`

**`incident_investigation_attachments`**

- `id`, `investigation_id`, `kind` (photo \| sketch \| pdf \| other), `original_name`, `stored_name`, `mime`, `size_bytes`, `created_at`, `created_by`
- Files on disk under `<TGP_DATA_DIR>/data/incident_investigations/<investigation_id>/`

### PDF pipeline

1. Create a blank Letter PDF with `pdf-lib`.
2. Render investigation sections from the structured payload and catalog labels (`incident-investigation-pdf.cjs`), wrapping all typed text across as many pages as needed.
3. Embed sign-off signatures when present; append appendix pages for uploaded images (and list non-image PDFs).
4. Return download: `Incident_Investigation_<incident#>_<date>.pdf`.

The scanned Appendix B blank and coordinate map may remain in the repo unused; they are not required for export.

### API (sketch)

All routes require Safe access (same gate as inspections).

- `GET /api/safety/investigations` — list archive
- `POST /api/safety/investigations` — create draft
- `GET /api/safety/investigations/:id` — load one
- `PATCH /api/safety/investigations/:id` — save draft / update
- `POST /api/safety/investigations/:id/submit` — validate + mark submitted
- `GET /api/safety/investigations/:id/export.pdf` — stamp + download (allowed for draft preview and submitted)
- `POST /api/safety/investigations/:id/attachments` — multipart upload
- `DELETE /api/safety/investigations/:id/attachments/:attachmentId`
- `GET /api/safety/investigations/:id/attachments/:attachmentId` — download file

## Wizard UX

Steps (persist draft on each Next / explicit Save):

1. **Basics** — incident #, dates/times, retail (prefill store display name), person + type, witnesses  
2. **Description** — up to 10 chronological lines; tip for before/during/after; remind sketch upload later  
3. **Process & event type** — Y/N/NA process grid; equipment text; event-type multi-select  
4. **Causes** — substandard acts/conditions multi-select; contribution rows; root causes + link rows  
5. **Corrective actions** — area checkboxes; contribution rows; action log  
6. **Docs & uploads** — utilized/attached grid + file uploads  
7. **Sign-off** — signature pads + name + date for Lead / Safety Committee / Senior Management  
8. **Review** — incomplete required fields list → Save draft / Submit & download PDF  

**Required to submit (v1):** incident number, incident date, person involved (or explicit “unknown”), at least one description line, lead investigator name + signature.

Submitted records remain reopenable for corrections and re-export.

## Access & permissions

Unchanged from monthly inspections: Manager / Store Manager, or staff with `safe` permission and granted mobile login.

## Errors & limits

- Draft save failures → toast; stay on step  
- Submit/export blocked with explicit missing-field list  
- Upload: images + PDF; size cap (e.g. 10 MB/file, reasonable total per investigation)  
- Missing template PDF → actionable error string  

## Testing

- Unit: default incident # generation; schema validation; field map covers required stamp keys  
- Integration: create → upload → submit → PDF bytes non-empty, page count ≥ 5  
- Auth: non-Safe user → 403 on investigation APIs  

## Implementation notes (for planning)

- Prefer a dedicated `src/lib/incident-investigation*.cjs` + `src/routes/manager/incident-investigations.cjs` registered beside safety inspections.  
- Add dependency: `pdf-lib` (and image embed helpers as needed).  
- Migration for new tables (next numbered migration after current).  
- Keep monthly inspection print/HTML path as-is; do not force inspections through pdf-lib in v1.  
- Source blank PDF from the store’s Appendix B file provided 2026-07-19 (trim blank page 6 if present).

## Open items resolved in design

- Exact visual match → stamp official PDF, not HTML print.  
- Helping the user → wizard with tips, not one long form.  
- Archive → two tabs.  
- Files → upload + PDF appendix/listing.  
- Signatures → drawn pads embedded in PDF.
