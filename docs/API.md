# API reference

All handlers run on the Node.js runtime. Mutating endpoints require a
same-origin request (CSRF guard: `Sec-Fetch-Site: same-origin` or a matching
`Origin`) and are rate-limited per IP (Redis sliding window). Errors use
`{ "error": { "code", "message", … } }`.

## Public — quote flow

### `POST /api/uploads`
Multipart upload of one model file. Streams to disk, hashes, validates by
actually parsing the geometry, checks bed fit. Creates an `UploadedModel` scoped
to the `qsid` session cookie (set if absent).
- **429** rate-limited (20 / 10 min) · **413** too large · **422** unsupported/empty/invalid model / too many models
- **201** `{ model: { id, originalName, format, sizeBytes, bboxMm, volumeCm3, triangleCount, fitsBed } }`

### `GET /api/models/:id/file`
Raw model bytes (session owner or admin) for the 3D viewer. `Content-Disposition: attachment`.

### `GET /api/models/:id/thumb`
Worker-rendered thumbnail PNG (session owner or admin).

### `DELETE /api/models/:id`
Remove a model from the current session (refused once it belongs to a quotation).

### `POST /api/slices`
Request a slice for `{ modelId, settings }` (`settings` = material, layerHeightUm,
infillPct, supports). Idempotent: cache hit returns the result; a miss creates a
`SliceResult` row and enqueues a BullMQ job. Rate-limited 60 / 10 min.
- **202/200** `{ sliceId, status, result, error }`

### `GET /api/slices/:id`
Poll a slice by result-row id → `{ sliceId, status, result, error }`. `status` ∈
`queued | slicing | done | failed`. The quote page polls every 1.5 s.

### `POST /api/quotations`
Checkout. Body `{ items: [{ modelId, config }], customer }`. Reprices
authoritatively from DB slice results (client totals ignored), allocates
`RSP-<year>-<seq>`, persists the quotation, renders the PDF, returns the WhatsApp
handoff. Rate-limited 5 / 10 min.
- **201** `{ number, accessToken, pdfUrl, whatsappUrl }`
- **409** a model isn't sliced yet · **422** invalid customer/items

### `GET /api/quotations/:number/pdf?token=…`
Stream the quotation PDF. Authorised by the constant-time `accessToken` or an
admin session. Rate-limited 30 / 10 min.

### `GET /api/health`
`{ ok, db, redis }` — 200 when both backends respond, else 503. Used by the
container healthcheck.

## Admin (session-gated by `middleware.ts`)

### `POST /api/admin/login`
`{ password }` → bcrypt-checked against `ADMIN_PASSWORD_HASH`, sets the admin
cookie. Rate-limited 5 / 15 min.

### `POST /api/admin/logout`
Clears the admin session.

### `PATCH /api/admin/quotations/:id`
`{ status, note? }` → updates status and records `StatusHistory`.

### `DELETE /api/admin/quotations/:id`
Deletes the quotation (cascades items/history), its PDF, and any model files no
longer referenced by another quotation.

### `GET /api/admin/quotations/export`
CSV export of all quotations.

## Confirmation page

`GET /quotation/:number?token=…` — customer-facing confirmation (PDF link +
WhatsApp CTA), token-guarded, `noindex`.
