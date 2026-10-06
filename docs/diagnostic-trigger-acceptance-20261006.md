# Processing trigger acceptance (2026-10-06)

Authorized by owner decision K-8DYYY8, relayed by Bell. Contract v0.24: optional diagnostic_log.trigger identifies the processing entry point; exact values and retry semantics are in diagnostics.md. Implementation commit 08410cc5b74a356e0802bcccb4291014a277b22e was pushed to public main and deployed using the standard backup/build/restart procedure.

Focused diagnostics: 8/8 passed. Server typecheck passed, server suite 37/37 passed. Tests cover all ten enum values, omission, strict unknown key/value rejection, fingerprint/group/count/severity preservation, raw/admin propagation, identical retry and changed-payload conflict.

Production startup retained APNs and call-bridge. Public /healthz, /privacy, /support returned 200; unauthenticated /mcp returned 401. Public authenticated diagnostics smoke accepted an omitted-trigger event and a foreground_refresh event into the same fingerprint, count 2; identical replay was duplicate; retrofitting a trigger returned 409; unknown key/value returned 400. Raw and existing admin diagnostic_log/diagnostic_context retained foreground_refresh.

Synthetic group c4e674ce0692d3fc83361d2f46765431dc1c5943ec22c1e79bff05ed75457273 was resolved with an explicit synthetic note. Disposable account, raw events and receipts were deleted; revoked session returned 401. No real user's event or resolution was modified. Reusable smoke: tools/deploy/diagnostic-trigger-smoke.mjs, streamed into the production server container without printing credentials.

Native TaskLocal capture and actual BugHub presentation are separate acceptance steps owned by Bell and Fragile; server acceptance does not establish either. Build15 list cancellation remains open.
