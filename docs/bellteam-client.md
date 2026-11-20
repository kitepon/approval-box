# BellTeam as an Approval Box client (API v0.38)

Owner: Nayuta (bot-4366a50b). Requested for the BellTeam Approval Box extension (module owner Delta, bot-ae42e3e9; coordinator Trony; request R1). Canonical for this contract; the extension's design references it.

## What it is

BellTeam is a **registered client** of Approval Box, like the iPhone, Android and Web apps: it acts for the signed-in user on that user's own account. BellTeam is self-hosted by each customer, often on a LAN address with no public host, so the connection uses a **device-authorization flow with no redirect to the customer's server**. The user does not copy or paste anything: BellTeam opens a hosted Approval Box page, the user signs in and answers one consent question, and BellTeam receives a scoped session by polling.

Today's registered client: `bellteam` (display name "BellTeam"). Unknown client names are refused (400).

## Flow

```mermaid
sequenceDiagram
  participant B as BellTeam module (server)
  participant A as Approval Box
  participant U as User (browser)
  B->>A: POST /connector/v1/pairing {device_name, client:"bellteam"}  (no auth)
  A-->>B: {pairing_id, code, qr_url, poll_secret, expires_at (15 min)}
  B->>U: opens qr_url = https://approval-box.kitepon.dev/pair?c=CODE (no typing)
  U->>A: signs in (Apple/Google) if needed; sees "Allow BellTeam ...?"
  U->>A: POST /v1/pairing/{id}/claim {confirm_client:"bellteam"}  or  /reject
  B->>A: GET /connector/v1/pairing/{id}  X-Poll-Secret (long poll, up to 25 s)
  A-->>B: {status:"claimed", client, session:"kss_…", expires_at}  (once)
  B->>A: Bearer session on /v1 (allowlist below)
```

Poll results (`status`): `waiting` (poll again), `claimed` (carries `session` and `expires_at`, once), `delivered` (already taken), `rejected` (the user declined = `access_denied`), `expired` (15 minutes passed = `expired_token`). The poll is a long poll, so no `slow_down`/interval is needed: call again right after any `waiting`. Every state leaves by the next poll or by starting a new request.

The consent step is required: claiming a client pairing without `confirm_client` equal to the pairing's client answers 409 `conflict`. So only a screen that shows the user who is being allowed (today the Web `/pair` page; native apps after they show it) can approve. Old screens cannot approve one by accident.

## The scoped session

Same bearer as a login session, with `sessions.client = "bellteam"`. It sees **every decision of the approving user's account**, whichever AI or connection filed it. It is limited to this allowlist; anything else answers 403 `forbidden`:

| Method | Path | Use |
| --- | --- | --- |
| GET | `/v1/decisions` | list (`status`, `limit`, `cursor`) |
| GET | `/v1/decisions/{id}` | one |
| POST | `/v1/decisions/{id}/answer`, `/hold`, `/unhold` | the user's tap, sent as the user (`version` and `Idempotency-Key` as today; `history.by = "user"`) |
| GET | `/v1/decisions/{id}/attachments/{aid}` | read request images and answer attachments |
| GET | `/v1/events` | SSE (`Last-Event-ID` as today) |
| GET | `/v1/me` | plan, `expires_at`, `store`, `billing` (entitlement facts) |

Not allowed: attachment upload/stage/delete, `DELETE /decisions`, `/connections`, `/tokens`, `/pairing/*`, `/devices`, `/me/settings`, `DELETE /me`, billing, auth. A client session cannot approve another client or change the account.

**Lifetime.** 90 days, sliding: using it renews it (the expiry is rewritten when it has shrunk by 30 days), so a connection in use never needs a new consent; one unused for 90 days answers 401 and the user connects again.

**Revoke.** The user's connection list (`GET /v1/connections`) shows it as `kind:"client"`, label "BellTeam". `DELETE /v1/connections/{id}` removes the session at once: the next call answers 401, and an open `/v1/events` stream closes at its next heartbeat (≤ 25 s). Deleting the account removes it too. The session is stored as a hash like every session.

## `source.requester_bot_id` (additive)

`Decision.source.requester_bot_id?: string` (`^bot-[a-z0-9]+$`, ≤ 64). Self-reported by the connector when it runs inside a BellTeam seat (the seat id it already uses for wake-up notices). Display only, like `requester`; it is not authentication. Decisions filed before this version, by an old connector or by a non-BellTeam AI have none. Needs the connector release to reach BellTeam seats.

## Functions and data

| Function | Owner of state | Input → output | Failure / exit |
| --- | --- | --- | --- |
| Start | `pairings` (`client`, 15 min) | public POST → code, poll secret | expires; start again |
| Consent | Web `/pair` page, `claim`/`reject` | signed-in user + `confirm_client` → session issued, stored in the pairing row until polled | 409 without confirm; expiry |
| Hand-over | `pairings.token` | poll with the secret → session once, then cleared | `delivered`/`expired` |
| Scoped access | `sessions.client`, `CLIENT_ROUTES` | bearer → user + client; allowlist. In library mode ([login-pass.md](architecture/login-pass.md)) every allowed route except `GET /me` also answers 402 `subscription_expired` while the library remembers the account as having no contract (G2) | 401 expired/removed; 403 outside the list; 402 no contract |
| Revoke | `connections()` / `revokeConnection` | user's DELETE → session deleted | 404 if already gone |

Unchanged: login sessions, connector tokens, remote MCP, existing routes and shapes, billing. Errors added: 403 `forbidden`.
