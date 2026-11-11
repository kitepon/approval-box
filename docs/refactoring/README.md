# Approval Box 機能図と責任の対応

基準main90066748。Sol Highの調査・実装と、Astra xhighの図・責務・コード照合を終えた候補。正規CIの全5ジョブも成功し、[draft PR15](https://github.com/kitepon/approval-box/pull/15)で成果確認を進める。本番未反映。構造整理と、SSE失敗時の後始末修理は別commit/工程であり、全差分を振る舞い不変とは扱わない。

読む順序は[最終候補の全体図](final/overview.svg) → 下記の機能詳細 → [責任・異常経路](final/flows.md) → [全コード・関数](final/code-index.md)。[全追跡ファイル](final/scope.md)と[運用・資産・未確認](final/scope-notes.md)も参照する。

| 機能 | 描画済みSVG | Mermaid原本 |
|---|---|---|
| 全体と境界 | [全体](final/overview.svg) | [原本](final/overview.mmd) |
| ログイン・端末接続 | [認証](final/identity.svg) | [原本](final/identity.mmd) |
| 申請・回答・取消 | [申請](final/decisions.svg) | [原本](final/decisions.mmd) |
| 申請画像・回答添付 | [ファイル](final/attachments.svg) | [原本](final/attachments.mmd) |
| 回答配送・不明結果 | [配送](final/delivery.svg) | [原本](final/delivery.mmd) |
| 更新通知・画面反映 | [通知](final/events.svg) | [原本](final/events.mmd) |
| 診断・購入・言語 | [運用](final/operations.svg) | [原本](final/operations.mmd) |
| 導入・停止・配布 | [実行環境](final/runtime.svg) | [原本](final/runtime.mmd) |

[設計・代替案・採否](design.md)、[caller/test/fixture/exportへの影響](impact.md)、[試験計画](verification-plan.md)、[実装と修理の記録](implementation.md)、[候補検証と未確認](final/verification.md)を残した。構造詳細は[HTTP](design/http.svg)・[親会話](design/parent-channels.svg)・[言語](design/localization.svg)の描画図も参照できる。

`current/`は改善前の8図・flows・索引。基準コードへ再照合し、ログアウト/削除・配送失敗・通知所有者の説明誤りも補正した。baselineの実装は変更していない。`final/`は実装候補に同期した8図と全コード対応。全19図のSVG/PNGと[描画hash](final/render-check.json)を保存し、Solで目視した。Astraでは意味の誤りを補正し、変更した図を再描画して確認した。

対象はserver/API/保存/Web/MCP/connector/画像とrepo内の構築・運用・試験接続全域。native appsは[API v0.37](../api.md)の契約まで、外部Steer/Aiterm/Bridgeはadapter契約まで。Throughline/ホスト管理は担当外。

再生成はrepo rootで`node docs/refactoring/refresh-index.mjs`、保持条件の照合は`node docs/refactoring/verify-contracts.mjs`。描画環境はBot projectの`integrations/mermaid/`（CLI12.0.0とlock、既存Chromium）に固定し、`render.sh`で全19図を再描画・PNG取得する。製品runtime依存には追加していない。
