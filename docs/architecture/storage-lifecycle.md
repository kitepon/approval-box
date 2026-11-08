# 保存と実行環境の機能・データフロー

実装前の設計。全体は[機能図](README.md)。現用501c880のdaemon-launchと全caller/testを確認してから、本書のログwriter変更を実装する。

## 常駐診断ログの所有窓口

ensureDaemon→launchDaemon→POSIX detached node、またはwindowsDaemonLaunchScript→pwsh/CIM→node。両者は共通daemonBootstrapで環境とprocess.argvを整え、CLIをimportする前からstderr.writeを同じbounded writerへ接続する。環境の転送範囲は従来どおり。配送journal・端末添付・設定・版runtimeには触れない。

writerはstate/daemon.log一個に直近最大1MiBを保存する。各呼出しでfileを開き、既存末尾を最大で「上限−新chunk長」だけ読み、新chunkも上限で切り、位置0へ書き戻し上限以下へtruncateしてcloseする。常駐にappend fdを渡さず、rename後の旧inodeへの増加を作らない。単一の長期稼働中もwriteごとに適用する。readerは利用者/doctor用の診断読取で、配送再送の判定には使わない。

単一writerでは時系列の末尾を保持する。同時起動時の診断の完全な順序/全行保存は保証しないが、位置指定の書込みとtruncateは各々1MiB以下とし、並行時にもfileの上限を超えない。世代やscratchを増やさない。途中強制終了でlogが部分書込みでも次writeで上限を適用する。既存の巨大logも全量をメモリへ読まない。

fileのopen/read/write/truncate失敗は元stderrへの短いbest effort通知にし、daemon本体へthrowしない。callbackを完了させ、log失敗が配送journalやdelivered/failed/unknownを変えない。import失敗も同writerで記録しexit1。node自体が起動できない場合の親errorは、同logに上限以下の失敗一件を記録し、従来のstderr通知を維持する。

## 生成・保存・複製と回収

### 設定とjournalの一時ファイル（0.1.30の実装前設計）

foxの標準setupで、通常fileの.claude.jsonへのrenameがEPERMとなり、writeJsonFileの専有.pid.tmpが残った。targetはArchive/readOnly=falseだが、Claudeだけの限定再試行も拒否された。OS側の原因は未特定で、保護変更やin-place上書きで迂回しない。config.ts writeJsonFileはharness設定・接続config・MCP親表・daemon lock/journalの共通writer。JSON→同directoryの.pid.tmp→rename確定、readerは各正規fileである。

0.1.29の共通writer一律回収を狭める。一度だけ受け取るconnection tokenと、結果不明のjournal/親表の唯一の新状態は復旧に必要なので、writeJsonFileの既定は従来のtemp保全へ戻す。harness.tsのsetMcpJson・setCursorPermissions・setCursorContextだけが、旧正規設定と登録入力から再生成できる設定としてdiscardTemporaryOnErrorを明示する。

この三callerでwriteまたはrenameが例外で終わった場合に、自分のその一時fileだけを回収し、元の例外をそのまま呼出元へ返す。回収自体が失敗した場合は短い診断を残し、元の保存失敗を隠さない。他PIDのtemp・正規file・唯一のjournalを消さず、書込みの再試行や配送の再送を追加しない。SIGKILL等でcatchが走らない場合は残るため、結果不明の古いtempを一括GCせず個別の保全確認を要する。

一時ファイル回収はlogのbest effort動作と異なり、正規状態の保存失敗を成功へ変えない。通常成功の一個の正規file、再生成設定のrename失敗時の旧対象保持/元エラー/専有temp0、既定の資格・不明状態のtemp保全を直接試験する。

