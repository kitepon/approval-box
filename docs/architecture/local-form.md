# Approval Box on login-billing version 1 (0.21.1): target function, data flow and states

Status: design 2.2, 2026-11-24, Nayuta (chart approval-box/switch-20261124/t02-design). Replaces design 1.x of this page (withdrawn with contract section 11 drafts 1 to 4). Source of truth for the switch; [README.md](README.md), [login-pass.md](login-pass.md) and [peer-channel-adoption.md](peer-channel-adoption.md) keep describing what runs until each step ships, and each step updates them in the same diff.

Inputs: the Owner, 2026-11-24 ~14:0x JST: 「ミントに連絡し、新しい仕組みに切り替えろ」; his scope line (12:0x JST): the library ends where our server knows a signed-in device, everything from there to the AI is ours; 「ログイン基盤自体のコードの変更の権限はお前にはない。要望があればミントへ伝えろ。」. Mint's ruling for Approval Box: /srv/bellteam/bots/bot-137fd092/docs/login-billing/rulings/approval-box.md. Library contract 1.48 sections 10 (local form) and 11 (keyholes), release v0.21.1 (merge 2cf4037). Earlier rulings still in force: content never stored on the server, only devices decrypt (2026-11-21); no Web device (2026-11-21); the Owner is the only user and we may go to the final form at once (2026-11-22).

## 0. Boundary (who owns what)

