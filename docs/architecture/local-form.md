# Approval Box on the login-billing local form: target function, data flow and states

Status: design 1.0, 2026-11-24, Nayuta (chart approval-box/local-form-20261124/t01-design). This is the source of truth for the move; [README.md](README.md), [login-pass.md](login-pass.md) and [peer-channel-adoption.md](peer-channel-adoption.md) keep describing what runs until each step ships, and each step updates them in the same diff.

Inputs (all the Owner's, through Mint, 2026-11-23/24): login-billing contract 1.42 section 10 (no server takes part in sign-in or payment; "課金ってクライアントだけ"); his key model 「スマホ（全ての契約ログインとしての親）の鍵A」「Windows（…認めてもらった子）の鍵B」; "an account is Apple or Google, never both" (「片方の親って何…なぜ混ぜてるの？」); "nothing for login or admission goes through our relay" (「何でそんなに混ぜたがるのか分からない…」); "Approval Box is not responsible for the Apple ID or Google account" (「ここに俺のプロダクトが責任持つの？」); content never stored on the server and only devices decrypt (2026-11-21); no Web device (2026-11-21).

## 1. The account

An account is an **Apple account** or a **Google account**. Nothing in any screen, text or code path compares or links the two.

| | Apple account | Google account |
|---|---|---|
| Parents (check payment themselves, hold key A) | the iPhone, iPad and Mac of that Apple ID | the Android phones and tablets of that Google account |
| Children (own key B, admitted by a parent) | every other device: Android, Windows, Linux | every other device: iPhone, iPad, Mac, Windows, Linux |
| Where A lives | iCloud Keychain, synchronizable (end to end), one access group shared by the iOS/iPadOS app and the Mac app | the app's own storage, wrapped by an Android Keystore key, plus the app's Block Store entry with end-to-end backup |
| A new parent gets A | by itself, through iCloud Keychain; no exchange | from an existing Android parent over the direct path (section 4) |
| A new phone after losing every parent | a new Apple device of the same Apple ID gets A from iCloud Keychain | a new Android restored from the same Google account gets A from Block Store |

Keys:
- **A** (parent key, ECDSA P-256): the only key that signs registry snapshots. Never leaves the parents and their own store backup. Never sent to a child.
- **Device key set** (every device, parent or child: sig + seal, P-256, peer-channel 3.1): made on the device, never leaves it. Used for sessions with the AIs and to authenticate to the relay.
- **Connector key set** (each AI connection): made by the connector on its PC, never leaves it.
- **R** (account routing id) = base64url(SHA-256(A's public key, uncompressed point)). The server knows the account only as R. R names no person, no provider and no subject.

## 2. Function diagram (target)

| Function | Part | Input -> output | Failure / exit |
|---|---|---|---|
| First sign-in and paid check on a parent | app + login-billing local form (`signInLocal`, `ownPurchase`, `purchase`) on the device | Apple: native sign-in and StoreKit; Google: Google sign-in and Play -> paid until when, kept on the device | not paid: the app shows "subscribe" and no requests (it can still sign in and see settings); the Owner's account counts as paid by `freeAccounts` (pending his answer, login-billing t10s0) |
| Account creation | first parent | no A in the platform store -> makes A, its device key, genesis snapshot (signer A, its own device entry) -> uploads to the mirror under R | upload failure: retried; nothing is lost on the device |
| A new parent of the same store account | Apple: iCloud Keychain brings A; Google: direct path from an Android parent | holds A -> signs n+1 adding its own device key -> uploads | Google, no other Android parent present and no Block Store entry: it is a new account (section 6, start over) |
| Admitting a child | the child shows a QR; a parent scans it; direct path (section 4) | child's public keys -> parent's confirm screen -> parent signs n+1 with A -> sealed admission to the child -> the parent uploads n+1 | different networks: "put both on the same Wi-Fi"; local network denied: "allow local network access in Settings" (library messages) |
| Paid check on a child | login-billing `makeRequest` / `accept` with a parent's reply (the same exchange as the admission at first, later alone) | the parent's store proof -> paid until when on the child | period ended: the child asks for a new QR (about once a month) |
| Pairing an AI connection | the connector shows `PC1PAIR` on its PC; a parent scans it; direct path | connector's public keys and connection label -> parent signs n+1 adding the connector entry -> sealed admission to the connector | as for a child; the AI's waiting requests stay in its outbox until a device can answer |
| Relay authentication | server `/pc/v1` | endpoint signs the server's challenge with its device or connector key -> server accepts if the key is active in R's mirror (peer-channel 4.3 rules) | not active: refused (401); a removed key can never come back |
| Asking, deciding, answering | connector outbox, peer-channel sessions (unchanged from peer-channel-adoption.md 2-3) | AI -> outbox -> wake(R) -> device dials -> request -> answer -> AI | unchanged |
| Push wake | server Waker | wake(R) -> APNs/FCM tokens registered by R's devices (each registration signed by the device key) | unchanged |
| Notice of every new keyhole | every device and every connector | each new key in the mirror that this device did not add -> "a device / an AI connection was added" (who, when, platform) | the Owner removes it (parent) or rebuilds (section 6) |
| Removing a device or connection | a parent | signs n+1 with a tombstone -> uploads | a child can remove only itself (self-removal signed with its own device key) |
| Rebuild after a leak of A | a remaining parent | closing snapshot on R (every key tombstoned, A included) -> new A', R' -> children and connections admitted again over the direct path | see section 6 |
| Account deletion | a parent | closing snapshot on R, then a delete request for R signed with A -> the server forgets R's mirror, connections and push tokens | the server also forgets an R unused for 90 days |

## 3. Data flow (target)

```
Parent (Apple ID devices, or Google account Androids)
  holds: A (platform store), device keys, paid-until, on-device history
  -> mirror PUT (signed snapshots only)                       -> server: R's mirror
  -> push token PUT (signed by device key)                    -> server: R's push tokens
  <-> relay sessions with connectors (sealed, peer-channel)    via server /pc/v1 (ciphertext only)
  <-> child / new parent / connector: direct path on the same Wi-Fi (never the server)
        child -> parent:  hello { device public keys, platform, label }       (sealed, QR key)
        parent -> child:  reply { store proof, admission (snapshot version, A's public key, R) [, A for a new Android parent] }
Child (other devices)
  holds: its device keys, paid-until (from a parent's reply), on-device history
  -> relay sessions; push token PUT (signed)
Connector (AI's PC)
  holds: connector keys, outbox (request bodies until decided)
  -> wait.open(R), relay sessions; reads R's mirror before trusting a device key
Server
  keeps: per R: mirror slots (signed snapshots, public keys, platform, dates), push tokens, open waits (memory), diagnostics (no content)
  keeps nothing of: sign-in, provider, subject, purchase, paid state, A, any private key, request or answer content
```

What the server no longer has after the move: K, passes, `/auth/v1`, web sign-in, store notifications, `billing.verify`, the paid gate on `/v1` and `/pc/v1`, `FREE_ACCOUNT_IDS`, the `LB_*` keys, the `/pairing` code and claim, connection tokens (a connector authenticates with its key).

## 4. The direct path (admission and handover of A)

One login-billing local-form exchange (contract section 10, docs/local-form.md of the library). Approval Box adds only product payloads, which the library carries sealed under the QR's one-time key and never reads (requested from Mint 2026-11-24; library work under login-billing t10t):

1. The new device (child, connector, or new Android parent) calls `makeRequest` and shows the QR.
2. A parent scans it and connects directly to the new device on the same network.
3. The new device sends the sealed hello with the product payload `ab1-join` = `{ v, sig_pub, seal_pub, platform, label }` (at most 1 KB).
4. `answer()` hands `ab1-join` to the app before the confirm step. The parent's confirm screen shows what is being admitted: platform, name, the key fingerprint, and for a new Android parent "this phone becomes a parent and will hold the account key".
5. The parent signs n+1 with A (adding the new key), then replies with its store proof and the payload `ab1-admit` = `{ v, R, A_pub, version n+1, snapshot hash }` plus, only for a new Android parent, A itself (at most 4 KB). A new parent that checks its own store gets a reply with no store proof ("joined, not paid" in the library; it checks Play itself).
6. The new device accepts, checks the snapshot it receives from the mirror against the hash in `ab1-admit`, and keeps R, A_pub and its place. The parent uploads n+1.
Nothing of steps 1 to 5 touches our server.

## 5. States of an account

| State | Entered by | Leaves by |
|---|---|---|
| none (device signed in, no A in its store) | first launch | the first parent makes A and the genesis -> active |
| active (R, A on the parents) | genesis, or a rebuild | a keyhole added -> active (notice on every device); leak suspected -> rebuilding; deletion -> closed |
| rebuilding | the Owner chooses "rebuild" on a parent | closing snapshot on R uploaded -> closed (R) + active (R') |
| closed (R) | closing snapshot, or deletion | none; the server forgets R after 90 days without upload or at once on a signed delete |

Exit from every guard: a refused relay authentication ends when a parent adds the key or the device signs in again and is admitted; "not paid" ends when the store answers paid (or a new QR on a child); "same Wi-Fi" ends when both devices are on one network.

## 6. Leak, loss and their limits (stated plainly)

- **Leak of B (a child)**: B can read and answer the requests it receives until a parent removes it. B cannot add anyone. One removal ends it.
- **Leak of A** (a parent is stolen and unlocked, or a store backup is broken): whoever holds A can add devices and read and answer. The only way out is the **rebuild** on a remaining parent: it signs the closing snapshot on R (every key, A included, tombstoned; a removal is never undone, so the thief cannot reopen R), makes A' and R', and the children and AI connections are admitted again over the direct path. Every connector that reads R's closing snapshot refuses every device on R and shows "this account was rebuilt; pair again" on its PC. Window: from the theft until the rebuild. Reading alone adds nothing and shows no notice.
- **The Apple ID or Google account itself** (Find My, removing a device from it) is Apple's, Google's and the person's, like his passwords and passkeys. Approval Box does not guide or wait for it. Limit: a device still on his Apple ID receives the synchronized A as it receives his passwords; a rebuild made while the stolen device is still on the Apple ID sends A' to it too.
- **Every parent lost**: a new device of the same store account gets A back from iCloud Keychain or Block Store and continues. If the store backup is gone, it is a new account (genesis): requests not yet answered stay on the PCs, on-device history is gone, children and AI connections are admitted again.
- **Same network**: admission and a child's paid check need both devices on one local network (the library's limit). An AI connection on a PC outside the home network cannot be paired.
- **Child's period**: a child is paid until the end of the period in the parent's proof (Google: 31 days); then it asks for a new QR.

## 7. What changes where (tasks)

| Part | Change | Task |
|---|---|---|
| peer-channel contract | R instead of K; only A signs snapshots (plus a child's self-removal); relay authentication by key signature; mirror per R; 5.2/5.3/5.4 relay admission replaced by section 4; `onPassEnded`, pass ids and `not_entitled` removed; closing snapshot | t03 (0.6) |
| server | remove the library server part and its routes, the paid gate, pairing codes and connection tokens; `/pc/v1` authenticates by key; push tokens per R; delete by signed request | t04 |
| web | sign-in, pairing and subscription pages go; public pages stay | t05 |
| connector (and BellTeam's module) | connector keys, `PC1PAIR` on the direct path, key authentication | t06 |
| Apple apps | A in iCloud Keychain, parent screens, scanning a child's QR, direct path both roles, notices, rebuild | t07 (Red Shoes) |
| Android and Linux apps | Android: A wrapped + Block Store, parent screens and direct path; Linux: child (QR, paid-until) | t08 (Indivilia) |

Still to come from the library (Mint): the payloads of section 4 (both directions), and a wanting-side part for Node so that the connector can be admitted over the direct path; `freeAccounts` after the Owner's answer.
