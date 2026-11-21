# Approval Box on peer-channel (c8): target function and data flow

Status: design 0.1, 2026-11-22, Nayuta. Source of truth for the move; [README.md](README.md) keeps describing the running product until each step ships, and is updated in the same diff as the step that changes it.
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
1. c8b (Nayuta, test server): mount peer-channel's server part in approval-box (`/pc/v1`), `authenticate` from the library and the connection tokens, `onPassEnded` from the library, push `wake` through the existing APNs/FCM senders with no content.
2. c8c (Nayuta): connector runs the peer-channel connector endpoint; MCP tools read and write the outbox; delivery to the AI unchanged.
3. c8d (Red Shoes) and c8e (Indivilia): apps use the device endpoints, device history, admission 5.2/5.3/5.4, NSE (iPhone/Mac), wake handling (Android).
4. c8f (Delta, via the coordinator): BellTeam's registered client becomes a connector.
5. Single security review (Airi) of peer-channel and this adoption, with the batched security rows.
6. Production: needs reading 3 in production with `oldHandoff: "off"` (approval-box t30) and Mint's acceptance; the Owner's devices are admitted; then the content routes close and the tables are purged (section 4).