| Part | Owner | Approval Box uses it through |
|---|---|---|
| Sign-in on every device, the paid check, device keys, start / add / leave / sign out my other devices, the QR exchange, the signed request, the JS server part (check, accept, events) | login-billing (Mint designs, Purika builds). **Approval Box never edits it**; a gap goes to Mint as one requirement message | the parts' public API, pinned at 0.21.1 |
| Storage of entries, keyholes and used numbers (the library's storage interface) | Approval Box server (`packages/server`, SQLite) | implements the interface the JS server part defines |
| Everything from "this request comes from a device of entry E" to the AI: connections and pairing, the peer-channel registry and sessions, push wakes, content, retention | Approval Box and peer-channel (Nayuta) | this page |

## 1. The account

- The account on our server is the library's **entry id E** (a random id the JS server part makes at start; it never changes). It replaces K everywhere on the server: connections, pairings, devices / push tokens, settings, events, the peer-channel mirror and waits.
- The server never learns the provider, subject, purchase or payment state. A request that the JS server part accepts gives `{ entry, key, role }`; nothing else identifies a person.
- Billing is unchanged (App Store and Google Play only, same product and price, no Stripe). The paid check is on each device (section 10). The Owner's account is free through each app's `freeAccounts` (SHA-256 hex of `provider:subject`), filled from his own sign-ins on the new builds.

## 2. Function diagram (target)

| Function | Part | Input -> output | Failure / exit |
|---|---|---|---|
| Device authentication on every route | server: the JS server part's signed-request check, called first in the `/v1` middleware and in `/pc/v1` authenticate | signed request -> `{ entry, key, role }` -> `userId = entry` | refused by the library: its code (401); a key in no entry: "not signed in"; wrong time: the library's retry rule |
| Start, accept an add, leave, sign out my other devices | JS server part, mounted by Approval Box at `/v1/keys/{start,accept,others,leave}` (base `https://approval-box.kitepon.dev/v1`, ahead of the `/v1` device check) | library wire | library codes |
| Edge limits | server, before the library is called | body cap (16 KiB on `/v1/keys/*`), calls per source (existing `rateLimiter`) | 413 / 429 |
| Keyhole events | server handler of the library's events | added: nothing; removed: close that key's peer-channel sockets and drop its push token; entries joined (A into B): move every row of A to B in one transaction; entry emptied: erase every row of E (connections, mirror, push tokens, settings) | a handler failure is logged with a code and never fails the change (library rule); the next use repairs nothing silently: an orphan row of a gone entry is erased by the retention sweep |
| Retention of an entry no device reaches | server sweep (daily, existing scheduler) | `entries_seen.last_used_at` written at each accepted signed request; an entry unused for 90 days -> erase its rows | none (the person signs in again and starts a new entry) |
| Paid check | each app (local form): `ownPurchase` on a parent, `accept` of a parent's reply on a child, `freeAccounts` | -> paid until when, kept on the device | not paid: the app shows "subscribe"; the server never refuses for payment |
| Pairing an AI connection | connector shows `PC1PAIR` (code + connector key fingerprint + secret); **a parent device** scans it and claims it with a signed request; peer-channel 5.4 key binding | -> `connections` row under E, connector key in the registry | a child cannot claim (refused `parent_required`; the way out: scan with the phone) |
| peer-channel device identity | device: its own peer-channel key set (sig + seal, P-256, unchanged); parent: signs a new device's keys into the registry only after the person confirms the 6-digit check code on both screens (section 5) | keys relayed by the server -> codes compared -> parent signs n+1 -> mirror | codes differ or not confirmed: nothing signed; the way out is to add the device again |
| Who an AI sends to | connector | the devices active in E's registry (peer-channel 4.3) whose keyhole is still in E (server says so at `join`) | none listed: `no_device` as today |
| Migration of the Owner's existing data | server, `POST /v1/me/move-to-entry`, empty body | old pass (Authorization: Bearer) and a signed request in the same request -> rows of K move to E -> 200 `{ entry, moved: true }` | no valid pass, or K already moved: 200 `{ entry, moved: false }` (idempotent) |
| Old form beside the new | server | `/auth/v1` and passes stay mounted until the switch date, then removed with the library's server part config | — |

## 3. Data flow (target)

```
Device (any)                      signs every call with its library key
  -> /v1/keys/start | accept | others | leave         (library wire, JS server part)
  -> /v1/*  and  /pc/v1/*                               (signed request -> entry E)
  -> /pc/v1/registry PUT                                (signed request; server binds the pc device key to the keyhole)
  -> push token PUT                                     (signed request -> devices row under E, keyed by the keyhole key)
Parent device <-> new device                            QR + direct Wi-Fi (library, section 10/11), never our server
Parent device <-> connector                             PC1PAIR scanned by the parent, then peer-channel 5.4 binding
Connector  -> /connector/v1, /pc/v1 with its connection token (bound to E)
Server keeps per E: keyholes (library store), connections, pairings, devices/push tokens, settings, peer-channel mirror, entries_seen.last_used_at
Server keeps nothing of: provider, subject, sign-in, purchase, paid state, request or answer content
```

## 4. States

| State | Entered by | Leaves by |
|---|---|---|
| no entry (device signed in, key in no entry) | first sign-in on a parent; a removed keyhole | parent: start -> active; child: a parent's QR -> active |
| active (E has keyholes) | start, accept | keyholes removed one by one; entries joined -> the other E; last keyhole gone -> emptied |
| emptied / unused 90 days | event or sweep | rows erased; final for E |
| old form (pass, K) | today's apps | the migration route moves K -> E; the old part is unmounted on the switch date |

Every refusal above has its way out in the same row; no guard waits for a person except the paid check, whose way out is the store.

## 5. Decisions taken here (mine), and what they cost

- **Our server's word is never enough to make a device** (the Owner, 2026-11-24 14:2x JST: 「致命的なこと言ってる？代償って。」). The library stays at contract 1.48 (the Owner declined an addition: 「サーバーとスマホがやり取りできるなら仕様変更なんていらないじゃん。」), so this is built entirely in peer-channel with its own device keys:
  1. Right after the library's add is taken, the new device uploads its peer-channel public keys in a signed request; the server relays them to the parent that is waiting on the same screen.
  2. Both screens show the same 6-digit check code, derived from SHA-256 of (new device's peer-channel signing key ‖ parent's peer-channel signing key ‖ E). The two devices are side by side at that moment (they just did the QR on the same Wi-Fi).
  3. The person taps "the codes match" on the parent; only then the parent signs n+1 of peer-channel's device-signed registry. A server that swapped a key shows different codes; a server that invents a keyhole has no parent to sign for it.
  4. Connectors accept a device key only from that registry, trusting first the parent key they learned directly at `PC1PAIR` (5.4, bound by the QR's secret).
  Visible cost: one tap comparing six digits when a device is added. A child that later re-joins (lost key, sign-out of others) repeats it.
- **Only a parent approves an AI connection.** Same rule as keyholes; a Linux PC pairs its AI by scanning `PC1PAIR` with the phone.
- **Retention period 90 days** for an entry no device reaches, the same period as the existing unused-pairing expiry.
- **Switch date**: when the Owner's own devices run the new builds and the migration route has moved his data. Then `/auth/v1` and passes are unmounted in one server release.

## 6. Limits (from the library, stated plainly)

- The server does not know who has paid; anyone can start an entry. AI requests to an unpaid entry are delivered, and the apps refuse to show them.
- A phone replaced or lost with no other parent starts a new entry. AI connections are paired again, children show their QR again, and requests not yet answered stay on the PCs.
- A stolen only-parent cannot be cut off by our server; it is erased through Apple or Google, which is not the product's duty.
- A Mac cannot scan a QR; on an Apple account the iPhone or iPad scans.
- An Apple sign-in on Linux or Android needs https://login-billing.kitepon.dev/apple-return registered on Approval Box's own Services ID.

## 7. Tasks

| Part | Change | Task |
|---|---|---|
| server | vendor 0.21.1 tgz; keyhole storage in SQLite; signed request on `/v1`, `/pc/v1`; `/v1/keys/*`; events; edge limits; migration route; drop the paid gate; retention sweep; later unmount `/auth/v1` | switch t03 (Mint reviews before deploy) |
| peer-channel contract and connector | K -> E; a device key enters the registry only by a parent's signature after the check-code confirm (section 5); `join` reports keyhole membership; parent-only claim; `onPassEnded` replaced by the keyhole events; signed request on `/pc/v1` | switch t04 |
| Apple apps (Red Shoes) | 0.21.1 Swift part; start / add / sign-in on every device; signed request instead of the pass; `freeAccounts`; QR scan on iPhone/iPad; migration call once; register apple-return on the Services ID | switch t05 |
| Android and Linux apps (Indivilia) | 0.21.1 Kotlin / .NET parts; the same; Linux is a child (QR) | switch t06 |
| release | store builds, the Owner's devices on the new form, `freeAccounts` filled, old form unmounted, message to Mint | switch t07 |
