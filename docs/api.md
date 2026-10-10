# Approval Box API（アプリ・Web版向け） v0.28

v0.28（2026-10-10）: 項目は変えていない。①想定外の取消（`cancelled`）も、送信元が再試行・再接続での回復を観測して `info`・`recovered` と `handling: retry_available | reconnecting` を付けた時は参考診断に留める。②サーバーは停止の合図（SIGTERM）で `GET /v1/events` と `GET /connector/v1/stream` を正しく閉じる。入れ替えの間に切断でなく正常終了が届くので、利用側は今までどおり再接続する。入れ替えの数秒は手前のプロキシが接続を待たせ、502を返さない。詳細は[diagnostics.md](diagnostics.md)。

v0.26（2026-10-07）: 通信診断の任意handlingとimpact_assessmentを正式定義。根拠付きの参考診断は原本・受領記録を保持し新規修理groupに昇格しない。既存未解決を自動解決せず、送信元の重大度・評価根拠を尊重する。詳細は[diagnostics.md](diagnostics.md)。

v0.25（2026-10-07）: 診断原本と独立した管理者の調査注記 `investigation` を追加。LAN管理PATCHと既存管理GETの任意項目だけを拡張。診断POST・fingerprint・回数・状態は不変。詳細は [diagnostics.md](diagnostics.md)。

v0.24（2026-10-06）: 診断に任意の固定enum `diagnostic_log.trigger` を追加。業務処理の開始入口を表し、fingerprintから除外。詳細は [diagnostics.md](diagnostics.md)。

v0.10: 製品名を Approval Box に決定（契約の中身は v0.9 と同じ。表示名・文言の「Approval Box」を置き換える）。

2026-10-01 ラプラス起案。iPhone・Androidアプリ（ベル）とWeb版が同じAPIを使う。サーバーAPIの正本はこのファイルで、現在の担当はナユタ（2026-10-02引継ぎ）。変更を利用側の担当へ知らせる。

- 基点: `https://<host>/v1`。公式サーバーは `https://approval-box.kitepon.dev/v1`（2026-10-01 公開。今はこの1台だけで、本番用は別に立てていない。2026-10-02 から BILLING=store、ログインはAppleとGoogle）
- アプリは公式サーバー専用。接続先は焼き込み（検証用・本番の切り替えはビルド設定だけ）。利用者が接続先を変える設定は作らない。
- 本文はJSON（UTF-8）、時刻はISO 8601（UTC、例 `2026-10-01T03:00:00Z`）。
- 未知のフィールドは無視すること（サーバーは後方互換でフィールドを足す）。enumに未知の値が来たら「その他」として表示する。

## 認証

- 全リクエストに `Authorization: Bearer <session>`。
- session の取得:
  - iOS・Web: `POST /auth/apple` `{ identity_token }`
  - Android・Web: `POST /auth/google` `{ id_token }`（Sign in with Google）
  - 応答 `{ session, expires_at, user: { id } }`。
  - ログインは「Googleでログイン」と「Appleでログイン」だけ（クオの裁定）。Web版・iPhone・Androidのどれにも並べる。ログイン用のURL・コード・パスワードは無い。
  - 同じIDなら、どの画面から入っても同じアカウント。違うIDなら別のアカウント（GoogleとAppleを別々に使えば別アカウント）。IDを結ぶ・外す・アカウントをまとめる操作は無い。Bearerを付けて呼んでも結ばない。
  - `POST /auth/apple` `{ identity_token, nonce? }`: Appleの公開鍵で確かめる（aud はアプリの Bundle ID `dev.kitepon.approvalbox`、Web版は Services ID `dev.kitepon.approvalbox.web`）。
  - `POST /auth/google` `{ id_token, nonce? }`: Googleの公開鍵で確かめる（aud は Web・iOS・Android の OAuthクライアントID）。
  - nonce は送った時だけ照合する（生の値・SHA-256のどちらでもよい）。初めてのIDなら新しいアカウントを作る。
  - `GET /auth/config`（Bearer不要）→ `{ google_client_id?, apple_services_id? }`。Web版のボタン用。無いものはボタンを出さない。
  - `/me` の `login` は `"apple" | "google" | null`（null は廃止した入口で作った古いアカウント）。
  - サーバーが受け先を設定していなければ 400 `validation_failed`（自分で立てたサーバー）。
  - **ブラウザで始めるAppleのログイン（AndroidのCustom Tabs）**。BearerもsessionもURLに載せない。
    1. アプリが `code_verifier`（43〜128文字のランダムなbase64url）を作り、`code_challenge = base64url(SHA-256(code_verifier))` を求める。
    2. `POST /auth/apple/web/start` `{ code_challenge, code_challenge_method: "S256" }` → `{ authorization_url, state, expires_at }`（10分）。
    3. アプリは `authorization_url` をCustom Tabsで開き、`state` を覚えておく。
    4. Appleは結果を `https://<host>/auth/apple/callback` へform_postする。サーバーはid_token（aud はServices ID、nonce はサーバーが入れた値）を確かめ、`approvalbox://auth/apple?code=kll_…&state=…` へ303で戻す。失敗は `approvalbox://auth/apple?error=<code>&state=…`。`<code>` は `cancelled`（利用者が取り消した）・`apple_error`・`unauthorized`（期限切れ・照合失敗）。
    5. アプリは戻った `state` が覚えたものと同じか確かめる。そのうえで `POST /auth/link` `{ code, code_verifier }`（両方必須）で session に替える。この code は、始めたアプリの `code_verifier` と合う時だけ、一度だけ使える（15分）。利用者が手で入れるものではない。
    - Androidの戻り先 `approvalbox://auth/apple` は、アプリのintent filterで受ける。
