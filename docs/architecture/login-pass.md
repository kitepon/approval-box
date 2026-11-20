# Approval Box login and billing with the shared library (adoption order, phases A-C)

Owner: Nayuta (bot-4366a50b). Status: adoption plan, 2026-11-20, chart login-billing/baseline-20261120/t13-ab-plan. The mechanism is the shared login & billing library ([contract v1](/srv/bellteam/bots/bot-137fd092/docs/login-billing/library-contract.md), builder Prim, owner Mint) implementing [design-qr-pass.md](/srv/bellteam/bots/bot-137fd092/docs/login-billing/design-qr-pass.md) and the Owner's baseline (App Store + Google Play only, Apple + Google sign-in only, no linking, Stripe abolished, pass 14 days sliding, stopping one device, no QR login before a contract). Approval Box builds none of the mechanism itself; it mounts the library and keeps its product content under K. This page replaces the in-product design of PR #46.

## Functions (what Approval Box owns vs. the library)

| Function | Owner | Input -> output | Failure / exit |
| --- | --- | --- | --- |
| Sign-in, K, receipts, store asking, pass issue/check/renew, QR handoff, refused passes, per-K memory | library server part, mounted by http.ts under `/v1/lb/` | library wire contract v1 | library error codes (signin_invalid, pass_*, no_entitlement, slot_gone ...) |
| Library configuration | server main.ts | signIn client ids (existing APPLE_AUDIENCES, GOOGLE_CLIENT_IDS); stores: Apple { bundle dev.kitepon.approvalbox, app Apple id, API key ref }, Google { package dev.kitepon.approvalbox, service account ref }; products [{dev.kitepon.approvalbox.monthly, apple, subscription}, {dev.kitepon.approvalbox.monthly, google, subscription}]; kKey, passKeys, exemptK = the Owner's K; billing "store" (BILLING=off servers pass "off") | missing key -> the server does not start in library mode (named error) |
| Storage for the library | server lb-storage.ts on SQLite table `lb_kv(key, value, expires_at)` | put/get/delete with expiry, only handoff slots and refused pass ids | expired rows swept with the existing sweep; survives restarts so a stopped device stays stopped |
| Device gate (G1) | http.ts v1 middleware | Bearer pass -> library check -> K, entitlements, renewedPass (sent back in `X-Approval-Box-Pass`). Paid routes need a live monthly entitlement or exempt K: decision list/get/answer/hold/delete, attachments, SSE | 402 `subscription_expired`. Always open: /me, settings, devices, pairing lookup/claim/reject, setup-test decisions (setup_test stays outside both gates) |
| Non-device gate (G2) | accounts.ts assertCanUse for connection tokens and BellTeam client tokens | library `known(K)`: none -> 402; active or unknown -> accepted | as today's 402 |
| End waiting AI requests | decisions.ts `endForNoContract(K)` registered with library `onNone` | pending/held AI decisions of K end as cancelled, cancel_reason `subscription_expired` | setup-test decisions are not ended |
| /me | accounts.ts | user_id = K, plan active/expired from the pass's entitlements (device) or known(K); store from the entitlement; purchase mark from the library | unchanged shape |
| Product content | db.ts | users, decisions, history, attachments, request_uploads, connections, pairings, devices, setup_checks, idempotency, events keyed by K | unchanged |
| Copy of what is kept (adoption condition, Mint/Poli 2026-11-20) | http.ts `GET /v1/me/export` (G1 pass, no entitlement needed), accounts.ts `exportAll(K)` | everything kept under K as one file the person downloads self-service from the account section of Settings in the signed-in app (finishes automatically; no request form the operator receives or answers; Owner ruling via Poli 2026-11-20): account settings, decisions with history and answers, attachment metadata and files (zip), connections (labels, created/last seen, no token hashes), devices (platform, created; no push keys), setup checks | nothing is answered by e-mail or on the account number alone; an export never includes other accounts or secrets |
| Account deletion | existing `DELETE /me` | deletes everything kept under K (already in the app) | unchanged |
| AI pairing approval | existing /v1/pairing/* | approved from the phone or Mac app with a pass (no entitlement needed) | unchanged |

## Data flow

```mermaid
flowchart LR
  P[iPhone/Mac app + library apple part / Android app + library android part] -->|/v1/lb/signin id token + receipts| L[library server part in approval-box-server]
  L -->|pass, K, purchase mark, entitlements| P
  W[Web app + library web part / Linux app + JVM core] -->|/v1/lb/handoff/start, take| L
  P -->|/v1/lb/handoff/approve, confirm| L
  L <-->|status by contract ref| ST[Apple / Google servers]
  L <--> KV[(lb_kv: handoff slots, refused pass ids)]
  P -->|Bearer pass| G1[G1 middleware: library check]
  W -->|Bearer pass| G1
  G1 -->|K| C[(content under K)]
  A[AI connector / BellTeam token] -->|token -> K| G2[assertCanUse: library known K]
  G2 --> C
  L -.->|onNone K| E[endForNoContract K]
```

## Adoption order

- **A. Server, compatible (Nayuta).** Precondition: library accepted (t12) and pinned by version + checksum; K-key, pass-keys, Apple In-App Purchase key in the host vault (Sakura). Steps, diagrams first in the same diff: mount the library; lb_kv storage; G1 for pass requests; G2 via known(K); onNone -> endForNoContract; rekey migration (K for every identities row computed with the library's own K function, user_id replaced by K in every content table; the 8 identity-less test accounts deleted under Mint's run-time check, stop and change nothing if it fails; exempt list switched to the Owner's K in the same deploy). Old sessions, /v1/auth/*, browser login and the subscription tables keep working so current app versions keep running.
- **Logs and legal pages (A).** No account number (K or old user id) in Approval Box's own logs; the admin command that prints a session for a user id is removed in A. The annex privacy/terms pages change on the switch day, from Poli's draft (login-billing t17-privacy-draft).
- **B. Apps.** iPhone/Mac (Redshoes): library apple part (sign-in, StoreKit purchase with the mark, receipt, Keychain pass, QR scan and short code approve with Approval Box's confirm screen, linked devices and stop) plus an AI pairing approval screen on Mac. Android and Linux (Indibiria): library android part and JVM core; Apple sign-in on Android becomes QR login from an iPhone; Linux shows the QR or short code and 「先にスマホで契約してください」 when approval is refused. Web (Nayuta): library web part, QR and check number, no Apple/Google buttons. Every app offers 「保存されている情報の写しを受け取る」 (the export above) next to account deletion in Settings. Store releases are the Owner's decision. The sandbox acceptance run (t15-ab-accept) happens here.
- **C. Server removal (Nayuta).** After the Owner's devices and the minimum supported versions use passes: remove sessions, identities, auth_flows, login_links, /v1/auth/*, browser login, appstore.ts, play.ts and their tables and store notification endpoints (the library asks the stores).

## Requests to the library (for Mint/Prim)
- Export the K function so the rekey migration computes the same K as signIn.
- K and the Apple purchase mark as UUIDs, so existing columns and appAccountToken keep their type.

## Contract 1.5 / library 0.2.1 details for Approval Box (t14, 2026-11-20)

- Pinned: npm tgz sha256 9e64b2eca3be6293c1a1fe8ae5cc4852ae50cc44aa7fca5ef02a80be9d9a85dd (server + web), core jar 155a5550662171b78f289d3e784081184d2570a3e86158bb829869cfadecdb89, android aar b43467757a39bccd4f8ab69b7e6fc7a58bccbfb9016c61b63d859c6f8ac997d4, Swift package tag v0.2.1 (release https://github.com/kitepon/login-billing/releases/tag/v0.2.1). Used unchanged; a need or bug goes to Mint as one message.
- Mount: the library handler at `/auth/v1` (wire v1: signin/nonce, signin, receipt, handoff/start|approve|confirm|take, refuse, stop-all-others, signout). Product routes `/v1/*` use the handler's authenticate(request): Bearer for apps and the Linux client, cookie `lb_pass` with allowed origin https://approval-box.kitepon.dev for the Web. A renewed pass comes back in `Login-Billing-Pass`.
- Pass kinds: only a phone's (store) pass may attach receipts, approve a QR, refuse, stop all others. Web/Linux hold handoff passes.
- Storage: SQLite `lb_kv(key, value, expires_at)` behind the library Storage interface for nonces, handoff slots, refused pass ids and notBefore records; signin/nonce and handoff/start rate-limited per client by Approval Box.
- Sign-in needs a server nonce (apps call signin/nonce first; Apple gets sha256hex(nonce)). Receipts never fail a sign-in (per-receipt results).
- Apps call start() at launch and on foreground; signOut clears the device; stopAllOthers for a lost phone.
- Test environment: a second server `approval-box-test` on main-server with its own database and keys, at https://approval-box-test.kitepon.dev, App Store sandbox and Play internal track. t14 closes when the server and every app run there.
- Google id-only test preparation (README list): dedicated Google Cloud OAuth web client (consent scope openid only) + Android OAuth client in the same project; web client secret through Sakura into signIn.googleCode; Android switch for the id-only route; two test Google accounts (fresh, and one that granted e-mail first).

## Not changed
- Connection tokens and BellTeam client tokens stay valid; only their owner key becomes K. Nobody pairs again.
- Diagnostics stay unlinked to accounts.
- Account deletion deletes content under K; store contracts are cancelled by the user in the store.
