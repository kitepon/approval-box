# 実装・最終整合の検証計画

設計段階。以下は予定であり、結果ではない。baseline原本は担当projectの`docs/approval-box/refactoring-20261102/baseline/`。server93、connector36、Web単体7、browser18、preflight4、build/typecheckが成功済み。設計書だけの変更では同じ製品試験を再走しない。

## 段階ごとの確認

| 段階 | 操作・比較 | 成功条件/残す根拠 |
|---|---|---|
| H1 | createApp経由の全server試験、server typecheck、全route対応と登録順レビュー | endpoint/method/auth/status/JSON/binary/SSE/特定fallbackがbaselineどおり。移動前後のroute-mapを比較 |
| H2 | userとconnectionのstreamを隔離fixtureで開き、通常通知、client abort、事前/途中shutdown、送信時例外を確認 | queue順/id重複除外とpending通知を維持。終了後EventHub subscriberとshutdown listenerが残らず、timer待ちを閉じる。例外を成功に変えない |
| M1 | 全connector試験、typecheck/build、4harness preflight、追加した親/lastChannelの回帰試験 | 親が混ざらない、記録の寿命/更新順が不変、MCPのschema/本文/structuredContent/エラーが不変、bundle起動成功 |
| L1 | server locale、Web単体、Web browser、server/Web typecheckとbuild | 5 localeの文字列/順序/既知エラー選択を維持、自由文は原文、browserからserver例外/Node importが無い |
| D1 | 同じ最終treeでnpm test、Web単体/browser、全build/typecheck、必要preflightと配布物の隔離起動 | 最終変更に対する一組の成功ログ。異なるcommitの結果を混ぜない。追加変更が無ければ反復しない |
| A1 | Astra xhigh適用後、描画物と全ファイル/route/状態の照合 | 下記完了表に根拠と未確認を記載し、レヴィアタンへ候補を返却 |

## 追加試験の最小範囲

### HTTPとSSE

既存試験を活かし、抽出によって落ちやすい境界にだけassertを加える。

- 利用者sessionはconnectorへ入れず、connection tokenはuser APIへ入れない。未知APIも認証を通り、認証後はJSON404。staticはAPIへHTMLを返さない。
- 公開auth/config、署名検証するApple通知、pairingの正確な2経路を認証必須routerが遮らない。callbackの303とMCP GET/DELETEの405/Allowを保持する。
- 同一idempotency keyの成功/4xx応答を言語も含め再生。別route利用の拒否、5xx/rate_limitedの非保存、一度返すtokenに保存helperを適用しないことを確認する。既存api/locale試験で網羅する項目は追加しない。
- SSEはEventHubのsubscribe/subscribeConnectionの解除を数えられる小さなfixtureとAbortSignalのlistener監視で確認する。Honoの通常stream経路で再現可能な切断を優先し、必要な例外注入はstream関数の実際の書込点へ限定する。試験のための製品用optionsや汎用transportを増やさない。
- H2の変更前にloop内例外時のcleanup不足を確認し、変更後に同じassertが通る記録を残す。環境のHonoが書込例外を内部処理する場合、外部から失敗を観測できる箇所を実装担当が特定する。実際の発生が確認できなければ本番の故障解消と表現しない。

### 親会話

- 同Codex home/threadでchannel再利用、別thread/homeで分離、closedなら新規。MCP再起動後に永続記録を再利用。metadata欠測でAPI申請を送らない。
- Claudeの同session/同processとprocess変更、/clear後の新sessionを区別し、旧channelを閉じない。既存claude-channel試験と重なるassertは増やさない。
- Cursorはverifyを先に行いprocess内Map、Grok/otherはbackgroundのMapを使う。永続parentsへ保存しない。root/profileを隔離し、実AI・実ホスト設定を使わない。
- request/setup失敗時はchannel取得済みならlastChannel更新済み。amend/resume失敗時は前の値を保つ。list/getのqueryをMCP stdio→偽HTTP serverで観測する。amend画像失敗が親特定より先である順序も保持する。
- 親記録の保存エラーを成功へしない。API結果不明でrequest POSTを自動再送しない。daemon/aiterm-providerの既存unknown・reroute・withdraw・fetched試験を通す。

### localeと辞書