| 入口/生成元 | 保存・reader | 正常終了 | 異常/不明と次入口 |
| --- | --- | --- | --- |
| npm build/connector esbuild | server dist、Web dist、bundle chunks/ライセンス | Web/esbuildは既出力を置換。source/lockを原本として保持 | 完了前の配布を成功扱いしない。次buildが同出力を置換 |
| cli.installRuntime/setup | home/runtime/version、harness設定の絶対path、動作中旧MCP/daemon | 同版を置換、設定backupOnceは一個 | 旧会話の参照が残るので旧runtime一括GCをしない。認証はcacheとして消さない |
| server Attachments/Decisions | SQLite＋添付原本、Web/native/AI | closed保持期間、下書き24h、part1h、孤立原本GC | DB参照ある原本を削除せず、強制終了のpartは次通常hourly GC |
| daemon saveAttachment | home/attachments、回答に書いたpathとget_attachment | hash一致を再利用、30日超はpruneAttachments | 保存失敗も本文配送は継続、get_attachmentを案内。唯一の資料は利用者が別保存 |
| server main cleanup/停止 | DB event/pairing/診断/決裁/添付、Web/API | hourly prune、SIGTERM/INTでabort→HTTP close→DB close | WAL/DBを容量理由で除去しない。利用者のpending/heldは保持 |
| 通常配備normal_entry | expectedrun/manifest/prepared-source.tar、complete/bundle/outbox、監査/復旧reader | commit＋policy＋変換recipe＋hashに結んだ耐久原本 | resultだけでoutbox終端としない。unknown/唯一archiveを保持し自動再配備しない |
| SSH payload/remote-change | /tmpの専有payload、src/src.old、製品image | EXIT trap回収。現用＋直前2imageを通常受入後に保持 | shell終了とremote実終端を区別。未確認payloadは使用者確認後のみ回収 |
| up.sh backup | 整合local staging→正規NAS.partial→確定directory、復旧reader | SHA/属性/SQLite確認・rename後local重複回収 | NAS不達/未完はstaging保持・次配備拒否。旧DBへ自動復元しない |
| 専有検証scratch | 署名archive/source/lock→展開tree・依存/cache→結果原本 | worker終端・未参照・必要証拠確定後、生成物だけ回収 | active/未完/ignored固有物/refを守る。旧実験は再開せず次入口で同じ終了条件を適用 |

当席専用の配備・保持helperの正本は `/srv/bellteam/bots/bot-4366a50b/docs/approval-box/storage-lifecycle-20261106.md` とそこから辿る既配備手順。製品repoへ別コピーを作らない。

## Windows Claude registration under rename denial

Owner selected product handling on 2026-11-08. Diesel established that ESET browser enhanced data protection denies the rename-target directory open for ancestors of protected browser profiles, including the default `.claude.json` directory. Earlier unknown-cause/no-in-place text above is historical. No protection setting changes are part of this repair.

| Function / caller | Input → output / owned state | Failure / recovery |
| --- | --- | --- |
| harness.setMcpJson (Claude register/unregister only) | Snapshot original UTF-8 JSON → merge only this product's MCP entry → normal writeJsonFile | Windows EPERM/EACCES after existing bounded rename retries permits writeJsonFileInPlace with the original snapshot. Cursor and other shared-writer callers keep atomic replacement only. |
| config.writeJsonFileInPlace | Prepared JSON + expected original (or absent) → same file handle, positional writes → fsync → truncate → fsync → readback | Open existing r+ without truncation; reject a changed original/path identity before any write. A new file uses exclusive wx. Save an exclusive UUID recovery copy of the exact existing bytes, mode0600, fsynced before modifying the target. |
| Error rollback / cleanup | Original bytes + same open handle → restore + fsync + truncate + fsync | A write/readback failure restores the original through the same handle, or removes only the newly created file. If rollback fails, preserve the recovery copy and report its path without content. Success or successful rollback removes its own recovery copy; normal temporary-file policy is unchanged. |

Data flow: setup/uninstall → Claude original snapshot → merge MCP entry → prepared sibling temp → bounded rename → success, or Windows permission denial → compare current original/path identity → durable original recovery copy → overwrite existing descriptor without an initial truncate → flush/truncate/flush → exact readback → remove own recovery copy. A snapshot conflict leaves the current file untouched; the next normal setup reads the new state and can finish without any protection change. This conflict protects another program's settings, not an unknown-state lock.

This fallback is not atomic and cannot lock out a foreign writer. A hard interruption during the direct write can require restoring the surviving UUID recovery copy; do not automatically discard these copies or overwrite a subsequently changed config. Caught write failures roll back immediately. The shared credential/parent/receiver/daemon journals never enter this weaker save path. No fallback to direct writing on EBUSY, other errors, or other platforms is introduced.

Partial setup connection metadata: cli.setup reads the existing `/connection` clients before registration. With `--only`, its `/connection/clients` PUT contains the union of that snapshot and the successfully selected clients, preserving unselected registrations. Full setup still reports its selected/detected list. Failed registration does not PUT a success list. Server/API schema and ownership are unchanged.
