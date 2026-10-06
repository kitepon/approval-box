# Apple application diagnostics and BugHub

POST `/v1/diagnostics` requires a valid application Bearer session. Keep events in the application's persistent outbox before login; send them after login. Never attach authentication material to the event. Diagnostic uploads and their failures must be excluded from diagnostic capture.

Send `Content-Type: application/json` and `Idempotency-Key: <event_id>`. The key may be omitted; when present it must equal the event ID. One event per request, maximum 16 KiB including JSON whitespace. The schema in `packages/server/src/diagnostics.ts` is the exact allowlist; unknown object fields and unknown enum values return 400. No message, request/response body, raw URL, raw MetricKit JSON, symbol name, session, token, attachment content, or arbitrary string is accepted.

```json
{
  "event_id": "7198e131-f0ae-43d9-82cf-1b35eb7b9c1a",
  "occurred_at": "2026-10-04T23:00:00.000Z",
  "code": "decoding_failed",
  "module": "api",
  "app_version": "0.1.0(14)",
  "device_type": "iPhone",
  "os_version": "27.0.0",
  "diagnostic_log": {
    "operation": "decisions.list",
    "http_method": "GET",
    "http_status": 200,
    "response_format": "json",
    "error_domain": "DecodingError",
    "decoding_kind": "typeMismatch",
    "decoding_path": ["items", 0, "status"],
    "user_visible": true
  }
}
```

Top-level fields and `diagnostic_log.operation` / `user_visible` are required. All other log fields are optional. `occurred_at` needs an ISO 8601 timezone; timestamps over one day in the future are rejected. OS version is numeric major.minor.patch; app version is numeric major.minor.patch(build). MetricKit stack frames contain only `binary_uuid` (UUID), `offset` (nonnegative safe integer) and optional `sample_count` (nonnegative safe integer, only when the source provides it), with at most 32 frames. Frames without sample counts are accepted; clients must not invent counts or drop these frames. `decoding_path` contains at most 32 allowlisted keys or nonnegative integer indices; unknown keys must be converted to `other` on the client. Integer bounds are ±9007199254740991. Hang duration is a finite nonnegative number of milliseconds within the same upper bound.

Initial response: HTTP 202 `{"event_id":"<UUID>","accepted":true,"duplicate":false}`. The same event and canonically identical parsed payload returns HTTP 202 with `duplicate:true`; JSON object key order does not matter. Changing an existing event's payload returns 409. Event identity is `(user_id,event_id)`; receipt hashes survive raw-log eviction and process restarts, and are deleted when the user deletes their account. Duplicate retries do not change counters, latest diagnostics, or resolution status. A new event automatically reopens its fingerprint.

Limits: 60 new events per user per UTC hour and 1000 overall per UTC hour; 429 with `Retry-After: 3600`. Raw events: 30 days / latest 10000 rows. BugHub aggregates: 120 days since last receipt / at most 500 fingerprints. A new fingerprint beyond this cap is rejected with 429, so BugHub's limit=500 never silently hides a group. Receipt hashes remain until account deletion. Latest sanitized aggregate payload remains for 120 days. Event received time, rather than client event time, drives retention and BugHub `last_seen`.

Severity is computed by the server: crash=fatal; API/decoding/processing/hang=high; cancelled with `user_visible:true` or `cancellation:unexpected`=warn; remaining cancellations=info. Fingerprints hash code, module, device type, operation, HTTP method/status/format, error domain/code, decoding kind/path, cancellation, visibility, signal/exception and first binary UUID/offset. Numeric decoding indices are normalized to `[]`. Event UUID, timestamps, version, OS, frame sample count and hang duration do not split fingerprints. Binary UUID changes can still split crash groups across builds.

## BugHub admin API

Direct LAN URL in production: `http://192.168.1.2:18871`. All `/api/admin/*` requests require a private/loopback peer socket address, private IP literal Host, no proxy forwarding headers, and Bearer admin key. Public host requests return 403 even with a valid key. Missing/incorrect keys return 401. Socket-less requests fail closed. This API does not trust forwarded client addresses. All admin replies disable caching.

- GET `/api/admin/logs?status=all&limit=500`: JSON array, fingerprint aggregates, status all/open/resolved, limit 1..500. Every row has fingerprint, severity, message_template, occurrence_count, last_seen, status, module, category, app_version, diagnostic_log (JSON serialized string), diagnostic_log_version (the latest application version), diagnostic_log_received_at and diagnostic_context (object). Module includes device type. diagnostic_context.diagnostic_schema_version=1 identifies the structured format; diagnostic_log_version identifies the application build that captured the diagnostic. No user ID or account token is returned.
- POST `/api/admin/logs/resolve`: `{"fingerprint":"<sha256>","note":"optional operator note"}`; marks resolved idempotently. Note max 1000 characters and is stored internally, not exported as app diagnosis.
- POST `/api/admin/logs/reopen`: `{"fingerprint":"<sha256>"}`; marks open idempotently. Both respond `{"fingerprint":"<sha256>","status":"resolved|open"}`; unknown fingerprint returns 404.

Production key provisioning: stream `tools/deploy/diagnostics-config.py` to `ssh main-server python3 -`. It reuses or creates a 256-bit key at `/home/kite/approval-box/deploy/secrets/bughub-admin.key` (600), handed to the server through the existing read-only secret volume. A 600 handoff file for the BugHub maintainer is `/home/kite/.config/approval-box/bughub.env`. Never print or commit these files. `DIAGNOSTICS_ADMIN_KEY_FILE` points to the mounted plain key. Self-hosted deployments can use `DIAGNOSTICS_ADMIN_KEY` instead, but keep the value out of version control.

App code belongs to the private apps repository maintained by Bell; server changes stay in this public repository. BugHub registration and deployment belong to Fragile. Server deployment follows the existing backup/rebuild procedure and checks APNs and call-bridge startup alongside API smoke tests.

The public reverse proxy also blocks `/api/admin` and `/api/admin/*` with 404 before forwarding. Stream `tools/deploy/block-public-admin.py` to `ssh main-server python3 -` to reproduce this deployment rule. It changes only the Approval Box virtual host, backs up the prior file, validates/reloads Caddy and restores the prior configuration on failure.

## Optional processing trigger (2026-10-06)

`diagnostic_log.trigger` is optional and identifies the entry point that started the business processing which produced the diagnosis. Allowed values: `initial_refresh`, `foreground_refresh`, `toolbar_refresh`, `pull_refresh`, `notification_refresh`, `login`, `answer`, `hold`, `load_more`, `events`. It is distinct from HTTP request purpose. Internal list and badge requests inherit the outer processing trigger; clients keep it per Task (TaskLocal), and omit it when unclassified. No free text, URL, ID, session or body is accepted. Unknown keys and enum values still return 400.

Trigger is excluded from fingerprints and severity; existing groups and counts continue across trigger values and omission. Raw payloads retain it; the existing admin `diagnostic_log` and `diagnostic_context` expose it for the latest event. Admin aggregates do not provide trigger-specific counts; retained raw events are needed for distributions.

Apply only to newly captured events. Never mutate existing outbox bodies or event IDs: identical retries remain duplicates, while changing a received event's trigger (including adding/removing it) returns 409. This addition does not change cancellation, retry, error display, or SSE capture exclusions.