- 開発用session（`admin create-user`）は試験用。アプリの画面からは使わない。
- 401 `unauthorized` を受けたらsessionを捨ててログインへ戻す。
- `POST /auth/logout`（Bearer必須）→ `{ ok: true }`。そのsessionを失効させる。端末の通知を止めるなら、先に `DELETE /devices/{id}`。

## 決裁

```
Decision {
  id: "K-1234",
  title: string,                 // 120字まで
  context: string,               // プレーンテキスト。20,000字まで。Markdownとして描画しない。http・httpsのリンクは1回のタップで標準ブラウザに開く（確認を挟まない）。長押しでコピーできる
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
  answer?: { option_id?: string, text?: string, attachments?: Attachment[], answered_at: time },
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

- 添付: AIの背景（context）は文字だけ。利用者の答えには画像・書類を添付できる（v0.23、下の「添付」）。
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
| POST | `/decisions/{id}/answer` | `{ option_id?, text?, attachment_ids?: string[], version }`。option_id・text・attachment_ids（1件以上）のどれか1つは必須（添付だけの答えも可）。versionは必須。pending・heldの時だけ。応答は更新後のDecision |
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

## 添付（v0.23）

**状態: サーバーとWeb版は本番に配備済み（2026-10-03、b7726eb）。端末のコネクタ0.1.9（配送前の保存・`get_attachment`）もnpmに公開済み（2026-10-03）。0.1.8以前のAIには添付の一覧だけが文で届く。リモートMCPの `get_attachment` も使える。**

利用者の答え（自由回答）に、画像と書類を混ぜて複数付けられる。添付だけの答えもよい。流れは「先に1ファイルずつ上げる → answer に id を並べて確定する」。

```
Attachment {
  id: "att_…",                   // サーバーが付ける。推測できないランダムな値
  name: string,                  // ファイル名（サーバーが整えた後の値。表示とAIへの案内に使う）
  content_type: string,          // 下の許容形式のどれか
  kind: "image" | "document",
  size: int,                     // バイト
  sha256: string,                // 中身のSHA-256（16進、小文字）
  created_at: time
}
```

| メソッド | パス | 内容 |
|---|---|---|
| POST | `/decisions/{id}/attachments?name=<ファイル名>` | 本文はファイルの中身そのまま（multipartにしない）。`Content-Type` にファイルの形式。`Idempotency-Key` 必須。pending・heldの時だけ。→ `Attachment`（まだ答えに結ばれていない「下書き」） |
| GET | `/decisions/{id}/attachments` | その申請に自分が上げた下書きの一覧 `{ items: Attachment[] }`（アプリが落ちて作り直す時用。答えに結ばれた添付は `answer.attachments` を見る） |
| DELETE | `/decisions/{id}/attachments/{attachment_id}` | 下書きを1件消す（個別削除）→ `{ ok: true }`。答えに結んだ後は消せない（409 `conflict`） |
| GET | `/decisions/{id}/attachments/{attachment_id}` | 中身を取る（下書き・答えに結んだ後のどちらも）。`Content-Type`・`Content-Length`・`Content-Disposition: attachment; filename*=UTF-8''…`・`ETag: "<sha256>"`。`Range` は使えない |

- `name` はURLエンコードしたファイル名（日本語可）。サーバーは改行・制御文字・`/`・`\` を取り除き、200字に切る。空なら `file`。同じ名前が重なってもよい（区別は id）。
- 許容形式（`Content-Type`）。中身の先頭も確かめ、宣言と合わなければ415。
  - 画像（kind=image）: `image/jpeg`・`image/png`・`image/heic`・`image/heif`・`image/gif`・`image/webp`
  - 書類（kind=document）: `application/pdf`、`text/plain`・`text/markdown`・`text/csv`・`application/json`（UTF-8であること）、Office（`application/vnd.openxmlformats-officedocument.wordprocessingml.document`・`…spreadsheetml.sheet`・`…presentationml.presentation`）
  - `Content-Type` の `; charset=…` などの引数は無視する。上に無い形式（動画・zip・実行ファイル等）は415。
- 上限: 1ファイル 20MB（20,971,520バイト）、1つの答えに10ファイル・合計50MB。1つの申請の下書きも同時に10ファイルまで。アカウント全体の保存は1GBまで（既決の自動削除・データ削除で空く）。
- 下書きは上げた本人（同じアカウント）の、その申請にだけ使える。他のアカウントの添付は、どのAPIでも404 `not_found`（あるかどうかも見せない）。
- answer の確定: `attachment_ids` の全部が「この申請の、まだ結ばれていない下書き」の時だけ受け付け、答えと同じ取引で結ぶ（一部だけ結ばれることは無い）。1つでも違えば答え全体を400 `validation_failed` で断り、何も変えない。重ねて並べるのも400。並び順は送った順のまま `answer.attachments` に入る。
- 409 `conflict`（version違い）の時、下書きは消えない。最新のDecisionを見せて、同じ `attachment_ids` のまま答え直せる。
- 答えた時、`attachment_ids` に入れなかった下書きは消す。AIが取り下げた時（cancelled）も、その申請の下書きは消す。上げてから24時間結ばれなかった下書きも消す。
- 結ばれた添付は答えの一部で、決裁と一緒に消える: 設定の「データ削除」（`DELETE /decisions?status=answered,cancelled`）、保存日数（`retention_days`）での自動削除、アカウント削除（`DELETE /me`）。消した後のGETは404。
- 送り直し: 上げる時の通信が切れたら、同じ `Idempotency-Key` で同じ中身を送り直す。初回が済んでいれば同じ `Attachment` が返り、二重には保存しない。同じキーで中身が違えば400 `validation_failed`。answer も今までどおり `Idempotency-Key` で二重にならない。
- 下書きの段階では、決裁の `version` も変わらず、イベントも出さない（AIからは見えない）。答えた時に `decision.updated`（change=answered）が1回出る。
- アプリは上げる前に、HEICをそのまま送ってよい（変換は要らない）。AIが読めない形式でも、ファイルとしては渡る。

### AIへの渡り方

- AIへ届く答えの文に、添付の一覧（番号・ファイル名・形式・大きさ）と取り方を書く。
- 端末のコネクタ（0.1.9〜）: 配送の前に、コネクタが添付を端末の `~/.approval-box/attachments/<決裁ID>/` に保存し、保存した場所も答えの文に書く。AIは `get_attachment` ツールでも取り直せる（画像はそのまま見られる形でも返す）。
- リモートMCP（GrokBotなど）: `get_attachment` ツールが中身を返す（画像は image、書類は埋め込みのファイル）。
- `get_decision` の `answer.attachments` に同じ一覧が入る。

### エラー（追加）

| HTTP | code | アプリの扱い |
|---|---|---|
| 413 | `too_large` | 大きすぎる・数が多すぎる・アカウントの保存の上限。message を出す |
| 415 | `unsupported_type` | その形式は付けられない。message を出す |

## 更新の知らせ

- 背景にいる時: プッシュ通知（APNs・FCM）。
  - 表示文は件名だけ（背景は出さない）。
  - payload: `{ type: "decision.created" | "decision.updated", change?: "amended" | "cancelled" | "answered" | "delivery", decision_id, version }`。開いたら `/decisions/{id}` を取る。
  - 鳴らすのは created（件名）と amended（「修正: 件名」）だけ。cancelled・answered・delivery は音なしの更新（バッジと一覧の更新だけ）。
  - 表示文はサーバーが組み立てて渡す（`title`。created は件名、amended は「修正: 件名」）。音なしの更新には `title` を入れない。
  - APNs: 鳴らす時は `aps.alert.title` と `aps.sound`、`aps.badge`。音なしは `aps.content-available: 1` と `aps.badge` だけ。どちらも `apns-push-type: alert`・priority 10 で送る（background にするとiOSが後回しにし、答えた後もバッジが残る）。独自のキー（type・change・decision_id・version）は aps の外に置く。
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
- **例外: お金の動かない購入（サンドボックス）**（クオの裁定 2026-10-01）。App Reviewの審査とTestFlight、Xcodeでの購入はサンドボックスになり、審査の担当者はPCをつながないので接続テストを通せない。そこでサンドボックスでは確認を待たずに購入の画面を出し、サーバーも受け付ける。本物の購入（Production）は今までどおり確認が済むまで出さない・受け付けない。
  - iOS: `AppTransaction.shared` の `environment` が `.sandbox` か `.xcode` なら、`setup.verified=false` でも購入ボタンを出す。
  - サーバー: `/billing/appstore/verify` に送られた署名付きの取引（JWS）の `environment` が `Sandbox` なら、確認の関門を通す。判断は署名を確かめた取引の値だけで行い、アプリが申告した値は使わない。
  - Android（Google Play）の試験用購入（ライセンステスター）も同じ扱いにする（購入情報の `purchaseType` が試験）。
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
- 決済の検証はサーバーが行う。App Storeは `/billing/appstore/verify` と通知V2で実装済み。Google Play（`/billing/play/verify`）とStripeは未実装で、呼ぶと404 `not_found`。
- `trial` には今は期限が無い（`expires_at` を返さない）。無料体験の長さ・数え方はクオの裁定待ちで、決まったら `/me` に `trial_ends_at` を足す（フィールド追加なので、今のアプリは壊れない）。
- `/billing/appstore/verify`（v0.21 実装）: 署名をAppleのルート証明書まで確かめ、商品（`dev.kitepon.approvalbox.monthly`）・Bundle ID・本番はアプリのApple IDを照らす。期限内で返金されていなければ `plan=active`・`expires_at`・`store=app_store`。断る時: 署名・商品・環境が違う → 400 `validation_failed`、`appAccountToken` が自分の `user_id` でない・同じ購入が別のアカウントに結ばれている → 409 `conflict`、本番の購入で確認前 → 409 `setup_not_verified`。
  - 受け付ける環境は `Sandbox`（審査・TestFlight）と `Production` だけ。Xcodeの StoreKit 設定ファイルでの購入（`Xcode`）はAppleの署名でないので、サーバーは 400 で断る。Xcodeでの試しは画面までにする。
  - 通知V2の受け口は `POST /v1/appstore/notifications`（ASCの本番・Sandboxの両方に登録）。更新・返金をここで反映する。期限を過ぎて更新の知らせが無ければ `/me` は `expired` を返す。

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
| 413 | `too_large` | 添付が大きすぎる・多すぎる（v0.23） |
| 415 | `unsupported_type` | 添付できない形式（v0.23） |
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

- v0.23 2026-10-03 クオの依頼（ベル経由）: 答えに画像・書類を複数添付できる。`POST/GET/DELETE /decisions/{id}/attachments`、answer の `attachment_ids`、`answer.attachments`、エラー 413 `too_large`・415 `unsupported_type`。添付だけの答えも可。添付は決裁と一緒に消える。
- v0.22 2026-10-02 記述だけ直す（契約は変えていない）: 公式サーバーは1台で BILLING=store・Apple/Googleログイン。開発用sessionはアプリで使わない。`trial` は期限なし、体験の形が決まったら `trial_ends_at` を足す。
- v0.21 2026-10-02 `/billing/appstore/verify` と通知V2の受け口を実装（契約は変えていない）。断る時のエラーと、Xcode環境の購入はサーバーが受け付けないことを明記。
- v0.20 2026-10-01 クオの実機の指示「リンクを押した時に画面を挟まず、サイトを開いてほしい」: 背景のhttp・httpsのリンクは1回のタップで標準ブラウザに開く。行き先の確認画面はやめる（アプリ・Web版とも）。
- v0.18 2026-10-01 クオの裁定: サンドボックス（審査・TestFlight・Xcode）とPlayの試験用購入は、セットアップ確認を待たずに購入できる。本物の購入は今までどおり。
- v0.19 2026-10-01 音なしの更新（答えた・取り下げた等）も `apns-push-type: alert`・priority 10 で送る。backgroundではiOSが後回しにして、バッジが残った（クオの実機）。アプリも、一覧を読んだ時と答えた時に、自分で pending の件数をバッジに入れる。
- v0.17 2026-10-01 クオの裁定: ログイン用のURL・コードを廃止。ログインはAppleかGoogleだけ。結ぶ・外す操作を廃止（v0.16 の `logins`・`DELETE /me/logins` は取り消し、`login` のまま）。`/auth/link` はAndroidのAppleログインから戻る一度きりのコード専用（`code_verifier` 必須）。`/me/personal-link` 廃止。
- v0.16 2026-10-01 クオの指摘「結べるようにしたらいい」: 設定からAppleとGoogleを1つずつ結べ、外せる（`DELETE /me/logins/{provider}`、締め出しになる時は409）。`/me.logins` を追加（`login` は互換）。
- v0.15 2026-10-01 ベルの依頼で、AndroidのAppleログイン（Custom Tabs）の開始・復帰の取り決めを追加。`POST /auth/apple/web/start`、`/auth/apple/callback`、`approvalbox://auth/apple`、`/auth/link` の `code_verifier`（PKCE S256）。
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

