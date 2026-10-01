# Approval Box API（アプリ・Web版向け） v0.14

v0.10: 製品名を Approval Box に決定（契約の中身は v0.9 と同じ。表示名・文言の「Approval Box」を置き換える）。

2026-10-01 ラプラス起案。iPhone・Androidアプリ（ベル）とWeb版（ラプラス）が同じAPIを使う。正本はこのファイルで、変更はラプラスが行いベルへ知らせる。

- 基点: `https://<host>/v1`。検証用は `https://approval-box.kitepon.dev/v1`（2026-10-01 公開。BILLING=off、ログインは開発用sessionだけ）
- アプリは公式サーバー専用。接続先は焼き込み（検証用・本番の切り替えはビルド設定だけ）。利用者が接続先を変える設定は作らない。
- 本文はJSON（UTF-8）、時刻はISO 8601（UTC、例 `2026-10-01T03:00:00Z`）。
- 未知のフィールドは無視すること（サーバーは後方互換でフィールドを足す）。enumに未知の値が来たら「その他」として表示する。

## 認証

- 全リクエストに `Authorization: Bearer <session>`。
- session の取得:
  - iOS・Web: `POST /auth/apple` `{ identity_token }`
  - Android・Web: `POST /auth/google` `{ id_token }`（Sign in with Google）
  - 応答 `{ session, expires_at, user: { id } }`。
  - ログインは「Googleでログイン」と「Appleでログイン」の2本（クオの裁定）。Web版・iPhone・Androidのどれにも並べる。1つのアカウントは、GoogleかAppleのどちらか1つのIDに結ぶ。両方を使えば別のアカウントになる。IDの追加・統合は無い。
  - `POST /auth/apple` `{ identity_token, nonce? }`: Appleの公開鍵で確かめる（aud はアプリの Bundle ID `dev.kitepon.approvalbox`、Web版は Services ID）。
  - `POST /auth/google` `{ id_token, nonce? }`: Googleの公開鍵で確かめる（aud は Web・iOS・Android の OAuthクライアントID）。
  - nonce は送った時だけ照合する（生の値・SHA-256のどちらでもよい）。初めてのIDなら新しいアカウントを作る。
  - **IDに結ばれていない既存アカウント**（ログイン用のURL・コードで作ったもの）だけは、ログイン済みのsession（Bearer）付きで `/auth/apple`・`/auth/google` を呼ぶと、最初の1回に限りそのIDを結べる。既にIDがあるアカウントなら 409 `conflict`。そのIDが別のアカウントで使われていても 409 `conflict`。
  - `/me` の `login` は `"apple" | "google" | null`。null のアカウントにだけ「GoogleかAppleを結ぶ」を出す。
  - サーバーが受け先を設定していなければ 400 `validation_failed`（自分で立てたサーバー）。
- 検証期間は、ラプラスが発行する開発用sessionをそのまま使ってよい（ログイン画面は後から差し込める作りにする）。
- 401 `unauthorized` を受けたらsessionを捨ててログインへ戻す。
- `POST /auth/logout`（Bearer必須）→ `{ ok: true }`。そのsessionを失効させる。端末の通知を止めるなら、先に `DELETE /devices/{id}`。
- `POST /auth/link` `{ code }`（Bearer不要）→ `{ session, expires_at }`。コードでのログイン。codeは2種類:
  - `kll_…` 一度だけ使えるログインのコード。15分で切れる。サーバーの管理者が `admin login-link <user_id|new>` で出す。
  - `kpl_…` 利用者ごとに固定のログインのコード。何度でも使える。Web版の「設定 → ログイン用のURL」（`POST /me/personal-link`）か `admin personal-link <user_id>` で出す。作り直すと前のコードは 401。
  - どちらも `https://<host>/login#code=<code>` のURLの形で渡されることが多い。アプリの入力欄は、URLを丸ごと貼っても、コードだけでも受ける（`#code=` の後ろを取り出す。前後の空白は捨てる）。401 `unauthorized` は「使えないコード」として出す。
  - App Reviewのデモアカウントには `kpl_` のコードを使う。
- 利用者ごとに固定のログインURL（Bearer必須）: `GET /me/personal-link` → `{ exists, created_at?, last_used_at? }`（URLは返さない）、`POST /me/personal-link` → `{ url, created_at }`（URLは作った時に一度だけ返す。前のURLは使えなくなる）、`DELETE /me/personal-link` → `{ ok: true }`。

