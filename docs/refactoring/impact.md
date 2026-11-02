# 変更の到達範囲

基準90066748/現状図aae6046。[設計](design.md)のH1/H2/M1/L1に対する実装前の到達表。静的importは[current/interface-index.json](current/interface-index.json)、宣言は[current/source-index.json](current/source-index.json)から全件を照合し、動的import・CLI経由はrepo検索で補った。実装直前と終了時にも同じsymbol/pathを検索し、追加callerがあればここを更新する。

## HTTP（H1/H2）

- 実装: `packages/server/src/http.ts`。追加先は`http/{types,public,user,connector,common,streams}.ts`。
- 既存export: `createApp`と`Services`を同じ`http.ts`から提供。HTTP helperは現状privateなので、移動先で必要なものだけnamed exportする。公開package entryは`dist/main.js`のまま。
- 実行caller: `packages/server/src/main.ts`、`tools/e2e/parent-e2e.mjs`。`createApp`の引数/optional Services/staticHandlerを維持するため、importの書換え不要。
- 直接試験caller（11ファイル）: `packages/server/test/{account-deletion,api,appstore,attachments,connector-auth,decision-summary,diagnostics,locale,remote-mcp,request-images,shutdown}.test.ts`。各`setup`やインメモリDB/鍵/添付fixtureは現状のcreateAppから構築する。新routerを直接組み立てるfixtureへ差し替えない。
- 間接回帰試験: `db.test.ts`、`push.test.ts`、`callbridge-retry.test.ts`、`start-with-secrets.test.ts`。domainは移動しないが、commit後イベント・配送・起動との接続を最終server全件で確認する。
- API consumer: Webの`api.ts`/`idlogin.tsx`/`App`/pages、connectorの`Api`/`runMcp`/`runDaemon`/CLI pairとsetup、remote MCP、native appsの`docs/api.md`。認証・path・method・body・binary header・SSEを維持するのでcallerを改修しない。
- admin consumer: `tools/deploy/diagnostics-admin.py`、`diagnostic-trigger-smoke.mjs`と既存管理契約。LAN+tokenを利用者sessionへ変更しない。
- 配布/fixtureの接続: root`Dockerfile`、`packages/server/{package.json,tsconfig.json}`、`.github/workflows/e2e-preflight.yml`、`tools/deploy/server-image-smoke.cjs`。src内分割なのでcopy/rootDir/dist entryを変更しない。
- 新規/拡張試験: 既存`connector-auth.test.ts`へsessionとconnectionの相互誤用、未知route/static fallbackを追加。`shutdown.test.ts`へconnection SSEと例外cleanupを追加。必要なら読みやすさのため`http-routing.test.ts`/`streams.test.ts`へ分けるが、同じassertを複製しない。

### 全routeの対応

