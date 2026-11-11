# 責務整理の設計

2026-11-02、Astra xhigh。対象コードは90066748、現状図はaae6046。これは実装前の設計であり、動作確認済みの成果とは区別する。実装後は[検証計画](verification-plan.md)に従い、最終図と実装の対応を別に確定する。

## 目的と採用する変更

機能の不具合から、その認証、状態の所有者、返却先、後始末へ辿れるようにする。変更は次の三つとする。

1. `server/src/http.ts`から、公開認証経路、利用者session経路、コネクタ経路を分ける。登録順と認証主体を呼出し元で見えるようにし、SSEの購読・終了を一つのファイルが持つ。
2. `connector/src/mcp.ts`から、親会話の識別とchannelの再利用・保存を切り出す。MCPのtool定義、引数の変換、API呼出し、返却文はそのままMCPが持つ。
3. WebとAPIが使うlocale定義と固定エラー文の翻訳を、純粋な共通モジュールへ移す。HTTPの例外型と状態コードはserverが持つ。

申請・回答と添付の論理結合、配送の再送判断、DBとファイルの確定順序は現状を保つ。API v0.37、DB schema9、公開MCP tool名・schema・案内、CLI・設定・環境変数、画像上限、保存期限を変更しない。製品全域を図に載せることと、全ファイルを書き換えることは分ける。

## 代替案と採否

| 論点 | 採る案と理由 | 採らない案と理由 |
|---|---|---|
| HTTPの分割 | 認証主体ごとの既存Hono routerを保ってファイルへ移す。rootは登録順と共通エラー処理を持つ | 全routeを一件ずつcontroller化する案は、細かい受渡しだけが増える。巨大createAppを残す案は境界を追いにくいままになる |
| 依存の受渡し | 現在の`Services`を同じ構造で渡す。型だけ別ファイルへ移し、`http.ts`からのtype exportを維持する | DIコンテナ、service locator、汎用route registry、各ファイル専用の同形interfaceは追加しない |
| HTTPの共通処理 | `body`・`bearer`・`idempotent`・`fileResponse`と添付取得/GCを、用途の限定されたHTTP helperへ置く | 全エラーや検証を共通middlewareへ押し込むと、APIごとの順序・例外・statusが変わる。検証を一方から削除しない |
| SSE | 利用者履歴とconnectionの再取得合図を別関数に保ち、購読と後始末だけ同じ所有者へ集める | 二種類を汎用stream engineへ統合するとqueueとpendingの違いが隠れる。EventHubや再接続間隔の再設計は不要 |
| 親会話 | 既存関数と状態を`parent-channels.ts`へ移す。`lastChannel`はMCP応答の文脈なのでMCPに残す | 全親をclass/registryへ置換する案、配送daemonと統合する案、暗黙に全toolで親を特定する案は、寿命や呼出し時点を変える |
| MCP schema | 既存`mcp.ts`内を維持する | local/remote MCP schemaの統合は、ローカルpathとbase64画像、channelとcallbridgeの契約差を消す危険があり、今回不要 |
| 共通文言の配置 | `packages/server/src/shared/`を純粋な共通ソースの置き場とする。既存server tscとWeb Viteがそのまま扱える | 新workspace packageはnpm依存・lock・build順・Dockerコピー・配布物を増やす。rootのTSを直接importする案はserverの`rootDir=src`と既存dist配置に影響する |
| 共通文言の責務 | localeの一覧/正規化、既知の固定文の辞書/変換だけ共有する。HTTP headerの優先度とWebの選好/保存はそれぞれが持つ | server/errorsの直接importは例外型・HTTP statusへの依存を残す。全UI/通知/案内を一つの辞書にまとめる必要はない |
| Decisionsと添付 | 同じDB取引内の所有・version・選択肢・画像検証と結合を維持する | SQL repositoryや添付結合serviceへの機械的分割は、取引の境界を跨ぐ受渡しを増やす。今回は採らない |
| 配送とファイル確定 | 現状の責任と停止窓を図に残す | 不明結果の再送やrequest/answer uploadの順序統一は、データ保持や冪等性を別に設計・検証する必要があるため、本整理へ混ぜない |

