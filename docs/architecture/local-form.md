# Approval Box on login-billing version 1 (0.21.1): target function, data flow and states

Status: design 2.0, 2026-11-24, Nayuta (chart approval-box/switch-20261124/t02-design). Replaces design 1.x of this page (withdrawn with contract section 11 drafts 1 to 4). Source of truth for the switch; [README.md](README.md), [login-pass.md](login-pass.md) and [peer-channel-adoption.md](peer-channel-adoption.md) keep describing what runs until each step ships, and each step updates them in the same diff.

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
| Start, accept an add, leave, sign out my other devices | JS server part, mounted by Approval Box under `/keys/v1` | library wire | library codes |
| Edge limits | server, before the library is called | body cap (16 KiB on `/keys/v1`), calls per source (existing `rateLimiter`) | 413 / 429 |
| Keyhole events | server handler of the library's events | added: nothing; removed: close that key's peer-channel sockets and drop its push token; entries joined (A into B): move every row of A to B in one transaction; entry emptied: erase every row of E (connections, mirror, push tokens, settings) | a handler failure is logged with a code and never fails the change (library rule); the next use repairs nothing silently: an orphan row of a gone entry is erased by the retention sweep |
| Retention of an entry no device reaches | server sweep (daily, existing scheduler) | `entries_seen.last_used_at` written at each accepted signed request; an entry unused for 90 days -> erase its rows | none (the person signs in again and starts a new entry) |
| Paid check | each app (local form): `ownPurchase` on a parent, `accept` of a parent's reply on a child, `freeAccounts` | -> paid until when, kept on the device | not paid: the app shows "subscribe"; the server never refuses for payment |
| Pairing an AI connection | connector shows `PC1PAIR` (code + connector key fingerprint + secret); **a parent device** scans it and claims it with a signed request; peer-channel 5.4 key binding | -> `connections` row under E, connector key in the registry | a child cannot claim (refused `parent_required`; the way out: scan with the phone) |
| peer-channel device identity | device: its own peer-channel key set (sig + seal, P-256, unchanged); server: binds each registry device key to the keyhole that uploaded it | registry snapshot upload by a signed request -> accepted only if the signer key's binding is a keyhole of E now | key of a removed keyhole: refused, and the mirror drops its slots |
| Who an AI sends to | connector | the devices active in E's registry (peer-channel 4.3) whose keyhole is still in E (server says so at `join`) | none listed: `no_device` as today |
| Migration of the Owner's existing data | server, one route used once per device | a request carrying both the old pass (K) and a signed request (E) -> rows of K move to E; the old pass is then ended | no old pass: nothing to move (a new account) |
| Old form beside the new | server | `/auth/v1` and passes stay mounted until the switch date, then removed with the library's server part config | — |

## 3. Data flow (target)

```
Device (any)                      signs every call with its library key
  -> /keys/v1 start | add | leave | sign-out-others     (library wire, JS server part)
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

- **Connectors trust our server's keyhole list** for which peer-channel device keys belong to E, and peer-channel keeps its device-signed registry for everything else (removals, forks, notices). Why: the library keeps no signed adds at the server (11.3), and a second QR per device to run peer-channel's own admission would double what the Owner does. Cost, stated plainly: a fully compromised running server could add a keyhole and a device key of its own and receive new requests until a device sees the "a device was added" notice and removes it. A leak of the stored data still reveals no content (nothing is stored).
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
| server | vendor 0.21.1 tgz; keyhole storage in SQLite; signed request on `/v1`, `/pc/v1`; `/keys/v1`; events; edge limits; migration route; drop the paid gate; retention sweep; later unmount `/auth/v1` | switch t03 (Mint reviews before deploy) |
| peer-channel contract and connector | K -> E; registry device key bound to a keyhole; `join` reports keyhole membership; parent-only claim; `onPassEnded` replaced by the keyhole events | switch t04 |
| Apple apps (Red Shoes) | 0.21.1 Swift part; start / add / sign-in on every device; signed request instead of the pass; `freeAccounts`; QR scan on iPhone/iPad; migration call once; register apple-return on the Services ID | switch t05 |
| Android and Linux apps (Indivilia) | 0.21.1 Kotlin / .NET parts; the same; Linux is a child (QR) | switch t06 |
| release | store builds, the Owner's devices on the new form, `freeAccounts` filled, old form unmounted, message to Mint | switch t07 |
