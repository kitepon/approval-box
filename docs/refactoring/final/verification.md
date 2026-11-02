# 候補の検証と未確認

Sol6.1 High、2026-11-02。runtime変更の最終commitはc19258f、shutdown試験5925da9、追加回帰試験97dd816。最終Astraの内容照合とレヴィアタンの成果確認は未完。本番未反映。

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

macOS/Windowsの本候補CI/実機、全OS×4harnessの実AI操作、Docker image build/実image隔離試験、実Appleログイン/購入/APNs、native apps内部の新受入は未実施。詳細と12組の表は[scope-notes](scope-notes.md)。当席にdocker実行入口がなくlocal distで公開契約を確認した。候補完成後の正規PR/CI経路は利用可能だが、まだpush/PRを行っておらず、CI成功とは扱わない。

既存の添付DB/FSの非原子的な停止窓、MCP親記録の読取失敗時fallback/open後保存失敗、配送unknownの本文無条件再送禁止は[flows](flows.md)に残す。新しい原子性や全障害からの回復を主張しない。翻訳品質全件/暗号アルゴリズムの独立監査は未実施。レヴィアタンへの報告と確認不足の修正、別2prompt予定の復帰は最終整合後に行う。