共通ソースの物理配置はserver配布物に収めるための判断である。`shared/`からserverの例外・DB・HTTP・Node組込み・Web状態へimportしない。Webからserverを参照できる範囲はこの純粋な共通ソースに限定する。共有辞書に独立した配布先が必要になった時にpackage化を再検討する。

## H1：HTTPの登録と状態所有

図は[HTTP設計図](design/http.mmd)。`createApp(services, options)`の引数と返すHono appを維持する。

| ファイル（packages/server/src以下） | 責任・入出力 | 持たない状態 |
|---|---|---|
| `http.ts` | root app、onError、Diagnostics生成、admin/healthz/各router/remote MCP/staticの順序。`Services`を再export | sessionやdecisionの独自cache |
| `http/types.ts` | 現在の`Services`型のみ。type importで既存domainを参照 | runtime初期化、副作用 |
| `http/public.ts` | `registerPublicRoutes(app, services)`。Apple/Google認証、Apple callback/link、署名付きApp Store通知 | tokenの別保管、ログイン失敗の握りつぶし |
| `http/user.ts` | `registerUserRoutes(app, services, diagnostics)`。session認証済みuserId、現在の`v1` route一式、最後のJSON404 | DB取引の分割、新しい申請/回答状態 |
| `http/connector.ts` | `registerConnectorRoutes(app, services)`。公開pairingを先に登録、connection認証済みconnのroute一式、最後のJSON404 | channel実体、配送journal |
| `http/common.ts` | `bearer/body/idempotent/fileResponse`。`files(services)`と`sweep(services)`は現在のoptional attachmentsとGC失敗ログの意味を保つ | 新しい永続状態、汎用業務service |
| `http/streams.ts` | `userEvents`と`connectorEvents`、`untilWake`。購読、user queue/sentまたはconnection pending、heartbeat timer、shutdown listenerの寿命 | DB確定、配送完了、Webの表示完了 |

登録順は、共通onError → admin → healthz → 公開認証/Apple通知 → session `/v1` → 公開pairing `/connector/v1` → 認証必須 `/connector/v1` → `/mcp` → static、とする。個々の公開route順も現状どおり。Apple購入の具体routeを未実装storeのfallbackより先に置く。public APIに対しsession認証を追加せず、未知のconnector要求から認証を外さない。`/mcp`は既存remote handlerがconnection Bearerを検証し、GET/DELETEは405を返す。

`body`は空本文を`{}`としてparse、壊れたJSONをApiError、schema失敗をZodErrorとして上へ返す。onErrorはlocale/status/Retry-After/Content-Language/Varyと構造化extraを維持する。`idempotent`の同期変更から応答控え保存までにawaitを入れない。同user/key/routeの応答は最初の言語を含めそのまま再生する。5xx/rate_limitedは保存しない。token一度返し、ファイルupload独自の冪等性をこのhelperへ通さない。

SSEの正常終了・client abort・shutdownは現在の意味を保つ。現在はloop末尾に置かれた`removeEventListener/unsubscribe`が、loop内例外で実行されない構造になっている。実際の障害発生は未観測。切出し先ではloopを`try/finally`で囲み、同じcleanupを例外時にも実行する。`onAbort`のwakeと購読解除を保ち、解除の重複はEventHubの冪等なoffに任せる。送信例外を成功へ変換しない。SSE event名/id/payload、25秒heartbeat、user履歴の重複除外、connectionの初回通知を変えない。例外時cleanupの必要試験はH2に定める。

## M1：親会話とMCP応答の分離

図は[親会話設計図](design/parent-channels.mmd)。新しい`connector/src/parent-channels.ts`へ`Harness/harnessOf`と`ParentKey/parentsFile/savedParents/reuse/remember/channelFor/processChannels`を移す。公開するのは`Harness/harnessOf/channelFor`。既存`mcp.ts`の`Harness/harnessOf` exportは同じ定義の再exportで維持し、`runMcp/named/SPEAK_BY_TITLE`も維持する。