`design/route-map.json`は現状の72静的登録（mount/use/fallbackも含む）を欠落なく持ち、各登録の移動先を記録する。72をHTTP endpoint数とは呼ばない。`app.on([GET,DELETE], '/mcp', …)`のpathとadmin resolve/reopenの動的展開は別注記で補う。root登録順と具体route順は[設計](design.md#h1httpの登録と状態所有)に従う。

認証はrouteの名前の部分一致で除外しない。公開pairing2経路が先にmatchし、未一致は必ずconn middlewareへ進む。userとconnのcatch-allはstaticより先。APIのJSON404と認証前の401、remote MCPの405、Apple callbackの303を区別して確認する。

## 親会話（M1）

- 移動元: `packages/connector/src/mcp.ts`内の`Harness/harnessOf`、親channel管理の連続した節。
- 追加先: `packages/connector/src/parent-channels.ts`。mcp→parent-channels→steer/claude-channel/config/profileという一方向。parent-channelsからmcpへruntime importしない。
- `harnessOf`の実callerは`runMcp`のCallTool handler。既存exportは再exportで維持。
- `channelFor`の全callerは`request_decision`、`amend_decision`、`resume_decision`、`setup_test`の4か所。各順序は[設計](design.md#m1親会話とmcp応答の分離)に固定。
- `lastChannel`の全readはCallTool handler冒頭のquery生成、全writeは上記4tool。同じmoduleの寿命を保持する。
- MCP直接起動: `packages/connector/src/cli.ts`の`mcp`分岐→`runMcp`、`packages/connector/test/codex-acceptance.test.ts`の生成子プロセスscript→`runMcp`。
- CLI経由のconsumer: `tools/e2e/{parent-e2e,session-routing-smoke,session-routing-production}.mjs`、harness登録とversioned runtime、`tools/e2e/parent-preflight.test.mjs`。ツールの名前・schema・案内、stdoutのMCP通信、runtime entryは維持。
- 既存試験: `codex-acceptance`、`claude-channel`、`claude-hook`、`cursor-binding`、`session-routing`、`channel-delivery`、`aiterm-provider`、`daemon`、`daemon-launch`、`instructions`、`api`、`request-images`、`attachments`。いずれも`packages/connector/test/*.test.ts`。親識別の直接回帰は`parent-channels.test.ts`へ必要最小限を追加し、MCP失敗時のlastChannelは既存stdio fixtureを拡張する。
- fixture: 個別testが一時`APPROVAL_BOX_HOME`に作るconfig/parents/channel/daemon lock、Codex metadataのthreadId、Claude parent/process情報、Cursor hook記録。実ユーザーのstateRoot/親設定を使わない。
- build/export: `packages/connector/scripts/build.mjs`はCLIから新moduleをbundleする。entry4本、分割chunks、version注入、license収録、package files、Node20 targetを変更しない。`runMcp/named/SPEAK_BY_TITLE/Harness/harnessOf`の既存exportを維持。
- 除外: 外部`aiterm-steer-delivery`の内部、native apps、実ホストの再起動/設定変更。新しいschema/options、親channelの自動削除、journal migrationを追加しない。

## 言語と固定文（L1）

| 現在の定義 | 新しい所有者 | 全直接callerと変更 |
|---|---|---|
| server/src/locales.ts | server/src/shared/locales.ts | serverのaccounts/locale/onboarding/push/errors/http（H1後はuser）を更新 |
| web/src/locales.ts | 同上の一つの定義 | web/src/i18n.tsのimportとLocale再exportを更新、重複ファイル削除 |
| server/src/error-messages-en.ts | shared/error-messages-en.ts | errors→error-translationsへ接続、server/test/locale.test.tsのimport更新 |
| server/src/error-messages-east-asian.ts | shared/error-messages-east-asian.ts | 同上。ko/Hans/Hantの辞書内容と順序を保持 |
| server/src/errors.tsのfixedErrorTranslation | shared/error-translations.ts | web/src/i18n.tsが新moduleを直接import。旧errorsからのこのexportは内部caller全更新後に除く |
| errors.tsのErrorCode/fallback/文言選択 | shared/error-translations.ts | ApiError.bodyのみ純粋なerrorMessageへ委譲。ErrorCodeはerrorsからのtype再exportを保つ |
| ApiError/statusOf | server/src/errors.tsのまま | accounts/appstore/attachments/decisions/diagnostics/oidc/remote-mcp/httpとserver/test/localeは同じclassを使う |

shared内はlocaleと辞書だけを相互importする。Webのi18nからserver/errorsへのimportは消える。Webのmessages/messages-east-asianとUI処理、serverのonboarding/pushの固定案内は今回移動しない。辞書の内容を改善する翻訳作業を混ぜない。

試験はserver`locale.test.ts`（辞書import移動、API・端末・移行・通知）、web`i18n.test.ts`（言語選択・既知文・自由文・補間）、browser`localization.spec.ts`と`swipe.spec.ts`。すでに有効な試験を移動先へ機械的に合わせて無効化しない。新しい共通定義への依存が純粋であることはimport graphとWeb build出力で確認する。

serverの`rootDir=src`、`outDir=dist`、main/bin、Web Viteの入力、Dockerのserver/Web copy、npm workspace数、root lockは変えない。共通辞書をserverとWebへ別々に生成/コピーする工程は作らない。

## 最終の全範囲照合（D1/A1）

`git ls-files`を起点に、src/test/fixture/script/config/workflow/asset/docs/licenseごとの役割を一つのscope表に載せる。現状indexの対象外だった`.cjs`/shell/Pythonとworkflowや公開HTMLも実装担当が読む。ツールの実行が本番API・実AI・秘密へ触れる場合はコード読取と隔離fixtureまでを明示し、実行済みに補完しない。

現状8図・flows・code-indexはbaselineとして残す。finalの8図・flows・source/interface index・コード対応へ新ファイルと移動symbolを反映し、旧ファイルへの参照漏れ、壊れたリンク、caller/routeの抜けを確認する。各図の描画物と目視結果、試験の実行環境/exit/件数/失敗の解決を残す。最終報告は設計と実装の差も説明する。