## アプリ診断（2026-10-04）

`POST /v1/diagnostics` はアプリのBearer sessionで診断イベントを受け取ります。未ログイン時は端末内outboxへ保存し、ログイン後に送ります。項目・列挙・重複排除・上限・MetricKit・BugHub管理APIの契約は [diagnostics.md](diagnostics.md) と `packages/server/src/diagnostics.ts` を参照してください。初回も同一イベントの再送も202で受領を返します。診断POSTの失敗は診断として再送信しません。

## 申請画像（v0.27）

AIが撮影・作成した画像を申請本文に添え、人が画像を見て通常の回答を出せる。利用者の回答添付とは分離する。Decision（利用者GET/list、AI create/get/list/amend）に `request_attachments: Attachment[]` を追加する。未添付は空配列、旧サーバー互換のためアプリ側は欠落も空として扱う。Attachmentは既存の `id,name,content_type,kind,size,sha256,created_at`。kindはimageのみ。

原本は既存 `GET /v1/decisions/:id/attachments/:aid` を共用し利用者Bearerを必須とする。他accountは404。AIは自接続の `GET /connector/v1/decisions/:id/attachments/:aid` でも取得できる。公開URLは作らない。アプリ/Webはsize・sha256を照合して本文下に『AIの添付画像』、縮小画像/ファイル名を表示しタップで原本拡大。取得失敗時は画像欄に明示して再読込できる。回答添付は `answer.attachments` と従来draft APIのまま。

