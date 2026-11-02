# 候補の検証と未確認

Sol6.1 High、2026-11-02。runtime変更の最終commitはc19258f、shutdown試験5925da9、追加回帰試験97dd816。Astra xhighの図・責務・コード照合を実施。レヴィアタンの成果確認は未完。本番未反映。

| 確認 | 結果 | 原本 |
|---|---|---|
| 通常npm test | server103 / connector38、全成功、force-exitなしで完走 | validation/d1-unit.log、d1-validation.json |
| Web単体 | 7成功 | validation/d1-web.log |
| 全workspace型検査 | exit0 | validation/d1-typecheck.log |
| 全build | server/Web/connector成功。runtime sourceは以後変更なし | validation/l1-build.log |
| browser | 18成功 | validation/l1-browser.log |
| Linux4harness起動前 | 4成功、実AIは起動せず | validation/l1-preflight.log |
| local dist隔離起動 | 7HTTP契約・正常SIGTERM/exit0 | validation/dist-smoke.json |
| 元route保持 | middleware/mount/fallback込み72登録multiset一致 | refresh-index.mjsのassert、interface-index.json |
| 処理本体保持 | HTTP4helper/親5関数/MCP handler/locale辞書/固定翻訳の14照合 | contract-check.json |
| 図 | 現状8/設計3/最終8の19図をSVG/PNGへ描画し目視 | render-check.json、同stemのSVG/PNG |
| 全ファイル対応 | tracked全件scope、実行source/test/宣言/import/routeの索引 | scope.md、source-index.json、interface-index.json |

validation/の絶対rootは`/srv/bellteam/bots/bot-4366a50b/docs/approval-box/refactoring-20261102/validation/`。d1-validation.jsonにはcommand・実行commit・開始/終了・exitを保存した。旧force-exit付きログは全件数に届かず終了するものがあるため、全件成功の根拠から除外した。

## 構造整理と修理の採用条件

HTTP公開契約・認証・idempotency、MCP tool/schema/案内とlastChannel更新順、locale/翻訳の意味を保つ条件で、ce91fa3/137028d/c19258fを構造整理の候補とした。MCPのrequest/setup失敗時更新とamend/resume失敗時保持は実stdio/偽HTTPで追加確認。idempotencyは4xx/最初の言語/別route拒否/5xxとrate-limit非保存/token一度返しのHTTP回帰を追加した。

9b55bf6はSSE失敗時の挙動を変える独立fix。write例外と送信中abortで購読/停止listenerが残る反例を8試験で再現し、finallyと待機前abort再確認で解放する修理を採用した。5925da9は試験のreader/timer後始末修理。いずれも構造整理の不変性へ含めない。本番の元障害発生や実端末の回復を合成試験から主張しない。以後の修理も別工程/commitで扱う。

## 描画と目視

Mermaid CLI12.0.0、既存Chromium1248、共通chromium/env.shのfonts/OS依存でSVGを生成した。CLI12のsize指定へ合わせ、intrinsic寸法のSVGとPNGにした。初回は旧width optionで失敗したが、正規CLIのhelpに従って再描画し全19枚成功。図取得時にSVGの子rectへ寸法を誤適用した候補は破棄し、root属性だけを設定する形へ直して全19枚を再生成した。保存成果は修正後。

最終8図・設計3図・現状の差のある4図を目視。現状のattachments/decisions/identity/runtimeは最終原本とbyte同一で、同じ描画結果を照合した。全体図は交差線を減らし詳細図へ分け、sequenceのactorと長いnoteは改行を入れた。文字切れ・ノード重なりがなく、状態と異常経路を読めることを確認。縦長の配送/申請図は原寸SVGの拡大とスクロールを想定する。

## 未確認・既知の制限

