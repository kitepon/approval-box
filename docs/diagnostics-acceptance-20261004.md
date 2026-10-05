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

After the normal TestFlight update completed, Bell successfully ran the native shared sender in a Debug target for build 15. New synthetic info event `FB096193-6FAE-407F-8261-F63558BB676A` occurred at `2026-10-05T00:12:42Z`, received at `00:12:42.666Z`. It returned 202, cleared the persistent outbox and replayed with duplicate=true. Independently, the server maintainer observed one raw event / one receipt for this new event, the same fingerprint, count=2, open, info, and captured app version `0.1.0(15)`.

Fragile confirmed the `00:14:51 UTC` BugHub poll: recurred / upstream open, count=2 (prev_count=1), last_seen `00:12:42.666Z`, app and diagnostic-log version `0.1.0(15)`, latest synthetic event ID and otherwise unchanged diagnosis. No recurrence notification was delivered. The server maintainer then resolved this synthetic fingerprint at approximately `00:17:38 UTC`, receiving HTTP 200 / resolved with count=2.

Fragile confirmed the final `00:17:51 UTC` poll (read at `00:18:04 UTC`): resolved / upstream resolved, count=2 (prev_count=2), last_seen unchanged, captured app version `0.1.0(15)`, removed from the unresolved list. All seven sources continued succeeding from seed through completion; readiness stayed ready at BugHub revision `b5d2cf4`. Duplicate replays changed neither the one-occurrence nor two-occurrence totals.

The complete production smoke sequence passed: seed → new native Mac event → duplicate replay → visible BugHub row → resolve → native new event → recurred/count2 → final resolve. Production has not yet exercised iPad diagnostics, MetricKit crash/hang rows, HTTP/response-decoding classifications or fatal/high immediate notifications; those are not claimed as live-tested. No synthetic crash/high severity event has been inserted into production. Real user diagnostics are independent groups and remain unresolved. Build 14 could mark an SSE cancellation user_visible=true even when no failure was actually displayed; that field alone is insufficient to prove a UI-visible failure. Bell owns the build 15 capture correction and distribution.