### AIによるアップロードと確定

`POST /connector/v1/request-images?name=<URL encoded name>` は接続Bearer、画像Content-Type、raw binary body。返却はAttachment。JPEG/PNG/GIF/WebP/HEIC/HEIFの既存signature検査、単体20MiBまで。認証・利用権限・account上限1GiBは既存回答添付と共用。接続/中身SHA256/clean nameが同じ未結合uploadは同じIDを返す。下書きは接続専用で、申請/通知/利用者一覧には出ない。未結合24時間で削除する。

create `POST /connector/v1/decisions` に任意 `request_attachment_ids: string[]`（最大10件、重複不可、合計50MiB）。全IDが自接続の画像下書きでなければ拒否。既存check_token往復を維持する。申請のinsertと全画像の結合を同じDB取引で確定し、その後だけdecision.createdを出す。upload途中や1件でも不正な時は申請も通知も出ない。応答を失った時は既存list_my_decisionsで作成結果を照合し、未結合uploadだけを新しい申請へ使う。

amend `changes.request_attachment_ids` は省略なら保持、`[]`なら全削除、配列なら全置換。自接続uploadと同じ申請の既存request画像IDを混在できる。他申請・他接続・回答添付IDは不可。version競合時は全件そのまま、成功時だけversion更新/履歴fieldsにrequest_attachment_ids/decision.updated通知。旧画像原本はGCで削除する。古いversionへの回答は既存409で防ぐ。

cancelは画像も保持して取消理由とともに閲覧可能。回答時はrequest画像をanswerへ移さず保持する。既決削除/retention/account削除はDB cascadeと原本GCで両種類を削除する。接続を解除すると未結合uploadは削除するが、既存申請の画像は保持する。

### MCP

ローカルstdio `request_decision.image_paths?: string[]` は端末の画像ファイルパス（最大10件）。コネクタがローカル検査/バイナリupload後にrequest_attachment_idsへ変換し、confirmation往復を行う。`amend_decision.changes.image_paths` は全置換、空配列で削除。ローカルpathはサーバー/人へ保存しない。ID指定 `request_attachment_ids` も使えるが同じ呼出しでpathとIDを混在させない。

remote HTTP MCPはローカルファイルを読めないため `upload_request_image(name,content_type,data_base64)` を追加する。返却attachment.idを `request_decision.request_attachment_ids` または `amend_decision.changes.request_attachment_ids` へ渡す。base64は厳密に検査してデコード20MiBまで。1画像ずつuploadし、全画像が揃ったら申請する。`get_attachment` はrequest/answer画像の原本に共用する。
