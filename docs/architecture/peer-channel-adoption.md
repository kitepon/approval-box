# Approval Box on peer-channel (c8): target function and data flow

Status: design 0.1, 2026-11-22, Nayuta; step 1 (c8b) built on branch feat/c8b-pc-server (test server only, section 6). Source of truth for the move; [README.md](README.md) keeps describing the running product until each step ships, and is updated in the same diff as the step that changes it.
Inputs: the Owner's rulings of 2026-11-21 (content never stored on the server, only devices decrypt, a decided item goes to the deciding device's history and leaves the server; the server only introduces, content flows AI ↔ device directly; no server-served Web device), peer-channel contract 0.5.1 (kitepon/peer-channel `docs/contract.md`, diagrams `docs/diagrams.md`), login-billing contract 1.20/1.21 (reading 3).

## 1. Who holds what after the move
| Thing | Today | After |
|---|---|---|
| Request body (title, context, options, attachments) | server SQLite `decisions`, attachment files | the AI's local connector outbox (0600 file) until decided; the devices' own history after |
| Answer (option, text, attachments) | server SQLite, then delivered to the connector | device → connector over the peer-channel data channel; the deciding device's history; never the server |
| Decision status (pending, held, answered, cancelled) | server | connector outbox + device history; the server keeps none |
| Account K, passes, contracts | login-billing (library) | unchanged |
| Connections (AI pairings) | server `connections` with token hash | unchanged (id, token hash, label chosen by the person); connector key added through 5.4 admission |
| Device registry | none | server mirror of signed snapshots (public keys only, contract 4.5) |
| Waits, sessions | none | server memory only (contract 6) |
| Push | APNs/FCM with the title | wake only, no content (contract 6.2). iPhone/Mac show the title by decrypting in the Notification Service Extension (peer-channel c6c); Android wakes the app, which dials and then shows the title from what it received |
| Diagnostics | server `diagnostics` (no content) | unchanged |

## 2. Function diagram (target)
| Function | Part | Input → output | Failure |
|---|---|---|---|
| AI asks (MCP `request_decision`, `amend`, `cancel`, `get_decision`, `list_my_decisions`, `resume_decision`) | connector (`approval-box` npm, stdio MCP) + peer-channel connector endpoint | AI → outbox entry → server `wake(K)` → device dials → `request` frame → `ack` | no verified device: the tool answers `no_device` plainly; outbox kept until decided or cancelled |
| Person decides | iPhone/iPad/Mac (Red Shoes), Android/Linux (Indivilia) peer-channel device endpoint | `answer` frame signed by the device key → connector checks (contract 8.3) → `result` to devices | `stale_version` carries `current`; `already_decided` carries the result |
| AI receives the answer | connector daemon | accepted answer → existing delivery to the AI's session (deliveries, channel) | unchanged delivery rules; the body never goes to the server |
| Device history | each device | received requests and results stored on the device (encrypted at rest by the OS store); retention setting stays on the device | another device may miss a decision (accepted by the Owner) |
| Introduce endpoints | server: peer-channel signaling, mirror, TURN credentials, wake | `/pc/v1/*` with `authenticate` = library pass for devices, connection token for connectors; `onPassEnded` wired to the mirror | contract 6 and 14 |
| Admit a device | verified device + new device | contract 5.3 (verify QR / typed code) and 5.2 (with a contract handoff) | `binding_failed` → start again |
| Pair an AI | connector + verified device | product pairing (code, claim) + contract 5.4 `PC1PAIR:` binding | "pairing not finished" with a way to start again |
| BellTeam as a registered client | BellTeam's own connector (owner: Delta) | becomes a peer-channel connector of the person's K through 5.4; the server's scoped client session and the `/v1/decisions` reads go | agreed with Delta before the server routes close |

## 3. Data flow (target)
AI → MCP (stdio) → connector outbox (local, 0600) → `wake(K)` (server → APNs/FCM, no content) → device opens the app or the NSE → signaling `join`/`waits` (server memory) → sealed offer/answer/candidates (server relays sealed bytes) → data channel device ↔ connector (DTLS) → `request` → person decides → `answer` → connector → AI. The server sees: K, connection ids, push tokens, registry public keys, sizes and times (contract 12). It never sees a title, a body, an option, an answer or an attachment.

## 4. What goes from the server (by step, never before the step that replaces it ships)
- `POST /mcp` (remote MCP) and the connector API that carries bodies (`/connector/v1/decisions*`, attachments): a cloud AI without a local connector can no longer reach Approval Box; this follows from the Owner's ruling that content flows AI ↔ device directly.
- `/v1/decisions*`, `/v1/events` with content, attachment routes, push text.
- Tables `decisions`, `decision_events` content, attachment files; purged once, with `secure_delete` and vacuum, and the NAS backup generation replaced (one generation, Owner ruling d04).

