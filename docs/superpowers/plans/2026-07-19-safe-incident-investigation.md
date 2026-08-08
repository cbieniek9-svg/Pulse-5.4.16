# /safe Incident Investigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add guided incident investigations to `/safe` that stamp the official Appendix B PDF, upload supporting files, and archive investigations beside monthly inspections.

**Architecture:** New SQLite tables + lib modules mirror the existing safety-inspection pattern (`requireSafeAccess`). Wizard UI on `safe.html` (Investigations tab). Export loads a shipped blank Appendix B PDF and stamps fields with `pdf-lib` using a coordinate map; image attachments become appendix pages.

**Tech Stack:** Express 5, better-sqlite3, `pdf-lib`, `multer` (multipart uploads), React Safe portal (`client/src/safe/`), Node test runner (`node --test`).

**Spec:** `docs/superpowers/specs/2026-07-19-safe-incident-investigation-design.md`

**Status note (2026-07-29):** Plan text still mentions `safe.html` in places — live UI is React. Prefer `client/src/safe/` when implementing or verifying.

**Note:** This workspace may not have `.git`. Skip commit steps when git is unavailable; still complete code + tests.

---

## File map

| File | Responsibility |
|------|----------------|
| `assets/safety/tgp-incident-investigation-appendix-b.pdf` | Blank Appendix B pages 1–5 |
| `src/lib/incident-investigation-catalog.cjs` | Checkbox keys/labels from the paper form |
| `src/lib/incident-investigations.cjs` | Schema, CRUD, incident #, submit validation |
| `src/lib/incident-investigation-pdf-map.cjs` | Stamp coordinates (page, x, y, size, type) |
| `src/lib/incident-investigation-pdf.cjs` | Load template, stamp, append image pages |
| `src/routes/manager/incident-investigations.cjs` | HTTP API + multer uploads |
| `src/migrations/036_incident_investigations.cjs` | Create tables |
| `src/routes/manager/index.cjs` | Register routes |
| `safe.html` | Tabs + wizard UI |
| `tests/incident-investigations.test.cjs` | Unit/integration tests |
| `tests/incident-investigation-pdf.test.cjs` | PDF stamp smoke test |
| `tests/migrations.test.cjs` | Expect migration 36 |
| `package.json` | Add `pdf-lib`, `multer` |
| Version/docs | `app-version.cjs`, CHANGELOG, PATCH_NOTES, release-manifest |

---

### Task 1: Dependencies + blank template asset

**Files:**
- Modify: `resources/app/package.json`
- Create: `resources/app/assets/safety/tgp-incident-investigation-appendix-b.pdf`
- Create: `resources/app/assets/safety/README.txt`

- [ ] **Step 1: Install deps in `resources/app`**

```bash
cd E:\TGPV5\TGP_V5\resources\app
npm install pdf-lib@^1.17.1 multer@^1.4.5-lts.2 --save
```

Expected: `package.json` / lockfile list `pdf-lib` and `multer`.

- [ ] **Step 2: Prepare blank template PDF (5 pages)**

From the store file `f:\20260719143223464.pdf` (or the copy used in design), strip blank page 6 and save as `assets/safety/tgp-incident-investigation-appendix-b.pdf`.

```bash
cd E:\TGPV5\TGP_V5\resources\app
node -e "const fs=require('fs');const {PDFDocument}=require('pdf-lib');(async()=>{const src=await PDFDocument.load(fs.readFileSync('f:/20260719143223464.pdf'));const out=await PDFDocument.create();const pages=await out.copyPages(src, [0,1,2,3,4]);pages.forEach(p=>out.addPage(p));fs.mkdirSync('assets/safety',{recursive:true});fs.writeFileSync('assets/safety/tgp-incident-investigation-appendix-b.pdf', await out.save());console.log('pages', out.getPageCount());})();"
```

Expected: `pages 5`.

- [ ] **Step 3: Add `assets/safety/README.txt`**

```text
tgp-incident-investigation-appendix-b.pdf
Blank TGP Appendix B Incident Investigation Report (pages 1-5).
Used by src/lib/incident-investigation-pdf.cjs — do not replace with a filled form.
If Corporate revises the paper form, update this PDF and recalibrate incident-investigation-pdf-map.cjs.
```