macOS/Windowsの実機での製品受入、全OS×4harnessの実AI操作、実Appleログイン/購入/APNs、native apps内部の新受入は未実施。詳細と12組の表は[scope-notes](scope-notes.md)。当席にdocker実行入口がないため、local distの確認に加えて、draft PR15の正規CIでDocker checks/runtime imageと隔離smokeを確認した。

既存の添付DB/FSの非原子的な停止窓、MCP親記録の読取失敗時fallback/open後保存失敗、配送unknownの本文無条件再送禁止は[flows](flows.md)に残す。新しい原子性や全障害からの回復を主張しない。翻訳品質全件/暗号アルゴリズムの独立監査は未実施。レヴィアタンへの報告と確認不足の修正、別2prompt予定の復帰は最終整合後に行う。


## Astra最終整合（2026-11-02）

get_selfでgpt-6-astra/xhigh/fast=falseの適用を確認した別ターンで、設計・全差分・図と状態所有者を照合した。HTTPは旧http.tsの68登録を順序どおりに展開して確認し、SSE2経路を除く登録本体は空白とfiles/sweepへのservices引数以外が一致した。adminの4登録は未変更で計72。認証middleware、公開pairing2経路、fallback、AppStore具体経路の先行を確認した。

親channel5関数とrunMcpの本体保持、MCP schema/定数、lastChannelの更新時点、純粋共通文言のimportとApiErrorのstatus/extra順序を確認した。Claudeのprocess変更・旧channel保持は既存fixture、Codexのthread分離・永続再利用とlastChannel失敗順は追加fixtureに対応する。Cursorのverify→再利用/新規と保存失敗の伝播は本体保持とコード照合で確認したもので、実Cursor/実AIの操作成功とは区別する。

図の誤りとして、logoutとaccount削除の後始末の混同、CallBridgeのfailedとunknownの省略、EventHubが書くevents rowの主体、admin GETと状態変更の区別、purgeExpiredの非一括取引を補正した。current/finalの両方に基準コードの事実を反映し、製品コードは変更していない。業務commitと冪等応答控えの保存の停止窓、FSの途中削除がDB rollbackで戻らない限界も明記した。

全233 tracked fileのscope掲載を再照合し欠落0。119ソースhash、Markdownの全ローカルファイルリンク、19描画hashを再照合し成功した。最終8図・設計3図・現状の異なる4図をAstraでも目視し、残る4図は原本とPNGが最終と同一と確認した。診断図の長い矢印ラベルの重なりは短いGET/POSTへ直し再描画・目視した。照合原本はvalidation/a1-preservation.json。本文・図の補正だけなので既成功の製品単体試験は反復せず、3OS・実image検証は下記の正規CIで補った。


## 正規CI

[draft PR15](https://github.com/kitepon/approval-box/pull/15)の[run41402647664](https://github.com/kitepon/approval-box/actions/runs/41402647664)は、head `f1e16f71a74ef684133dc333cfb995e01d563caa`、2026-11-02 06:52:11〜06:53:37Zで全5ジョブsuccess。原本はvalidation/ci-41402647664.jsonと.logに保存した。以後の変更は文書・索引だけで、製品/試験/構築のコードは同一である。

- Ubuntu/macOS/Windowsの各job: 全build/typecheck、locale14、4harness preflight4、account削除/移行7、診断21、API/connector認証22が成功。各OSの4harnessは実AIを起動しない。
- browser: Playwright18件成功。
- server-image: 改変Node archive/署名拒否、固定Node24.22.1/npm11.21.1とCA条件、checks/runtimeのbuild、秘密・本番データなし/read-only/network-noneの起動・公開契約・SIGTERM成功。server試験は103件/pass103/fail0をログで照合した。既存Docker checksはforce-exitオプションを持つため、自然終了の根拠は通常npm testのd1-unit.logを使う。件数不足の旧ログとは分ける。

mainへのmerge、tag、npm公開、本番配備・停止・再起動は行っていない。PRは成果確認用のdraftであり、レヴィアタンの確認後も本番反映は既存承認手順に従う。