- 旧二localeファイルの一致と移動後の単一定義を確認。ja/en/ko、zh script優先、地域、未知言語、空入力を既存testに対して確認する。
- 辞書2ファイルの移動前後の内容hashを比較する。generic fallback・fixedErrorTranslationの反復順・ApiErrorのextra上書き順をdiffで確認する。
- HTTPは既知のja key→訳文/未知message→code fallback、Webは既知の各言語文→選択言語/未知自由文→原文。APIの受け取った任意翻訳文をWebと同じ逆引きへ変えない。
- 全5 localeでerror code/status/extra/Retry-Afterが不変、補間の名前・$&・markup・本文・IDが原文。既存i18n/localeで網羅済みのassertは再利用する。

## コマンドと隔離

作業場所は専用worktree。結果は担当projectの`docs/approval-box/refactoring-20261102/validation/`にstdout/stderr/exit/開始終了時刻と対象commitを保存し、repo内の最終検証記録から参照する。製品コードの試験は既存のnpm scriptsを使う。

```sh
npm test
npm run test:web
npm run typecheck
npm run build
npm run test:web:browser
node --test tools/e2e/parent-preflight.test.mjs
```

browserはbaselineと同じBot projectの`.cache/playwright`と共通Chromiumの環境設定を使う。正確な設定はbaseline/browser-configured.logとBotのenvironmentを照合する。初回にbrowserが見つからなかった失敗を製品不良として数えない。依存が要る時はproject内の正規setupに記録し、OSを変更しない。

serverのdistは本番データ/秘密を使わず一時data/Web directoryで起動し、既存`tools/deploy/server-image-smoke.cjs`の対象pathとJSON/HTML境界を確認する。imageの確認は既存CIの`checks`/runtime buildと隔離smokeが利用可能な経路で行い、未実行なら理由を記す。main-serverの停止/再起動、実ユーザー申請、購入、APNs実送信、実AIの親操作で代用しない。

## OSとハーネス

既存`.github/workflows/e2e-preflight.yml`はmacOS/Linux/Windowsそれぞれで4harnessの登録・起動前処理を確認する。今回の候補で実際に走ったrunとcommitを記録する。CI定義があることを実行成功へ読み替えない。候補完成後、既存のPR/CI経路で必要確認を進める。

| OS | Claude Code | Codex | Grok | Cursor |
|---|---|---|---|---|
| Linux | unit/preflight予定、実AI未実施 | unit/preflight予定、実AI未実施 | unit/preflight予定、実AI未実施 | unit/preflight予定、実AI未実施 |
| macOS | CI preflight予定、実機未実施 | CI preflight予定、実機未実施 | CI preflight予定、実機未実施 | CI preflight予定、実機未実施 |
| Windows | CI preflight予定、実機未実施 | CI preflight予定、実機未実施 | CI preflight予定、実機未実施 | CI preflight予定、実機未実施 |

12組の最終欄は「確認済みの内容/証拠」と「未確認/非適用理由」を書く。実AI操作の未確認を隠さず、同じLinux結果を別OSへ複写しない。Apple認証/StoreKit/APNsはnative契約とserver fixtureまで、native apps改修はベルの担当。外部steer/Aiterm・Throughline・ホストの内部変更は行わない。

## 図とコードの最終照合

- 現状図8枚をbaselineとして保持。finalの全体図→機能別7詳細図→flows→全ファイル/symbol/routeのindexを相互にリンクする。
- 新moduleの所有状態と副作用、成功と失敗の返却先を図に入れる。H1/H2/M1/L1を含め、申請/回答/画像/配送/認証/通知/課金/診断/導入/停止のいずれも飛ばさない。
- `git ls-files`とscope表を照合し、TS/MJSだけでなくPython/shell/CJS/workflow/config/公開HTML・CSS/fixtureも役割と参照を持つ。辞書全件の翻訳品質監査や暗号アルゴリズムの独立監査など、実施しない内容は別に明記する。
- Mermaidを実際に描画する。適切なrendererが無い場合はBot project内へ正規依存として追加し、版と再現コマンドを残す。SVGに加え必要に応じPNGを用意し、全図を目視する。文字切れ、重なり、読めない密度、凡例/矢印の意味を確認し、問題のある図は分ける。
- route-mapはmount/use/fallbackを含む一覧として照合。最終source hashとsymbol位置を更新し、存在しないファイル/関数リンクをゼロにする。動的tool handler、CLI/generated子script、CIとDockerの接続は静的indexとは別に照合する。
- 最終Astraは実装diff、図、コード、試験根拠を読み、取引/認証/終了処理/不明結果の扱いが設計と一致するか確認する。差があれば修正工程を持つ。

最終報告はbranch/commit/diff、絶対成果物path、描画済み図、改善理由、試験結果、未確認と既知の制限、本番未反映をレヴィアタンへ一通で返す。確認不足を解消してから、保留2予定を完了後日時へ戻す。