- [ ] **Step 4: Commit (if git available)**

```bash
git add package.json package-lock.json assets/safety/
git commit -m "chore: add pdf-lib, multer, and blank Appendix B template"
```

---

### Task 2: Catalog constants

**Files:**
- Create: `resources/app/src/lib/incident-investigation-catalog.cjs`
- Test: `resources/app/tests/incident-investigations.test.cjs` (start file)

- [ ] **Step 1: Write failing test for catalog sizes**

Create `tests/incident-investigations.test.cjs`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
    INCIDENT_TYPES,
    EVENT_TYPES,
    SUBSTANDARD_ACTS,
    SUBSTANDARD_CONDITIONS,
    ROOT_PERSONAL,
    ROOT_JOB,
    CORRECTIVE_AREAS,
    SUPPORTING_DOCS,
} = require('../src/lib/incident-investigation-catalog.cjs');

test('Appendix B catalog lists match paper form counts', () => {
    assert.equal(INCIDENT_TYPES.length, 15); // includes Other
    assert.equal(EVENT_TYPES.length, 13);
    assert.equal(SUBSTANDARD_ACTS.length, 20);
    assert.equal(SUBSTANDARD_CONDITIONS.length, 20);
    assert.equal(ROOT_PERSONAL.length, 8);
    assert.equal(ROOT_JOB.length, 8); // 9-16 + treat Other as 17 in UI
    assert.equal(CORRECTIVE_AREAS.length, 22);
    assert.equal(SUPPORTING_DOCS.length, 8);
});
```

- [ ] **Step 2: Run test — expect FAIL (module missing)**

```bash
cd E:\TGPV5\TGP_V5\resources\app
node --test tests/incident-investigations.test.cjs
```

Expected: FAIL cannot find module.

- [ ] **Step 3: Implement catalog**

Create `src/lib/incident-investigation-catalog.cjs` exporting frozen arrays of `{ key, label, num? }` for every checkbox group on Appendix B (use keys like `first_aid`, `struck_by`, `act_01`, `cond_21`, `root_05`, `ca_11`, `doc_photos`). Include `OTHER` keys with free-text companion fields handled in payload.

- [ ] **Step 4: Run test — expect PASS**

```bash
node --test tests/incident-investigations.test.cjs
```

- [ ] **Step 5: Commit (if git available)**

```bash
git add src/lib/incident-investigation-catalog.cjs tests/incident-investigations.test.cjs
git commit -m "feat(safe): Appendix B investigation catalog constants"
```

---

### Task 3: Schema, incident numbers, CRUD

**Files:**
- Create: `resources/app/src/lib/incident-investigations.cjs`
- Create: `resources/app/src/migrations/036_incident_investigations.cjs`
- Modify: `resources/app/tests/migrations.test.cjs`
- Modify: `resources/app/tests/incident-investigations.test.cjs`

- [ ] **Step 1: Add failing tests for incident # + create/list**

Append to `tests/incident-investigations.test.cjs` (use temp `TGP_DATA_DIR` + real ops DB pattern from `tests/safety-inspections.test.cjs` if present; otherwise open better-sqlite3 via Electron-as-node or skip when ABI mismatch — prefer same helper as safety inspections):

```js
test('nextIncidentNumber increments per store day', (t) => {
    // arrange db with ensureIncidentInvestigationSchema
    // assert nextIncidentNumber(db, '2026-07-19') === 'INV-20260719-001'
    // insert that number, assert next is 002
});

