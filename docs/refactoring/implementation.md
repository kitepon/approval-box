# 実装工程の記録

2026-11-02、Sol6.1 High、fast OFF。設計4c04cd2から専用worktreeで実装した。本番反映は行っていない。D1の最終図・全域scopeを追加し、Astra xhighで図とコードを照合した。最新の結果は[最終検証記録](final/verification.md)を参照。

| commit | 変更と理由 | 確認 |
|---|---|---|
| ce91fa3 | HTTPをpublic/user/connectorに分け、rootの登録順とエラー処理を残した。型・共通helper・SSEを各所有ファイルへ移した | server typecheck、既存server試験、追加認証境界試験。最終全件結果は下記 |
| 9b55bf6 | 両SSEのloopをfinallyで囲み、切断/停止後に待機へ入らないようにした | 送信例外・client abort・shutdown・事前shutdown×2streamの8件で購読とshutdown listener解放 |
| 137028d | parent-channelsへ親識別/再利用/記録を移動。lastChannelと更新時点はmcp.tsに維持 | 既存connector36件、追加1件でCodex thread分離・process再起動後再利用・親不明拒否・backgroundの非永続記録・harness判定 |
| c19258f | sharedへlocaleと固定エラー翻訳を移動。Webからserver例外型への直接importを除去 | 全体typecheck、Web7件、server locale7件、build、browser18件、Linuxの4harness preflight |
| 5925da9 | shutdown試験のtimeout後にreaderをcancel/releaseし、timerを解除 | 強制終了オプションなしの通常npm testがserver102件/connector37件で完走 |

## SSEの再現と修理

これは構造整理と分けた修理工程である。ce91fa3/137028d/c19258fは責務と配置の整理、9b55bf6は既存の失敗時の挙動を変えるfix、5925da9は試験fixtureの後始末修理。全差分を振る舞い不変のリファクタリングとは扱わない。レヴィアタンの11/2巡回でこの区別を再確認した。以後の新たな修理も別工程/commitにする。

構造整理の採用条件は公開契約・状態/保存順序・既存失敗の返却を保つこと。SSE修理の採用条件は、同じ反例で購読/listenerが解放され、正常な通知/停止を保つこと。修理前後の8試験と通常server全件の成功を確認した候補として保持する。本番採用・停止・再起動の許可へは拡張しない。

切出し直後のコードに対し、実際のHono `SSEStreamingApi.writeSSE`へ失敗を注入し、user/connection両方で購読が残ることを確認した。client abortの時にもshutdown listenerが残った。後者は書込をawait中にabortし、wakeが未設定のまま、その後新しい待機へ進む経路だった。

finallyでlistener/購読を解除し、待機前にabort/shutdownを再確認する。通知の順序、event id、pending合図、heartbeat、取引と再送判断は維持。修理前後を同じ8試験で照合した。実環境での本障害の発生・回復を確認したという意味ではない。

## 通常試験の終了待ち

旧shutdown.testの`readToEnd`はreaderを取得したままtimeoutで抜け、外から`response.body.cancel()`を呼んでもlock中のため失敗し、catchで隠していた。helper自身のfinallyでreaderを閉じる形へ直した。`npm test`を一度中断した記録と、修正後の完走結果を区別する。

初期の`--test-force-exit`付き試験には、通常実行より少ない件数でexit0になったものがあった。そのログを全件完了の根拠には使わない。実装直後の根拠はforceなしの`full-unit.log`（server102/connector37、両fail0、command exit0）。追加回帰97dd816後は`d1-unit.log`でserver103/connector38、exit0を確認した。既存baselineの件数を改修後成功件数へ足していない。

## 保存した検証原本

担当project絶対path: `/srv/bellteam/bots/bot-4366a50b/docs/approval-box/refactoring-20261102/validation/`。2026-11-02 06:12〜06:19Zに実行、Node v26.13.0。最終unitの実行treeはruntime c19258fと後に5925da9へ保存した試験fixture修正。

- `h2-before.log`: SSE回帰試験の修理前失敗。
- `h2-after.log`: 同じ8件の成功。
- `m1-connector.log`: 親切出し後、既存36件の成功。追加親試験はその後単独で成功。
- `l1-build.log`: server/Web/connector build成功。
- `l1-browser.log`: browser18件成功。既存project `.cache/playwright`と共通chromium/env.shで実行。
- `l1-preflight.log`: LinuxのClaude Code/Codex/Grok/Cursorの4件成功（実AI起動なし）。
- `c19258f-npm-test.log`: helper修正前の終了待ちを中断、exit130。成功扱いしない。
- `full-unit.log`: helper修正後、通常npm test、server102/connector37、exit0。
- 全workspace typecheck、Web単体7件、server locale7件、追加認証4件と親1件はツール出力で成功を確認した。最終検証記録へ必要な原本を結び直す。

locale/翻訳辞書3ファイルは移動前のbyteと一致することをassertした。API v0.37/DB9/公開CLIとMCP契約/配送journal/添付DB-FS順序は変更していない。DB migration・新workspace・新runtime依存は追加していない。

## 残る確認と成果物

D1で元72登録、全追跡233ファイル、全caller/export、親分岐の本体保持とlastChannel失敗時、idempotencyを照合した。最終8図・全コード索引と19図の実描画、配布物の隔離起動も完了した。97dd816はMCP文脈とHTTP冪等性の追加回帰試験で、製品コードの修理を含まない。Astraの補正は図と説明に限る。正規CIとレヴィアタンの成果確認は引き続き進める。実Apple/購入/APNs/実AI×全OSの未確認は最終検証記録で区別する。

実装の段階commitは候補であり、専任任務の完了報告はまだ行っていない。レヴィアタンの確認と不足修正後に別2prompt予定を復帰する。