## 決裁

```
Decision {
  id: "K-1234",
  title: string,                 // 120字まで
  context: string,               // プレーンテキスト。20,000字まで。Markdownとして描画しない。リンクは押した時に確認を挟む
  options: [{ id: string, label: string }],   // 2〜6
  recommendation?: option_id,    // AIの推奨
  urgency: "low" | "normal" | "high",
  deadline?: time,
  source: {
    client: "claude-code" | "codex" | "cursor" | "grok" | "claude.ai" | "chatgpt" | "other",
    session_label: string,       // どのセッションの話か。一覧に必ず出す
    via: "connector" | "remote"
  },
  status: "pending" | "held" | "answered" | "cancelled",
  answer?: { option_id?: string, text?: string, answered_at: time },
  delivery?: "waiting" | "delivered" | "unknown" | "fetched",
  resume_phrase: string,         // 例「Approval Box K-1234 の答えを確認して続けて」
  created_at: time,
  updated_at: time,
  version: int,                  // 更新のたびに増える（AIの修正でも増える）
  cancel_reason?: string,        // AIが取り下げた理由（status=cancelled の時）
  distinct_reason?: string,      // 似た申請があるのにAIが別件として出した理由
  history: [{
    at: time,
    kind: "created" | "amended" | "held" | "unheld" | "answered" | "cancelled",
    by: "ai" | "user",
    note?: string,               // amended: AIが書いた修正の理由。cancelled: 取り下げの理由
    fields?: string[]            // amended: 直した項目名（"title" "context" "options" "recommendation" "urgency" "deadline"）
  }]
}
```

- 添付: v1では無し。背景は文字だけ。将来 `attachments` を足す時はフィールド追加で行う。
- 差戻し: 専用の操作は持たない。選択肢を選ばず `text` だけで答えれば、それが差戻し・指示し直しとしてAIへ届く。
- `delivery`（answered の時だけ意味を持つ）:
  - `waiting` まだAIへ渡していない
  - `delivered` AIのセッションへ割り込み・新しいターンとして渡した
  - `unknown` 渡したか確かめられなかった。自動で送り直さない。画面に「届いたか不明」と出し、`resume_phrase` のコピーを勧める
  - `fetched` リモートMCPのAIが `get_decision` で取った
  - via=remote の決裁は、利用者がチャットへ戻るまで `waiting` のまま。これは異常ではない。

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/decisions?status=pending,held&limit=50&cursor=…` | 一覧 `{ items: Decision[], next_cursor?: string }` |
| GET | `/decisions/{id}` | 1件 |
| POST | `/decisions/{id}/answer` | `{ option_id?, text?, version }`。option_idかtextのどちらか必須。versionは必須。pending・heldの時だけ。応答は更新後のDecision |
| POST | `/decisions/{id}/hold` | 保留にする。応答はDecision |
| POST | `/decisions/{id}/unhold` | 保留を戻す。応答はDecision |
| GET | `/events` | SSE（下記） |

- 並び順: pending・held は 急ぎ度（high→low）、期限の近い順、古い順。answered・cancelled は updated_at の新しい順。
- 書き込み（answer・hold・unhold）には `Idempotency-Key: <UUID>` を付ける。通信が切れて送り直しても二重に答えない。
- answer の `version` がサーバー側と違えば409 `conflict`（AIが内容を直した、Webで先に答えた等）。古い内容のまま答えさせないため、versionは必須。応答の `error.decision` に最新のDecisionが入るので、それで画面を差し替える。
- 取り下げ（cancelled）と修正（amended）はAI側だけが行う。アプリからは行わない。
- AIの修正: 同じ申請が直される。history の最後が `amended` なら、カードと決裁画面に「修正あり」と note・直した項目を出す。
- AIの取り下げ: 一覧から消え、既決側に `cancel_reason` 付きで残る。
- 決裁画面を開いている間に `decision.updated` が来たら、取り直して差し替え、「AIが内容を直した」「AIが取り下げた」と知らせる。

## 更新の知らせ

- 背景にいる時: プッシュ通知（APNs・FCM）。
  - 表示文は件名だけ（背景は出さない）。
  - payload: `{ type: "decision.created" | "decision.updated", change?: "amended" | "cancelled" | "answered" | "delivery", decision_id, version }`。開いたら `/decisions/{id}` を取る。
  - 鳴らすのは created（件名）と amended（「修正: 件名」）だけ。cancelled・answered・delivery は音なしの更新（バッジと一覧の更新だけ）。
  - 表示文はサーバーが組み立てて渡す（`title`。created は件名、amended は「修正: 件名」）。音なしの更新には `title` を入れない。
  - APNs: 鳴らす時は `aps.alert.title` と `aps.sound`、`aps.badge`。音なしは `aps.content-available: 1` と `aps.badge` だけ。独自のキー（type・change・decision_id・version）は aps の外に置く。
  - FCM: 全部データメッセージ（`notification` ブロックは使わない）。`data` の値は全部文字列で `{ type, change?, decision_id, version, badge, title? }`。`title` がある時だけアプリが通知を出す。鳴らす時は priority=high、音なしは normal。Androidの通知チャンネルは「新しい申請」「修正」の2つ。
  - アプリのバッジ: pending の件数。payload の `badge` に入れる。Androidのランチャーバッジは表示中の通知に結び付くため、音なしの更新だけでは数を変えられない（OSの制約。アプリ内の件数と、既存の通知の件数・削除は更新する）。
- 前面にいる時: 前面へ戻った時に一覧を取り直す。即時に反映したい場合は `/events` を張ってよい。
- `/events`（SSE）: `event: decision.created | decision.updated | decision.deleted | setup.updated`、`data: { decision_id, version, change? }`。`Last-Event-ID` で再開できる。切れたら1秒から最大60秒まで間隔を延ばして張り直す。

## 接続（接続画面）

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/connections` | 接続済みの端末・クライアント `[{ id, kind: "device" \| "remote", label, os?, clients: string[], last_seen_at }]` |
| DELETE | `/connections/{id}` | 端末・リモート接続を外す |
| POST | `/tokens` | `{ label }` → `{ id, token, setup_command }`。tokenは1回だけ返す |
| GET | `/tokens` | 発行済み `[{ id, label, created_at, last_used_at }]`（tokenの値は返さない） |
| DELETE | `/tokens/{id}` | 失効 |
| GET | `/onboarding` | クライアント別の登録手順 `[{ client, title, steps: [{ text, copy?: string }] }]`。文面はアプリに焼き込まない |


