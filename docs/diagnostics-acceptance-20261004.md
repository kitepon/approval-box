# Diagnostics acceptance — 2026-10-04 UTC / 2026-10-05 JST

Server implementation: public `kitepon/approval-box` commits `7a78fd5`, `a9391a6` and `4d32de5`. Contract: [diagnostics.md](diagnostics.md) and [api.md](api.md), section アプリ診断（2026-10-04）. The private apps repository was not edited by the server maintainer.

Server typecheck passed; all 34 server tests passed. Server/Web build passed during production deployment. Tests cover auth, unknown/secret fields, numeric/size restrictions, idempotency, canonical JSON, conflict, persistent receipts across database reopen, rate limits, LAN/proxy restrictions, BugHub string/object export types, resolution/reopening and MetricKit frames with and without sample counts.

Production deployment used the existing backup/rebuild script with APNs/call-bridge compose override. Initial server deployment was around 23:33:46 UTC; the optional sample count correction was deployed before 23:38:37 UTC. `/healthz`, `/privacy`, `/support` returned 200; unauthenticated `/mcp` and `/v1/diagnostics` returned 401. Direct LAN admin returned 200/JSON array with valid admin key; no-key requests returned 401. Public `/api/admin/logs` returned 404 via the Caddy block. Production's compiled schema accepted a crash frame containing only binary UUID and offset, without inserting a synthetic event.

Admin key was generated without printing its value, supplied via the existing read-only secret mount, and handed to the BugHub maintainer in a kite:kite 600 file. Only the Approval Box Caddy virtual host was changed, with validation/reload and a prior-config backup. Reproducible deployment tools are in `tools/deploy/`.

BugHub maintainer Fragile reported production revision `b5d2cf4`, readiness 6/6 passing, and a successful ApprovalBox seed poll at 23:35:51 UTC (0 records / 0 notifications). She independently verified LAN access from the BugHub container and the secret file's owner/permissions. BugHub source contract and production configuration belong to her repository.

Bell reported a real Mac application target (Debug, build 14), persistent shared AppDiagnostics outbox and normal URLSession, uploading one opt-in info diagnostic and replaying the identical payload. Application evidence reported by Bell: `runtime/diagnostics-live-mac.xcresult`. Initial upload returned 202 accepted=true / matching event ID and cleared the outbox; identical replay returned 202 duplicate=true. The server maintainer independently observed:

- event ID `72B28C1F-B66E-4D1E-99AC-4B9C83B1E5CE`
- fingerprint `916c95b84a2a4d3793ebe3d959805e4cbf71e7b585610be2f09976112fb47b3b`
- received at `2026-10-04T23:39:22.509Z`
- one raw event, one receipt, occurrence_count=1, severity=info, status=open
- module processing.Mac, category cancelled, app_version 0.1.0(14), OS 27.0.0
- structured cancellation=system, domain=NSURLErrorDomain, code=-999, operation=app.operation, user_visible=false

Fragile confirmed the first visible row at the 23:41:51 UTC poll: upstream open / BugHub new, one occurrence, all expected fields and types, 840-byte admin response, all seven sources successful and zero immediate notifications. She checked the production view's rendering function against the row; she did not inspect a browser.

The server maintainer resolved the group with HTTP 200 on 23:42 UTC. Fragile confirmed the 23:44:51 UTC poll: upstream resolved / BugHub resolved, count=1 and last_seen unchanged, removed from the unresolved list and no daily notification pending. The same poll confirmed the corrected captured app version metadata from `4d32de5`: diagnostic_log_version=0.1.0(14), diagnostic_context.diagnostic_schema_version=1.

Bell subsequently reported viewing the production BugHub Web UI in a real browser and confirmed resolved / count=1 / captured app version 14.

The native new-event trial encountered a Mac LaunchServices runner-launch refusal (OSStatus -10699 / prevent launch assertion) before generating or sending any event, while a TestFlight build 14 update was downloading. Bell is restoring normal launch and will retry through the same native shared sender. No alternative sender was used to claim native recurrence success. The original info group stays resolved.

Remaining integration checks: native new-event recurrence poll and final resolved poll. No synthetic crash/high severity event has been inserted into production. The info group will finish resolved.
