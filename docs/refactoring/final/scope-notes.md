# 運用・資産・試験の責任と接続

全追跡ファイルは[scope](scope.md)、実行ソース・関数・importは[code-index](code-index.md)。HTTPの72登録は[interface-index](interface-index.json)。未解析ファイルを一覧から除いていない。TSの型/関数とPython/shellの入口を含めた静的索引であり、動的接続は下記で補う。

## 運用・試験ツール

| ファイル | 呼出し元 / 受渡し / 副作用と失敗・終了 |
|---|---|
| tools/deploy/block-public-admin.py | 主機の運用者が実行するCaddy管理窓口遮断。単一vhost検証→控え→設定追加→validate/reload。失敗で旧設定を復元/reloadしエラー終了。コード読取のみ、主機へ実行していない |
| tools/deploy/diagnostics-admin.py | 運用者がevent UUID/actionと環境の専用鍵を与える。LAN admin GETで最新eventを特定、resolve/reopen時だけPOST→GET照合。入力/action/鍵/対象なし/HTTP例外で停止。key値を出力しない。今回実行なし |
| tools/deploy/diagnostic-trigger-smoke.mjs | 稼働container専用の合成診断試験。使い捨てuser/session→診断受付/重複/409/400→DB原本/admin GET/resolve。finallyで本人削除と記録削除/401を照合。本番書込を伴うため今回実行なし |
| tools/deploy/start-with-secrets.sh | Docker entrypoint。SECRETS_DIR指定時は600ファイルへ鍵を移し環境の値を外してexec。書込失敗は変数名とpathだけを出して起動中止。既存5試験で確認 |
| tools/deploy/node-release/install.sh | Docker build段階。TARGETARCHを固定対応表で検証、公式Node archive→verify→展開、固定npm archiveのSHA512を照合。trapで一時file削除。不一致でset -e停止。正規CI run41402647664でchecks/runtime image成功 |
| tools/deploy/node-release/verify.sh | gpgvを一時homedir+同梱keyringで実行、署名fingerprint固定、唯一の対象名とarchive SHA256を照合。利用者GPG設定は使わない。trap cleanup |
| tools/deploy/node-release/test-verification.sh | CIが公式archiveを渡す。正常検証後、偽archive/改変署名を拒否することをassert。Node定義の変更なし、正規CI run41402647664で正常と改変拒否を確認 |
| tools/deploy/server-image-smoke.cjs | CI runtime image内でtmpfsの使い捨てDBを起動。公開頁/401/MCPの6経路→SIGTERM→8秒で強制終了/失敗。imageのentry/path固定。local distで7経路を隔離実行し、正規CI run41402647664では実runtime imageでも成功 |
| tools/e2e/bundle.mjs | parent-e2eとserver依存をNode22向け1ファイルへ束ねる。出力path必須。配布試験用で製品entryには含めない |
| tools/e2e/claude-binary.mjs | parent-e2eから呼ぶ。Windowsはclaude.cmd、他OSは試験PATHの絶対pathを得てshell引用。見つからなければprocess停止操作の前に例外 |
| tools/e2e/parent-e2e.mjs | 4harness引数を検証→隔離DB/connection/project設定→外部Aiterm経由で実AIへ申請/回答。idle/busy/burst/setupとClaude再起動を確認。再起動はpid+開始identity/既存process除外で対象を検証。finallyで試験session/daemonを閉じconfig控え復元、残processを報告。今回はコード読取と起動前検査まで、実AI操作なし |
| tools/e2e/parent-preflight.test.mjs | parent-e2eのAiterm transportを偽にしagent_launchを必ず拒否。4harnessの設定/隔離/登録と失敗終了/cleanupを確認。モデルを起動しない。Linux/macOS/Windows各4件が正規CI run41402647664で成功 |
| tools/e2e/codex-consumer-migration.mjs | 明示隔離rootでCodex公式APIのhook trust/stateを読み、製品専用hookだけ撤去、他設定不変と繰返しを検証。envをfinally復元/試験root除去。今回はコード読取のみ、実Codex管理APIは起動していない |
| tools/e2e/session-routing-smoke.mjs | bundle済CLIのMCPを偽HTTPへ接続。amend/resumeが別processのchannelを使い受信案内を返すことをassert。finallyでclient/試験daemon/server/rootを閉じる |
| tools/e2e/session-routing-production.mjs | 指定隔離accountの実本番pairing/amend/answer/delivery/resumeを確認しfinallyで本人削除/401/daemon停止。今回実行なし |
| docs/refactoring/refresh-index.mjs | このrepoの関数/import/route/test/scopeを再生成。source hashを保存し、元72登録のmultiset一致をassert。ファイル順/commitを記録。製品build/runtimeからは呼ばない |