## セットアップ確認

確認が済むまで購入の画面を出さない（クオの裁定）。

- `/me` の `setup`:
```
setup: {
  verified: bool,                // 一度でも確認済みのAIがあった（一度trueになれば戻らない）
  checks: [{
    connection_id, client,       // 例 "claude-code"
    os?: "macos" | "windows" | "linux",
    status: "untested" | "waiting_answer" | "waiting_ai" | "passed" | "failed",
    decision_id?,                // 試しの申請
    passed_at?,                  // 最後に通った日時（後のテストで失敗しても残る）
    tested_at?,                  // 最後にテストした日時。status はこのテストの状態
    failed_step?: "request" | "notify" | "delivery", detail?
  }]
}
```
- 流れ: 利用者がAIに「Approval Boxのsetup_testを実行して」と言う → AIが `setup_test` を呼ぶ → 試しの申請が届く（`source.test: true`、check は `waiting_answer`） → 利用者が答える（`waiting_ai`） → AIが届いた確認コードを返す（`passed`）。
- 試しの申請はふつうの申請と同じ画面で答える。カードに「テスト」の印を付ける。
- check が変わるたびに `/events` に `setup.updated`、プッシュは音なしで `{ type: "setup.updated" }` を送る。
- 購入の画面: `setup.verified=false` なら購入ボタンを出さず、セットアップの案内と check の一覧を出す。`true` でも `passed` でない check があれば、「Cursor はまだ確認できていない」のように並べて出す。
- `/billing/*` は確認前なら409 `setup_not_verified`。
- 接続テストは課金の後もいつでも使える。「接続」画面にAIごとの状態（status・tested_at）と「テストする」を置く。押したら「AIに『Approval Boxのsetup_testを実行して』と言ってください」を出し、`setup.updated` で結果を待つ。アプリからAIを起こすAPIは無い（テストの始まりはAIの側）。
- 契約後のテストで failed になっても、契約と `verified` は変わらない。直し方を出すだけ。