test('createInvestigation returns draft with empty payload', (t) => {
    // create → status draft, payload has descriptionLines length 10 empty strings
});
```

- [ ] **Step 2: Run tests — expect FAIL**

- [ ] **Step 3: Implement `incident-investigations.cjs`**

Required exports:

```js
ensureIncidentInvestigationSchema(db)
nextIncidentNumber(db, storeDateStamp) // INV-YYYYMMDD-###
createInvestigation(db, { actorName, serverTime, storeDateStamp, retailName })
listInvestigations(db, { status, limit })
getInvestigation(db, id) // includes attachments[]
updateInvestigation(db, id, patch, actorName, serverTime)
submitInvestigation(db, id, actorName, serverTime) // throws {status:400, missing:[]}
validateForSubmit(row) // returns string[] missing field labels
getAttachmentsDir(investigationId) // path under getDataRoot()/data/incident_investigations/<id>
```

Schema (SQL):

```sql
CREATE TABLE IF NOT EXISTS incident_investigations (
  id TEXT PRIMARY KEY,
  incident_number TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'draft',
  report_date TEXT,
  report_time TEXT,
  report_ampm TEXT,
  retail_name TEXT,
  person_involved TEXT,
  person_types_json TEXT NOT NULL DEFAULT '{}',
  incident_date TEXT,
  incident_time TEXT,
  incident_ampm TEXT,
  witnesses_json TEXT NOT NULL DEFAULT '[]',
  payload_json TEXT NOT NULL DEFAULT '{}',
  signoffs_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  submitted_at TEXT,
  submitted_by TEXT
);
CREATE TABLE IF NOT EXISTS incident_investigation_attachments (
  id TEXT PRIMARY KEY,
  investigation_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ii_status_date ON incident_investigations(status, incident_date DESC);
CREATE INDEX IF NOT EXISTS idx_ii_att_inv ON incident_investigation_attachments(investigation_id);
```

Default `payload_json` shape:

```js
{
  incidentTypes: {}, // key -> true
  incidentTypeOther: '',
  descriptionLines: ['','',...10],
  process: {
    hazardAssessment: null, // 'yes'|'no'|'na'|null
    controlsImplemented: null,
    jhaExists: null,
    jhaFollowed: null,
    equipmentMaterials: '',
  },
  eventTypes: {},
  substandardActs: {},
  substandardActsOther: '',
  substandardConditions: {},
  substandardConditionsOther: '',
  immediateContributions: [{ idNum: '', explanation: '' }, ...x5],
  rootPersonal: {},
  rootPersonalOther: '',
  rootJob: {},
  rootJobOther: '',
  rootLinks: [{ idNum: '', brNum: '', explanation: '' }, ...x5],
  correctiveAreas: {},
  correctiveOther: '',
  correctiveLinks: [{ idNum: '', brNum: '', caNum: '', explanation: '' }, ...x8],
  actionLog: [{ action: '', person: '', dueDate: '' }, ...x5],
  supportingDocs: { /* key: { utilized: null|boolean, copyAttached: null|boolean } */ },
}
```

`signoffs_json`:

```js
{
  lead: { name: '', date: '', signatureFile: '' },
  safety_committee: { name: '', date: '', signatureFile: '' },
  senior_management: { name: '', date: '', signatureFile: '' },
}
```

`validateForSubmit` missing labels must include: Incident number, Incident date, Person involved, Description (line 1), Lead investigator name, Lead investigator signature.

- [ ] **Step 4: Migration 036**

```js
'use strict';
const { ensureIncidentInvestigationSchema } = require('../lib/incident-investigations.cjs');
module.exports = {
  name: 'incident_investigations',
  up(db) { ensureIncidentInvestigationSchema(db); },
};
```

Update `tests/migrations.test.cjs` to include `35` already present and assert `36` / `versions.length === 36`.

- [ ] **Step 5: Run tests — expect PASS**

```bash
node --test tests/incident-investigations.test.cjs tests/migrations.test.cjs
```

- [ ] **Step 6: Commit (if git available)**

```bash
git add src/lib/incident-investigations.cjs src/migrations/036_incident_investigations.cjs tests/
git commit -m "feat(safe): incident investigation schema and CRUD"
```

---

### Task 4: API routes + multer uploads

**Files:**
- Create: `resources/app/src/routes/manager/incident-investigations.cjs`
- Modify: `resources/app/src/routes/manager/index.cjs`
- Modify: `resources/app/src/lib/app-boot.cjs` only if static `/assets` not already served — prefer reading template via `path.join(appRoot, 'assets/...')` in lib (no public exposure required)

- [ ] **Step 1: Register routes**

In `index.cjs`:

```js
const { registerIncidentInvestigationRoutes } = require('./incident-investigations.cjs');
// ...
registerIncidentInvestigationRoutes(server, ctx);
```

- [ ] **Step 2: Implement route module**

Reuse `canAccessSafeInspections` / `requireSafeAccess` pattern from `safety-inspections.cjs`.

Endpoints:

| Method | Path | Behavior |
|--------|------|----------|
| GET | `/api/safety/investigations` | list |
| POST | `/api/safety/investigations` | create draft (prefill retail from `getStoreMeta`) |
| GET | `/api/safety/investigations/:id` | get |
| PATCH | `/api/safety/investigations/:id` | update fields/payload/signoffs |
| POST | `/api/safety/investigations/:id/submit` | validate + submit |
| GET | `/api/safety/investigations/:id/export.pdf` | PDF bytes (Task 5; stub 501 until then) |
| POST | `/api/safety/investigations/:id/attachments` | multer single `file`, kinds query/body |
| GET | `/api/safety/investigations/:id/attachments/:attId` | download |
| DELETE | `/api/safety/investigations/:id/attachments/:attId` | delete file + row |
| POST | `/api/safety/investigations/:id/signatures/:role` | body `{ dataUrl }` PNG → save `sig-<role>.png`, update signoffs |

Upload limits: images `image/jpeg|image/png|image/webp` + `application/pdf`; max 10MB; max 30 files per investigation.

Multer `diskStorage` destination = `getAttachmentsDir(id)` (mkdir sync).

Audit log actions: `incident_investigation_created|updated|submitted|exported`.

- [ ] **Step 3: Manual smoke with service or test harness**

```bash
# after service restart / test API
# login as TRAINING MODE → POST create → GET list → expect 1 draft
```

- [ ] **Step 4: Commit (if git available)**

```bash
git add src/routes/manager/incident-investigations.cjs src/routes/manager/index.cjs
git commit -m "feat(safe): incident investigation API and uploads"
```

---

### Task 5: PDF stamp engine + coordinate map

**Files:**
- Create: `resources/app/src/lib/incident-investigation-pdf-map.cjs`
- Create: `resources/app/src/lib/incident-investigation-pdf.cjs`
- Create: `resources/app/tests/incident-investigation-pdf.test.cjs`
- Modify: export route to call `buildInvestigationPdf`

- [ ] **Step 1: Failing PDF test**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const { buildInvestigationPdf, getTemplatePath } = require('../src/lib/incident-investigation-pdf.cjs');

test('template asset exists and has 5 pages', async () => {
    const p = getTemplatePath();
    assert.ok(fs.existsSync(p), p);
    const doc = await PDFDocument.load(fs.readFileSync(p));
    assert.equal(doc.getPageCount(), 5);
});

test('buildInvestigationPdf returns multi-page PDF bytes', async () => {
    const bytes = await buildInvestigationPdf({
        investigation: {
            incident_number: 'INV-20260719-001',
            report_date: '19-07-26',
            // minimal filled payload + signoffs
        },
        attachments: [],
        attachmentFiles: [], // [{mime, bytes, label}]
    });
    assert.ok(bytes.byteLength > 1000);
    const doc = await PDFDocument.load(bytes);
    assert.ok(doc.getPageCount() >= 5);
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement map + builder**

`getTemplatePath()` → `path.join(__dirname, '../../assets/safety/tgp-incident-investigation-appendix-b.pdf')`.

`incident-investigation-pdf-map.cjs` exports arrays like:

```js
module.exports = {
  texts: [
    { key: 'incident_number', page: 0, x: 420, y: 520, size: 10 },
    // ...
  ],
  checks: [
    { key: 'incidentTypes.first_aid', page: 0, x: 72, y: 400, size: 10 },
  ],
  images: [
    { key: 'signoffs.lead.signatureFile', page: 4, x: 350, y: 120, width: 140, height: 40 },
  ],
};
```

**Calibration method:** Start with approximate coords from rendered page PNGs (`agent-tools/incident-pdf/page-N.png` at 2× scale). Adjust until a filled sample visually matches. Document in map file header: page origin is pdf-lib bottom-left; units are PDF points.

`buildInvestigationPdf`:

1. Load template  
2. Embed standard font  
3. Draw strings / ✓ marks / signature PNGs from investigation + files on disk  
4. For each image attachment, add a page with title + embedded image (fit width)  
5. For PDF attachments, add a text listing page (“Attached PDF: name”) — optional merge later  
6. Return `Uint8Array`

Wire `GET .../export.pdf` to set `Content-Type: application/pdf` and `Content-Disposition: attachment; filename=...`.

- [ ] **Step 4: Run PDF tests — PASS**

- [ ] **Step 5: Visually spot-check one export** (open PDF on store PC)

- [ ] **Step 6: Commit (if git available)**

```bash
git add src/lib/incident-investigation-pdf*.cjs tests/incident-investigation-pdf.test.cjs src/routes/manager/incident-investigations.cjs
git commit -m "feat(safe): stamp Appendix B PDF for investigations"
```

---

### Task 6: `/safe` UI — tabs + wizard

**Files:**
- Modify: `resources/app/safe.html` (substantial)

- [ ] **Step 1: Restructure home**

- Title: `WORKSITE SAFETY`
- Tabs: `INSPECTIONS` | `INVESTIGATIONS`
- Inspections tab: existing START MONTHLY + recent list (move current markup)
- Investigations tab: `START INVESTIGATION` + list from `/api/safety/investigations`

- [ ] **Step 2: Add wizard screen `#investigate-screen`**

Step indicator (1–8). One panel visible at a time. Buttons: Back / Save draft / Next. Final step: Review incomplete list, Submit & download PDF, Download PDF (draft preview).

Signature pads: canvas 300×80, buttons Clear / Use; on blur/next POST signature dataURL to `/signatures/:role`.

Uploads: `<input type="file" accept="image/*,application/pdf" multiple>` → FormData POST attachments; list with delete.

Auto-save: on Next and on Save, `PATCH` full payload.

- [ ] **Step 3: Wire navigation**

`show()` views: `auth-screen`, `home-screen`, `inspect-screen`, `investigate-screen`.

- [ ] **Step 4: Manual UI check on phone/desktop**

Login → Investigations → start → fill basics → save → refresh → continue → export PDF downloads.

- [ ] **Step 5: Commit (if git available)**

```bash
git add safe.html
git commit -m "feat(safe): investigation wizard and archive tab"
```

---

### Task 7: Version, release notes, service verify

**Files:**
- `src/app-version.cjs` → `5.2.5` (or next patch)
- `package.json` version
- `release-manifest.json` (migration 36, notes)
- `CHANGELOG.md`, `PATCH_NOTES.txt`, `README.md`
- `tests/migrations.test.cjs` already at 36

- [ ] **Step 1: Bump version + notes mentioning incident investigations**

- [ ] **Step 2: Restart service**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File E:\TGPV5\TGP_V5\resources\app\service\_restart-service.ps1
```

- [ ] **Step 3: Verify**

```text
GET /api/ready → appVersion 5.2.5
GET /safe loads
POST /api/safety/investigations (authed) → draft
```

- [ ] **Step 4: Commit (if git available)**

```bash
git add src/app-version.cjs package.json release-manifest.json CHANGELOG.md PATCH_NOTES.txt README.md
git commit -m "chore: release 5.2.5 incident investigations on /safe"
```

---

## Spec coverage checklist

| Spec requirement | Task |
|------------------|------|
| Guided wizard | 6 |
| Real PDF stamp of Appendix B | 1, 5 |
| Two archive tabs | 6 |
| Uploads + appendix | 4, 5 |
| Drawn signatures | 4, 6 |
| Same Safe access | 4 |
| Draft/submit/re-export | 3, 4, 6 |
| Migration / archive tables | 3 |
| Tests | 2–5 |
| Errors/limits | 3, 4 |

## Self-review notes

- No TBD placeholders left in tasks.
- Payload uses JSON columns for checklist density (matches maintainability; still stamps onto exact PDF).
- PDF map will need a calibration pass in Task 5 — budget time; export must not ship with empty coordinates for required header fields.
- Skip git commits when repository is absent.
