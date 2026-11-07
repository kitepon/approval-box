# Approval Boxの機能とデータフロー

基準はmain501c880（0.1.31/0.1.32の受け口判定は[配送経路](../connector-routing.md)末尾）。レヴィアタンの2026-11-06容量是正指導に従い、PR15/current（基準90066748）の改善前全域図を現用コードへ対応させた。PR15/finalのHTTP分割・SSE修理・親channel抽出は未採用である。

| 全体機能・入口 | 担当実装と所有状態 | 入力→出力・接続先 | 失敗・回収 |
| --- | --- | --- | --- |
| Web/nativeの利用者API | server/http.ts createApp、Accounts、Decisions、Attachments | session Bearer＋JSON/binary→SQLite確定状態→Web/native。契約は[api.md](../api.md) | 検証/権限エラー、409は最新状態を返す。欠測や通信中断を保存成功へしない |
| AIの申請・取得 | connector/mcp.ts runMcp、server/remote-mcp.ts remoteMcpHandler | stdioまたはPOST /mcp＋connection Bearer→Decisions→要約/確認札/申請/取得 | 同connection・channel境界を維持。AIの本文を自動再POSTしない |
| 認証・接続・課金 | server/accounts.ts Accounts、oidc.ts、appstore.ts | Apple/Google署名/nonce/公開鍵、pairing→session/connection token/plan | 期限・一回取得・所有者検査、未知の署名は拒否。解除とアカウント削除は別 |
| 申請・回答・画像 | server/decisions.ts、attachments.ts、db.ts | 検証済入力→SQLite schema10＋添付原本→利用者/AI | DBとFSは別境界。24h下書き/1h part/孤立原本GC、closedの設定保持期間。現用/唯一データを容量理由で消さない |
| 更新通知・画面 | EventHub、push.ts、http.ts SSE、web/api.tsとApp/pages | commit→event保存→SSE/APNs→再GET→表示 | 切断backoff、通知受理と端末反映を区別。未採用のPR15 SSE finally修理を描かない |
| PCへの回答配送 | connector/daemon.ts、channel-delivery.ts、外部Steer | API待ち→deliveries.json sending→親channel投函→queued/report→API報告後journal削除 | 再起動時sendingは元state照合。不明を未送信とせず、本文を再送しない。queuedのclaude channelは受け口（閉じた印・結んだprocess・同じ会話の待機）、背景channel（Grok等）は受信processの記録（state/background-receivers/<channel>.json、hooks/receive.tsが起動時に書く）を2秒ごとに見る。閉じた印は即、受け口が消えて5分で、未取得の本文を取り下げてfailed報告（0.1.31/0.1.32） |
| Bridgeへの回答配送 | server/callbridge.ts、Decisions、bridge_deliveries | answer waiting→session/seq耐久保存→同call_info追跡→終端commit→hangup | [現用詳細図](grok-delivery/README.md)。open前保証失敗だけ期限内defer、結果不明は同通話追跡 |
| 診断・言語 | server/diagnostics.ts、locales.ts、web/locales.ts | strict診断→raw/group/receipt→管理出力。固定文locale変換 | raw30日/10000件、group120日、receiptは重複防止保持。本文・回答・識別子は翻訳しない |
| 導入・常駐・終了 | connector/cli.ts、harness.ts、runtime.ts、daemon-launch.ts、server/main.ts | bundle→版固定runtime→設定控え/登録→MCP/daemon。serverはDB/サービス/HTTP組立て | SIGTERM/INT、daemon idle、server abort/close/DB close。旧会話のruntimeを一律削除しない。設定の置き換え（config.ts writeJsonFile）はWindowsのEPERM/EACCES/EBUSYだけ短く待って繰り返し、それでも断られれば相手が開いている旨を添えて失敗（0.1.32） |
| 配備・控え・開発生成物 | Dockerfile、tools/deploy、製品担当の通常配備入口 | [保存と実行環境の詳細](storage-lifecycle.md) | 現用＋直前のimage、NAS検証後のlocal回収。未知run/唯一archiveを保持 |

## 90066748から501c880への対応

差分の機能変更は8895ff8（schema9→10、Bridge session/seq/終端/closed journalと同通話追跡）。fbf78a5はshutdown試験でtimeout時のreader取消を行う試験変更。全体の他責務/公開窓口は同じで、PR15の構造整理は含まない。容量是正は常駐ログwriter、harnessの再生成できる登録設定の失敗temp回収、対応試験・版metadataを変更する。資格・結果不明の状態は共通writerの既定でtempを保全する。詳細は[保存図](storage-lifecycle.md)を参照する。

## データフローと状態の所有

Web/native→session認証HTTP→Accounts/Decisions/Attachments→SQLiteと添付→commit後EventHub→SSE/APNs→再GET。AI→stdio MCP/remote MCP→connection認証→Decisions→answer waiting。PC配送はdaemon journal→外部親channel→state照合→報告後回収。Bridge配送はSQLite journal→同通話追跡→終端確定後close。診断logはこれらの業務状態から独立し、失敗しても配送結果を書き換えない。

機能表から実ファイル・関数・保存/readerを辿る。native/Steer/Aiterm/Bridge/ホストの内部とThroughlineは担当外。図の正本はこの入口とリンク先であり、人間向けの画像生成物は必須にしない。