管理用の主機設定変更はホスト担当との既存境界を保つ。これらのコード読取から運用操作の許可を追加しない。外部Steer/Aiterm/Bridgeの内部全域やThroughlineを本製品の調査済み範囲へ含めない。

## 構築と配布

root package.jsonは3workspaceのbuild/typecheck/testとWeb/browser試験を接続する。package-lock.jsonは外部依存版・integrity、tsconfig.baseと各tsconfigは既存NodeNext/strict/erasable設定とserver src→dist、WebはBundler/noEmit。server package bin=dist/main.js、connector bin=dist/cli.mjs、connector build.mjsは4entryと共通chunks、Node20 targetとlicense収録を持つ。Web ViteはPreact/開発proxy/build distを持つ。今回これらの契約変更なし。

Dockerfileは公式署名検証Node→server/Web build→production依存prune→非root/read-only runtimeとchecks段階。compose.yamlはloopback既定port、named data volume、tmpfs、cap-drop/no-new-privileges、環境から各serviceへ接続する。停止・再起動・鍵の受渡しの現状は[実行図](runtime.svg)。

.github/workflows/e2e-preflight.ymlはpush main/PRで3OS起動前検査、browser、Node署名とserver imageを実行する。publish-connector.ymlはconnector-vタグとpackage版の一致→typecheck/test/build→OIDC npm publish、同公開はcancel-in-progress=false。今回はtag/公開/本番配備なし。正規CI run41402647664で3OS・browser・server-imageの全5job成功を確認した。

.gitignoreはnode_modules/dist/DB/env/coverage/browser結果を除外し、AGENTS.mdは通信不良/復帰/不明結果の扱い、README/CHANGELOG/API/診断/connector routing文書は公開契約・運用手順を持つ。license/THIRD_PARTY_NOTICESは配布条件。Apple certsとNode keyring/署名manifestは署名検証の入力資産であり、今回更新していない。

## Webと静的資産

web/index.htmlとsrc/main.tsxがappを起動しrouter/store/api/各pageを接続する。style.cssはlight/dark tokens、760px幅/safe-area/nav、申請カード/回答/配送状態/添付/画像overlay/言語選択とresponsive幅を持つ。swipeはDecisionViewで制御しCSSへ隠れていない。UI状態/入力保持/abort/foreground/SSEは[flows](flows.md)。

public/privacy.htmlとsupport.htmlは日英の公開説明、legal.cssはそのlight/dark/responsive体裁、icon.svg/manifest.webmanifestはfavicon/PWA表示の資産。main.staticHandlerがprivacy/supportの.htmlとSPA fallbackを返す。APIの未知pathは先に認証/JSON404へ進む。CSP・Content-Disposition付き添付はstaticで返さない。翻訳辞書/messagesとUI型/formatの関係は[診断・言語図](operations.svg)と[コード索引](code-index.md)。

全辞書entryの翻訳品質、全CSS組合せの見た目、Apple証明書/暗号アルゴリズムの独立監査は今回の確認対象外。locale定義と固定文移動はbyte保持/既知文と自由文を区別する既存試験で確認した。既知の製品未実装はGoogle Play/Stripe/FCM/Web Pushで、実装済みとは扱わない。

## 確認範囲

| OS | Claude Code | Codex | Grok | Cursor |
|---|---|---|---|---|
| Linux | CI起動前検査成功・実AI未実施 | CI起動前検査/adapter fixture成功・実AI未実施 | CI起動前検査/配送fixture成功・実AI未実施 | CI起動前検査/bind fixture成功・実AI未実施 |
| macOS | CI起動前検査成功・実AI/実機未実施 | CI起動前検査成功・実AI/実機未実施 | CI起動前検査成功・実AI/実機未実施 | CI起動前検査成功・実AI/実機未実施 |
| Windows | CI起動前検査成功・実AI/実機未実施 | CI起動前検査成功・実AI/実機未実施 | CI起動前検査成功・実AI/実機未実施 | CI起動前検査成功・実AI/実機未実施 |

macOS/Windowsの機能対応は既存cross-platform実装を保っている。Linuxの成功を他OSの実測へ複写しない。実Apple認証/購入/APNs送信、native apps内部の新改修/実機受入は未実施。Docker実行入口は当席にないが、正規CIでimage build/隔離起動/終了を確認した。local distの公開頁/401/未知API/MCPと正常SIGTERMは使い捨てdata/秘密を渡さない環境で成功した。上の12欄はhead f1e16f7に対するrun41402647664の結果。詳細は[最終検証記録](verification.md#正規ci)。
