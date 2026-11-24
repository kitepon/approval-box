# Approval Box on the login-billing local form: target function, data flow and states

Status: design 1.1, 2026-11-24, Nayuta (chart approval-box/local-form-20261124/t01-design). This is the source of truth for the move; [README.md](README.md), [login-pass.md](login-pass.md) and [peer-channel-adoption.md](peer-channel-adoption.md) keep describing what runs until each step ships, and each step updates them in the same diff.

Inputs (all the Owner's, through Mint, 2026-11-23/24): login-billing contract 1.42 section 10 (no server takes part in sign-in or payment; "課金ってクライアントだけ"); his key model 「スマホ（全ての契約ログインとしての親）の鍵A」「Windows（…認めてもらった子）の鍵B」; "an account is Apple or Google, never both" (「片方の親って何…なぜ混ぜてるの？」); "nothing for login or admission goes through our relay" (「何でそんなに混ぜたがるのか分からない…」); "Approval Box is not responsible for the Apple ID or Google account" (「ここに俺のプロダクトが責任持つの？」); content never stored on the server and only devices decrypt (2026-11-21); no Web device (2026-11-21).

**Scope line (2026-11-24 12:0x JST, the Owner: 「俺ずっっっっとログインと課金の話しかしてないんだけど。…そこからAIに繋ぐのは、お前の責任範囲ではないだろ。」):** the library (Mint designs, Purika builds; login-billing contract section 11, "Keyholes") ends where our server knows "this device is signed in to this account": each device's own key, a parent signing a child's keyhole at the QR, the server holding keyholes only, a device proving itself with its key. Everything from there to the AI is Approval Box's and peer-channel's: connectors and their pairing, the content, whom an AI sends to, and whether connectors trust our server's keyhole list or check the signed statements themselves. Approval Box's requirements on section 11 (stable entry id, keyhole events, a one-shot signed request) went to Mint on 2026-11-24. Section 11 is a draft; nothing is built on it until it is reviewed.

## 1. The account

**Withdrawn 2026-11-24 (the Owner rejected the base of login-billing section 11: 「iCloudで揃えろなんて言ってない」).** No key is shared through iCloud Keychain or Block Store, and no server hands out the list. Mint is rewriting section 11: every device makes its own key and it never leaves the device; each parent is a root of its own and only its key adds a keyhole; the list goes device to device; a server only holds keyholes. Everything on this page about A, parents, admission, rebuild and the list (rows marked **[family]**, sections 4 to 6) is void until the new section 11 is settled; consumers are drawn again from it. Still valid: an account is Apple or Google and never both; the server keeps no sign-in, provider, subject, purchase or paid state; the web pages and the connector's use of the family follow.

## 2. Function diagram (target)

| Function | Part | Input -> output | Failure / exit |
|---|---|---|---|
| First sign-in and paid check on a parent | app + login-billing local form (`signInLocal`, `ownPurchase`, `purchase`) on the device | Apple: native sign-in and StoreKit; Google: Google sign-in and Play -> paid until when, kept on the device | not paid: the app shows "subscribe" and no requests (it can still sign in and see settings); the Owner's account counts as paid by `freeAccounts` (pending his answer, login-billing t10s0) |
| Account creation **[family]** | first parent | no A in the platform store -> makes A, its device key, genesis snapshot (signer A, its own device entry) -> uploads to the mirror under R | upload failure: retried; nothing is lost on the device |
| A new parent of the same store account **[family]** | Apple: iCloud Keychain brings A; Google: direct path from an Android parent | holds A -> signs n+1 adding its own device key -> uploads | Google, no other Android parent present and no Block Store entry: it is a new account (section 6, start over) |
| Admitting a child **[family]** | the child shows a QR; a parent scans it; direct path (section 4) | child's public keys -> parent's confirm screen -> parent signs n+1 with A -> sealed admission to the child -> the parent uploads n+1 | different networks: "put both on the same Wi-Fi"; local network denied: "allow local network access in Settings" (library messages) |
| Paid check on a child | login-billing `makeRequest` / `accept` with a parent's reply (the same exchange as the admission at first, later alone) | the parent's store proof -> paid until when on the child | period ended: the child asks for a new QR (about once a month) |
| Pairing an AI connection **[family]**, the connector as a member | the connector shows its QR on its PC; a parent scans it; direct path | connector's public keys and connection label -> parent signs n+1 adding the connector entry -> sealed admission to the connector | as for a child; the AI's waiting requests stay in its outbox until a device can answer |
| Relay authentication | server `/pc/v1` | endpoint signs the server's challenge with its device or connector key -> server accepts if the key is active in R's mirror (peer-channel 4.3 rules) | not active: refused (401); a removed key can never come back |
| Asking, deciding, answering | connector outbox, peer-channel sessions (unchanged from peer-channel-adoption.md 2-3) | AI -> outbox -> wake(R) -> device dials -> request -> answer -> AI | unchanged |
| Push wake | server Waker | wake(R) -> APNs/FCM tokens registered by R's devices (each registration signed by the device key) | unchanged |
| Notice of every new keyhole | every device and every connector | each new key in the mirror that this device did not add -> "a device / an AI connection was added" (who, when, platform) | the Owner removes it (parent) or rebuilds (section 6) |
| Removing a device or connection **[family]** | a parent | signs n+1 with a tombstone -> uploads | a child can remove only itself (self-removal signed with its own device key) |
| Rebuild after a leak of A **[family]** | a remaining parent | closing snapshot on R (every key tombstoned, A included) -> new A', R' -> children and connections admitted again over the direct path | see section 6 |
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

## 4. The direct path (admission and handover of A) **[family]**

Login-billing contract section 11 (admit, parentJoin, remove, leave, rebuild, verify). Approval Box supplies only its confirm screen and notice texts, uploads the signed family list the part exports, and keeps nothing of the exchange. Nothing of the admission touches our server.

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
| device family | keys A/B, keyhole list, direct-path admission (devices and AI connections, a Node part for the connector), rebuild | login-billing t10x (Purika), via approval-box t02 |
| peer-channel contract | R instead of K; its own registry (section 4) and admission (5.2-5.4) replaced by the family list it consumes; relay authentication by key signature against the keyhole list; `onPassEnded`, pass ids and `not_entitled` removed | t03 (0.6), after section 11 is built |
| server | remove the library server part and its routes, the paid gate, pairing codes and connection tokens; `/pc/v1` authenticates by key; mirror, waits and push tokens per R; delete by signed request | t04 |
| web | sign-in, pairing and subscription pages go; public pages stay | t05 |
| connector (and BellTeam's module) | joins as a family member, key authentication | t06 |
| Apple apps | consume the family; screens for parent, scan, notices, rebuild | t07 (Red Shoes) |
| Android and Linux apps | consume the family; Android parent screens, Linux child | t08 (Indivilia) |

Still from the library (Mint): the device family (t10x); `freeAccounts` after the Owner's answer.
