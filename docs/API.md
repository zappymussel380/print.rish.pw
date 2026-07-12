# API reference

All handlers use the Node runtime. Mutations require same-origin Fetch Metadata
or an exact `Origin`; session cookies are `SameSite=Strict`. Redis limits apply
per observed client IP unless noted. JSON routes stream through endpoint-specific
byte ceilings, including chunked requests. Errors use
`{ "error": { "code", "message", … } }`.

## Quote flow

### `POST /api/uploads`

Streams one multipart model to a private temporary file, hashes/parses it,
checks bed fit and quotas, and creates session-owned model row(s). Multi-plate
3MF can return several normalized STL-backed models.

- 300 MiB hard file limit and 10-minute absolute body deadline
- 20 requests and 900 MiB accepted bytes per IP/10 minutes by default
- session model/byte quotas and shared free-space reservation
- `201 { model, models }`
- `408 UPLOAD_TIMEOUT`, `413`, `422`, `429`, or `507 STORAGE_LOW`

### `GET /api/models`

Lists active unattached models owned by the quote session.

### `DELETE /api/models`

Body `{ keep: [modelId, …] }`; atomically removes this session's unattached
models not present in `keep`. Body limit 16 KiB.

### `GET /api/models/:id/file`

Downloads session-owned/admin model bytes through a no-follow regular-file
descriptor. Includes per-IP download byte limiting. Returns `410 FILE_EXPIRED`
after retention removes the model file.

### `GET /api/models/:id/thumb`

Returns or regenerates a bounded PNG thumbnail for a session-owned/admin model.

### `DELETE /api/models/:id`

Atomically removes an unattached model from the current session.

### `POST /api/slices`

Body `{ modelId, settings }`. The model must belong to the current session.
Cache identity includes pipeline/profile version, declared model format, file
hash, and canonical settings. A miss creates a `SliceResult` and enqueues one
validated job; a hit returns immediately. Limit: 60/IP/10 minutes.

- `200` cache hit or `202` queued
- `{ sliceId, status, result, error }`

### `GET /api/slices/:id`

Polls a slice owned indirectly by this session (the session must own a model
with the same hash). Limit: 3,000/IP/10 minutes. Status is
`queued | slicing | done | failed`.

### `POST /api/shipping`

Body `{ deliveryPincode, items }` (32 KiB). Rebuilds weight/value from
session-owned completed slices. Cached results avoid the paid provider; misses
have tighter per-IP+session and global provider limits. Returns a short-lived
signed estimate token bound to pincode, parcel, and amount.

### `POST /api/quotations`

Body `{ items: [{ modelId, config }], customer, shippingToken? }` (32 KiB).
Reprices entirely from database slice results, validates any signed shipping
estimate, atomically claims each model as single-use, allocates an
`RSP-<year>-<seq>` number, writes the quotation, and attempts a bounded PDF.
Client totals are ignored.

- per-IP limit: 5/10 minutes
- cross-IP circuit breaker: 200 validated checkout attempts/day
- `201 { number, accessToken, pdfUrl, whatsappUrl }`
- the 256-bit `accessToken` is returned once; only its SHA-256 verifier is stored
- `409 MODEL_ALREADY_SUBMITTED`, `409 SHIPPING_STALE`, `409 NOT_SLICED`, or
  `503 CHECKOUT_CAPACITY_REACHED`

## Quotation capability flow

The browser navigates to `/quotation/:number#token=<capability>`. URL fragments
do not reach HTTP servers/logs. Client code immediately calls:

### `POST /api/quotations/:number/access`

Body `{ token }` (4 KiB), same-origin and limited to 10/IP/15 minutes. A valid
capability sets a per-quotation `Secure`, `HttpOnly`, `SameSite=Strict`,
host-only cookie and returns `{ ok: true }`. The fragment is then removed from
history. Capabilities/cookies expire 30 days after quotation creation.

### `GET /api/quotations/:number/pdf`

Streams a PDF for a valid quotation cookie or admin session. Limit:
30/IP/10 minutes; maximum file size 20 MiB; response is private/no-store.
`?token=` is accepted only to keep pre-migration links working and upgrades a
valid token into the cookie. Do not generate new query-token links.

Unknown number, invalid/expired access, and missing PDF deliberately share the
same 404 for non-admin callers.

## Contact and health

### `POST /api/contact`

Body `{ name, email, subject, message }` (8 KiB). Validates allowlisted subjects,
lengths, email shape, and control characters, then sends through Resend with a
10-second upstream timeout. Limit: 5/IP/10 minutes.

### `GET /api/health`

Returns `{ ok, db, redis }`; 200 only when both dependencies respond, otherwise
503. Checks are coalesced/cached briefly to avoid turning health traffic into a
database/Redis amplification path.

## Admin

Middleware is an outer gate; every admin API independently verifies the signed
admin session. Sensitive responses are private/no-store/noindex.

- `POST /api/admin/login` — `{ password }` (4 KiB), bcrypt and 5/IP/15 minutes;
  sets the 12-hour admin cookie.
- `POST /api/admin/logout` — clears the cookie.
- `PATCH /api/admin/quotations/:id` — `{ status, note? }` (8 KiB), records
  history. Terminal statuses (`COMPLETED`, `DELIVERED`, `CANCELLED`) cannot be
  reopened because retained model files may be purged.
- `DELETE /api/admin/quotations/:id` — deletes the row/cascades, derived PDF,
  and now-unreferenced derived model/thumbnail files.
- `GET /api/admin/quotations/export` — protected CSV export.