| 状態・対象 | 所有者 | 保持する規則 |
|---|---|---|
| Codex親→channel | parent-channels、`parents.json` | `codex_home + thread_id`のkey。毎回MCP metadataで親を特定。既存の開いたchannelを再利用。hook/親アプリ再起動を申請受付条件にしない |
| Claude親→channel | parent-channels、`parents.json` | session_idのkeyと既存`claudeChannelIsCurrent`のprocess照合。/clearやprocess差なら新規。古いchannelは閉じず、残答えを保持 |
| Cursor/background | parent-channels、moduleのMap | Cursorはverify後、process内だけ再利用。Grok/otherはbackground。永続化へ変えない |
| 直前のchannel | mcp.ts、既存module変数`lastChannel` | list/getの`this_session`用query。親記録と別の意味・更新時点を持つ |
| channel実体 | 外部aiterm-steer-delivery | open/closed/親識別の既存公開adapterのみ使う。内部実装を変更しない |
| 配送中/queued/report | daemonと既存journal | この切出しの影響外。未送信と不明を混同せず、元本文の再送条件を増やさない |

`lastChannel`はrequest/setupでchannel取得直後、画像検査・API書込みの前に更新する。amendは画像upload→channel取得→API成功後に更新、resumeもAPI成功後に更新する。list/get/cancel/get_attachment/confirmはこの値を変更しない。失敗時だけ更新位置を揃えるような整理をしない。

親不明は既存のMCP isErrorへ戻り、申請を送らない。`parents.json`の読取失敗は現在どおり空として扱い、保存失敗は上へ返す。open後の保存失敗で新channelを勝手に閉じない。これらは既存の限界であり、新たな原子性を主張しない。MCP切断・プロセス停止で永続親記録/待機中の答えを消さない。実際の通信エラーと、申請の受付・配送・AI作業完了を分ける。

## L1：共通の言語定義と固定エラー文

図は[言語設計図](design/localization.mmd)。新しい共通ソースは`packages/server/src/shared/`に置く。

- `locales.ts`: 一つの`LOCALES/Locale/supportedLocale`。現在の二つはbyte同一なので一方を移し、旧ファイルと重複を消す。全callerを更新する。
- `error-messages-en.ts`と`error-messages-east-asian.ts`: 現在の辞書を内容変更なしで移す。
- `error-translations.ts`: `ErrorCode`、generic fallback、既存`fixedErrorTranslation`と、ApiError.bodyにある純粋な文言選択を`errorMessage(code, message, locale)`として持つ。
- `server/errors.ts`: status対応、`ApiError`のclass/constructor/extra/retryAfterとbodyの組立を持つ。`ErrorCode`型は再exportを維持。文言選択だけ共通関数へ渡す。Webは`ApiError`やHTTP statusをimportしない。

`requestLocale`はAccept-Languageのq値・順序・既定jaをserverで解釈する。Webの`resolveLocale`は選好→navigator順→ja、localStorageと変更通知をWebで持つ。headerとbrowserの選択ロジックを一つにしない。中国語の明示script優先・地域・bare zh、5 localeの順序と文字列を維持する。

APIはjaなら元のmessage、他言語は既知の日本語辞書keyまたはcode別fallbackを使う。Webの`fixedErrorTranslation`は既知の固定文の逆引き、未知の自由文にはundefinedを返す。この二つの違いを保つ。元の反復順・同文衝突時の選択・extraのspread順・保存済み冪等応答を変更しない。申請本文、回答本文、名前、path、ID、時刻、ユーザー由来の補間値を翻訳しない。

## 正常・取消・停止・途中失敗・不明・後始末

全体の現状は[current/flows.md](current/flows.md)。今回変更する接続について、次を実装と図で確認する。