## ペアリング（端末を追加）

利用者の流れ: PCで `npx -y approval-box@latest setup` → 画面にQRと8文字のコード → アプリの「端末を追加」で読む・打つ → PC側に接続トークンが届く。

| メソッド | パス | 呼ぶ側 | 内容 |
|---|---|---|---|
| POST | `/pairing` | コネクタ（認証なし） | `{ device_name, os, clients: string[] }` → `{ pairing_id, code: "ABCD-EFGH", qr_url, poll_secret, expires_at }`（10分で失効） |
| GET | `/pairing/{pairing_id}` | コネクタ | `X-Poll-Secret` 付き。結ばれるまで待つ（長いポーリング、最大30秒で返る）。結ばれたら `{ status: "claimed", token }` を1回だけ返す |
| GET | `/pairing/lookup?code=ABCD-EFGH` | アプリ | 確認画面用 `{ pairing_id, device_name, os, clients, expires_at }` |
| POST | `/pairing/{pairing_id}/claim` | アプリ | 利用者が「この端末を追加」を押した時。自分のアカウントに結ぶ → `{ connection_id }` |
| POST | `/pairing/{pairing_id}/reject` | アプリ | 「心当たりがない」を押した時 |

- QRの中身は `qr_url`（`https://<host>/pair?c=ABCD-EFGH`）。アプリはこのURLを読んだらコードを取り出して lookup する。アプリが入っていない端末のカメラで読んだ時は、Web版のペアリング画面が開く。
- 確認画面には端末名・OS・使うAIを出し、「この端末を追加」「心当たりがない」の2つを置く（他人のコードを打たされる詐欺への備え）。
- コードは大文字英字と数字（紛らわしい0・O・1・Iは使わない）。打つ時はハイフンと大小文字を無視する。
- 結ばれた端末は `/connections` に出る。失効は `DELETE /connections/{id}`（その端末のトークンも無効になる）。

## 端末と通知

| メソッド | パス | 内容 |
|---|---|---|
| POST | `/devices` | `{ platform: "ios" \| "android" \| "web", apns_token?, apns_env?: "sandbox" \| "production", fcm_token?, web_push_subscription? }` → `{ id }` |
| DELETE | `/devices/{id}` | 解除（ログアウト時に呼ぶ） |

