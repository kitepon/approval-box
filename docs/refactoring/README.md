# Approval Box 機能図と責任の対応

基準: main 90066748bf7ca4686716c67c91d76fcd20afa519。2026-11-02、Sol Highによる現状調査。`current/`は改善前の記録。Astra xhighによる設計を追加した。実装・最終整合はまだ行っていない。

設計は[責務・代替案・採否](design.md) → [全caller・test・fixture・exportへの影響](impact.md) → [試験と完了条件](verification-plan.md)の順に読む。設計図は[HTTP](design/http.mmd)・[親会話](design/parent-channels.mmd)・[言語](design/localization.mmd)、全静的routeの移動先は[route-map](design/route-map.json)。設計図も未描画で、実装後の最終図とは区別する。

読む順序は [全体図](current/overview.mmd) → 各機能詳細 → [全ファイル・関数](current/code-index.md)。図はMermaid原本で、まだ描画・目視前。最終成果ではSVGと描画確認を追加する。

| 機能 | 図 | 責任・正常/異常経路 |
|---|---|---|
| 全体と境界 | [overview](current/overview.mmd) | 下記の範囲表 |
| ログイン・端末接続 | [identity](current/identity.mmd) | [状態と契約](current/flows.md#ログインと接続) |
| 申請・回答・取消 | [decisions](current/decisions.mmd) | [状態と契約](current/flows.md#申請と回答) |
| 申請画像・回答添付 | [attachments](current/attachments.mmd) | [状態と契約](current/flows.md#ファイル) |
| 回答配送・不明結果 | [delivery](current/delivery.mmd) | [状態と契約](current/flows.md#配送) |
| 更新通知・画面反映 | [events](current/events.mmd) | [状態と契約](current/flows.md#通知と画面) |
| 診断・購入 | [operations](current/operations.mmd) | [状態と契約](current/flows.md#診断課金運用) |
| 導入・停止・配布 | [runtime](current/runtime.mmd) | [状態と契約](current/flows.md#実行環境) |

## 対象範囲と調査の深さ

- server/src: HTTP/main/decisions/accounts/db/events/attachments/remote-mcp/callbridge/push/oidc/appstore/diagnosticsを実コードから調査。schema9の表/取引/afterCommit、2認証主体、request/answer別所有、setup状態、冪等応答、配送経路を追った。翻訳辞書の全エントリ照合と証明書暗号実装の独立監査は未実施。
- connector/src: CLI/setup/register/uninstall、harness、MCP/channelFor、daemon journal、API、画像upload、添付保存、hook adapter、runtime/profile/configを実コードから調査。外部aiterm-steer-deliveryの内部改修/全実装検証は対象外、公開adapterの入出力と契約が境界。
- web/src: App/router/store、HTTP/retry/SSE、DecisionView/回答/スワイプ、添付draft/preview、接続/pair/設定/login、i18n/format/typesを実コードから調査。辞書全件とCSS各ルールの再設計はまだしていない。
- tools/deploy・tools/e2e・workflow・Docker/compose: 入口と配布/試験接続を調査。全スクリプト内部の逐行調査と全OS×4ハーネス実機実行は未実施。source-indexには全追跡コード74ファイル/483宣言を載せ、未解析のPython/shellも隠さない。
- native approval-box-appsは対象外。[API v0.37](../api.md)の認証/Decision/添付/SSE/端末通知/診断/購入の契約までを外部接続として示す。Throughlineは製品の接続先ではなく作業記録の別製品で、改修対象外。

baseline: server93/connector36/Web単体7/ブラウザ18が成功。build/typecheckも成功。最初のブラウザ実行は既存browserのpath未指定で起動前失敗、既存のproject .cache/playwrightと共通OS依存を指定した通常実行で成功した。実測詳細は担当projectのdocs/approval-box/refactoring-20261102/baseline/。

[入口・caller・試験索引](current/interface-index.json)は静的routeと全相対import(試験を含む)、試験宣言の所在を持つ。整理対象が決まったら実callerを追加で検索し、動的接続を別途照合する。