| 場面 | データ/状態の所有者と返却先 | 今回保つ/明確にする点 |
|---|---|---|
| 申請の確認札 | Decisions→HTTP/MCP→AI | confirm_requiredは未受付。create/amendの添付結合は同取引 |
| 回答成功 | Decisions tx→event afterCommit→HTTP応答、別工程で配送 | 受付・回答保存・配送結果・再GET後の画面表示を区別 |
| 回答の競合/入力失敗 | domain/schema→HTTP onError、MCP catch | code/status/latest decision/extraを維持。tx失敗ならbus通知なし |
| 取消 | cancel/hold/logout/pairing拒否はそれぞれのdomain | 汎用取消処理へ集約しない。申請画像保持/回答draft除去、token失効を維持 |
| HTTP書込みの応答喪失 | server idempotency、clientの同key再試行 | 同じ応答控え。request/AI新規申請の自動再POSTは追加しない |
| 添付途中失敗 | AttachmentsのFS/DB、connector upload | 未結合画像のGC、DB/FSの停止窓を維持。論理結合の失敗はrollback |
| SSE切断/停止/例外 | http/streamsのsubscription/timer/listener | 通知の終了をDB状態に書き戻さない。finallyでcleanup、clientは既存再取得規則 |
| MCP親特定/open/保存失敗 | parent-channels→mcp catch | 本文未送信/親記録保存失敗を具体的に返す。channelや既存の答えを消さない |
| 配送結果不明/再起動 | daemon journalまたはserver delivery | 明示get/resume/照合と報告の既存契約。本文の無条件再送なし |
| account削除/既決削除 | Accounts/Decisions/Attachments | 既存削除取引とGC失敗の扱いを変えない。消えたFSをrollbackで復元できるとは述べない |

## 実装の段階と戻し方

| 段階 | commitにまとめる範囲 | 終了条件 |
|---|---|---|
| H1 | HTTPの登録/型/helper/SSEを移す。まず動作を保つ分割 | 全routeの順序・認証・fallback、server関連試験・typecheckが一致 |
| H2 | SSE例外時のfinallyと小さな回帰試験 | user/connectionの正常・abort・shutdown・例外で購読解除とlistener解除を確認 |
| M1 | parent-channelsへ移す。必要な親再利用/lastChannel境界試験 | MCP schema/応答、4親分岐、永続/非永続、既存配送試験が一致 |
| L1 | 純粋共通モジュールへ移し全importを更新。辞書は内容保持 | 5 locale/API/Web試験、server tsc・Web bundle・全typecheckが成功 |
| D1 | 未調査ファイルの責任を埋め、final図・全caller/index・検証記録を同期 | 全機能を実ファイルまで追跡でき、全図を描画・目視済み |
| A1 | 次ターンのAstraで最終整合確認 | 公開契約/状態所有/異常経路を独立照合し、不足を直してレヴィアタンへ返す |

H1〜D1の実コード調査・実装はSol High。設計を変える必要がある新事実は根拠を設計書へ追記し、責任境界の変更はAstra工程へ戻す。単なる移動中のimport名・局所的な型の調整はSolで行う。

各段階は専用branch内の独立commitにして試験結果を添える。失敗はその段階を直し、後段へ既知の失敗を持ち越さない。candidateの回退はコードcommit単位とし、DB/ファイル/journalにmigrationを追加しない。mainや本番の停止・再起動・配備・npm公開は本工程に含めない。候補完成後に既存の反映手順と承認範囲を確認する。

## 未確認と完了条件

現在は設計のみ。図の描画、H1以後の実装・試験、全tools内部と静的資産/設定の機能対応は未完。初期索引74ファイルはTS/MJS等の調査一覧であり、repo全ファイルの説明完了を意味しない。特に`tools/deploy/server-image-smoke.cjs`、workflow・JSON・shell・Python・CSS/HTML/manifestを最終scope表に含める。

最終成果では、現状図を保持して`final/`へ全体図と7詳細図・flows・全コード対応を用意する。新しい責務は図と実symbolへ接続し、改善理由・diff・試験原本・未確認（実Apple購入/APNs、全OSの実AI操作など）を明記する。別製品内部を調べていないことと、自製品の未調査範囲を分ける。本番未反映を明記した候補をレヴィアタンに送り、確認で見つかった不足を修正して完了とする。