## アカウントと課金

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/me` | `{ user_id (UUID、小文字), login: "apple" \| "google" \| null, setup, plan: "trial" \| "active" \| "expired", expires_at?, store?: "app_store" \| "google_play" \| "web" }` |
| DELETE | `/me` | アカウントと全データの削除（App Store・Google Playの審査で必須） |
| DELETE | `/decisions?status=answered,cancelled` | 設定の「データ削除」。既決（answered・cancelled）だけを消す → `{ deleted: int }`。pending・heldは消さない（AIが答えを待っているため）。アカウント・接続・端末は残る |
| GET | `/me/settings` | `{ retention_days: 7 \| 30 \| 90 \| 365 }`（既定30。既決をこの日数で自動削除） |
| PATCH | `/me/settings` | `{ retention_days }` → 更新後の settings |

| POST | `/billing/appstore/verify` | iOS: 購入直後に `{ jws }` を送る。jws は StoreKit 2 の `jwsRepresentation`（署名付きtransaction）そのまま → 更新後の `/me` |
| POST | `/billing/play/verify` | Android: 購入直後に `{ product_id, purchase_token }` を送る → 更新後の `/me`。承認（acknowledge）はサーバーが行う |
| POST | `/billing/stripe/checkout` | Web: → `{ url }`（Stripe Checkoutへ移る） |
| POST | `/billing/stripe/portal` | Web: → `{ url }`（解約・カード変更） |
| POST | `/appstore/notifications`・`/play/notifications`・`/stripe/webhook` | サーバー間。アプリは呼ばない |

- 契約はアカウントに1つ。`/me` の `store` が契約した窓口を表す。`plan=active` で別の窓口の購入画面は出さない（「App Storeで契約中」のように出す）。
- 購入に使う `appAccountToken`（iOS）・`obfuscatedAccountId`（Android）には `/me` の `user_id` を入れる。
- 決済の検証はサーバーが行う。検証の窓口ができるまで `/me` は `trial` を返す。

## エラー

```
{ "error": { "code": string, "message": string, "decision"?: Decision } }
```

| HTTP | code | アプリの扱い |
|---|---|---|
| 400 | `validation_failed` | 入力の誤り。message を出す |
| 401 | `unauthorized` | ログインへ戻す |
| 402 | `subscription_expired` | 契約画面へ |
| 404 | `not_found` | 一覧から消す |
| 409 | `setup_not_verified` | セットアップ確認の画面へ |
| 409 | `conflict` | 既に答え済み・取り下げ済み・version違い。`error.decision` で差し替える |
| 429 | `rate_limited` | `Retry-After` 秒待つ |
| 5xx | `internal` | 時間を置いて送り直す（Idempotency-Key は同じものを使う） |

message は利用者にそのまま見せてよい日本語の文。

## 例

```json
{
  "id": "K-1234",
  "title": "DBの移行をいま実行してよいか",
  "context": "本番DBのusersテーブルに列を1つ足す。停止は約30秒。",
  "options": [{ "id": "a", "label": "いま実行" }, { "id": "b", "label": "夜間に回す" }],
  "recommendation": "b",
  "urgency": "high",
  "deadline": "2026-10-01T09:00:00Z",
  "source": { "client": "claude-code", "session_label": "approval-box / server", "via": "connector" },
  "status": "pending",
  "resume_phrase": "Approval Box K-1234 の答えを確認して続けて",
  "created_at": "2026-10-01T03:00:00Z",
  "updated_at": "2026-10-01T03:00:00Z",
  "version": 1
}
```

## 未決

- 無し（無料体験の形は設計側の未決。決まったら `/me` に反映する）

## 変更履歴

- v0.14 2026-10-01 クオの裁定: ログインはGoogleとAppleの2本、1アカウント1ID、両方使えば別アカウント。`POST /auth/google` を実装。Bearer付きで結べるのはIDの無い既存アカウントだけ（最初の1回）。`/me` に `login`。
- v0.13 2026-10-01 ベルの依頼で、コードでのログイン（`kll_`・`kpl_`）、URL/コードの入力欄の扱い、`/me/personal-link` を明記（実装は既にある）。
- v0.12 2026-10-01 `POST /auth/apple` を実装。Bearer付きで呼ぶと既存アカウントへ結ぶ（409 `conflict` は別アカウントに結ばれている時）。`/auth/google` はまだ。
- v0.11 2026-10-01 ベルの指摘で `GET /onboarding`・`POST/GET/DELETE /tokens`・`POST/DELETE /devices` を実装（契約は変えていない）。`/v1/` と `/connector/v1/` の知らないpathはWeb版のHTMLでなくJSONの404 `not_found` を返す。`POST /auth/logout`・`POST /auth/link` を明記。tokensの `setup_command` は `npx -y approval-box@latest setup --server <URL> --token <token>`。`/devices` は登録・解除だけで、通知の送信はまだ。
- v0.1 2026-10-01 起案。
- v0.9 2026-10-01 クオの裁定: 接続テストを課金後もいつでも使えるようにした。check に tested_at、verified は一度trueになれば戻らない。
- v0.8 2026-10-01 クオの裁定: セットアップ確認を追加。/me に setup、`setup_not_verified`、イベント `setup.updated`。/onboarding/test は廃止。
- v0.7 2026-10-01 user_id はUUID。通知の表示文 title をサーバーが組み立て、APNs・FCMの形を確定（FCMはデータメッセージのみ）。
- v0.6 2026-10-01 クオの裁定: Web版はStripe。Android・WebのログインにGoogleを追加。課金の検証窓口（App Store・Google Play・Stripe）を確定。
- v0.5 2026-10-01 ペアリング（端末を追加）を追加。/connections に端末単位の項目と削除を追加。アプリは公式サーバー専用と明記。
- v0.4 2026-10-01 クオの裁定で、AIが自分の申請を一覧・修正・取り下げできるようにした。Decision に history・cancel_reason・distinct_reason を追加。answer の version を必須に。通知に change を追加。
- v0.3 2026-10-01 設定の「データ削除」を、DELETE /me（アカウント削除）とは別の操作として確定。既決だけを消す。保存日数の設定を追加。
- v0.2 2026-10-01 ベルの問い合わせを受けて、Android、エラー、並び順、冪等キー、version、更新の知らせ、添付なし、差戻しの扱いを確定。