## 5. Order
1. c8b (Nayuta, test server): mount peer-channel's server part in approval-box (`/pc/v1`), `authenticate` from the library and the connection tokens, `onPassEnded` from the library, push `wake` through the existing APNs/FCM senders with no content. **Built** on feat/c8b-pc-server (section 6); not on main, not in production.
2. c8c (Nayuta): connector runs the peer-channel connector endpoint; MCP tools read and write the outbox; delivery to the AI unchanged.
3. c8d (Red Shoes) and c8e (Indivilia): apps use the device endpoints, device history, admission 5.2/5.3/5.4, NSE (iPhone/Mac), wake handling (Android).
4. c8f (Delta, via the coordinator): BellTeam's registered client becomes a connector.
5. Single security review (Airi) of peer-channel and this adoption, with the batched security rows.
6. Production: needs reading 3 in production with `oldHandoff: "off"` (approval-box t30) and Mint's acceptance; the Owner's devices are admitted; then the content routes close and the tables are purged (section 4).

## 6. Step 1 as built (c8b, branch feat/c8b-pc-server, test server only)
- Pinned: peer-channel TS part `@kitepon/peer-channel` 0.1.0, packed (`npm pack` in `ts/`) from kitepon/peer-channel main b0b09ad (contract 0.5.1), npm tgz `vendor/kitepon-peer-channel-0.1.0.tgz` sha256 6a36e37d31754825b2469c56a262544d48bda4b9fb71cc628a58c3085fdf45fe; no git dependency, no registry publish. Its `@hpke/common` is pinned to the reviewed 1.13.0 through the root `overrides` (npm ignores a dependency's own overrides). The server imports only `@kitepon/peer-channel/server`; `node-datachannel` (prebuilt, for the connector part) is installed with it but never loaded by the server.
- Mount (server/pc.ts `createPeerChannel`, main.ts): only when the library is mounted. The part's HTTP routes (`/pc/v1/registry`, `/pc/v1/turn`) are answered before Hono through the `createServer` option of `serve`; the WebSocket `/pc/v1/signal` through the server's `upgrade` event (other upgrades are refused as before). Wire forms: peer-channel `docs/signaling.md`.
- `authenticate`: the library's `handler.authenticate` (Bearer pass) → `{ k, kind: "device", endpoint_ref: passId, pass_kind: store | signed | handoff }`; on `pass_invalid` only, the connection token (`accounts.connectionByToken`) → `{ k: the connection's K, kind: "connector", endpoint_ref: connection id }`; neither → 401 `unauthenticated`; any other library code (`pass_refused`, `pass_expired`, `origin_refused` …) → 403 with that code. A renewed pass is not returned on `/pc/v1` (the apps renew on `/v1`).
- `onPassEnded`: the library's `onPassEnded(callback)` → the part's `onPassEnded`, which frees that pass's mirror slots at once (contract 4.5, 0.4.10).
- `wake(K, alert)`: push.ts `Waker` through the existing APNs and FCM senders to K's registered devices, with contract 6.3's fixed payloads only: APNs `{ aps: { alert: { "loc-key": "PC_NEW" }, "mutable-content": 1, sound: "default" }, pc: 1 }` (push type alert, priority 10) when `alert`, else `{ aps: { "content-available": 1 }, pc: 1 }` (background, priority 5); FCM data `{ pc: "1", a: "1" | "0" }`. No title, requester, id or badge. Dead tokens are removed as today; logs carry the status only. Today's `Notifier` for `/v1` decisions is unchanged.
- Mirror: `SqliteMirrorStore` in its own file `/data/pc-mirror.db` (0600, `secure_delete` on), not in `approval-box.db`, so no migration and no db schema change. `DELETE /v1/me` also forgets K's mirror and closes K's sockets.
- TURN: only when `PC_TURN_SECRET` (or `_FILE`) and `PC_TURN_URLS` (comma list) are set; otherwise `POST /pc/v1/turn` answers `urls: []` (no coturn yet).
- Tests: packages/server/test/peer-channel.test.ts (the four authenticate cases, a mirror round trip through `/pc/v1/registry` freed by a sign-out, TURN without settings, a connector's `wait.open` reaching `wake`, and that a wake carries no content).
- Not yet: the join refusal for a pass without a live entitlement (contract 10.2) needs a join-level refusal in the server part (today `authenticate` is per connection); the connector G2 check (`known(K)`) is not applied on `/pc/v1`; `oldHandoff: "off"` (contract 2 product duty) is still the library default "on" on the test server.
