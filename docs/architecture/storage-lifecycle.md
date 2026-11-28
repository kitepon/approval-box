# 保存と実行環境の機能・データフロー

実装前の設計。全体は[機能図](README.md)。現用501c880のdaemon-launchと全caller/testを確認してから、本書のログwriter変更を実装する。

## 常駐診断ログの所有窓口

ensureDaemon→launchDaemon→POSIX detached node、またはwindowsDaemonLaunchScript→pwsh/CIM→node。両者は共通daemonBootstrapで環境とprocess.argvを整え、CLIをimportする前からstderr.writeを同じbounded writerへ接続する。環境の転送範囲は従来どおり。配送journal・端末添付・設定・版runtimeには触れない。

writerはstate/daemon.log一個に直近最大1MiBを保存する。各呼出しでfileを開き、既存末尾を最大で「上限−新chunk長」だけ読み、新chunkも上限で切り、位置0へ書き戻し上限以下へtruncateしてcloseする。常駐にappend fdを渡さず、rename後の旧inodeへの増加を作らない。単一の長期稼働中もwriteごとに適用する。readerは利用者/doctor用の診断読取で、配送再送の判定には使わない。

単一writerでは時系列の末尾を保持する。同時起動時の診断の完全な順序/全行保存は保証しないが、位置指定の書込みとtruncateは各々1MiB以下とし、並行時にもfileの上限を超えない。世代やscratchを増やさない。途中強制終了でlogが部分書込みでも次writeで上限を適用する。既存の巨大logも全量をメモリへ読まない。

fileのopen/read/write/truncate失敗は元stderrへの短いbest effort通知にし、daemon本体へthrowしない。callbackを完了させ、log失敗が配送journalやdelivered/failed/unknownを変えない。import失敗も同writerで記録しexit1。node自体が起動できない場合の親errorは、同logに上限以下の失敗一件を記録し、従来のstderr通知を維持する。

## Sealed content and decided requests (e02, 2026-11-28)

Design: `/srv/bellteam/bots/bot-4366a50b/docs/approval-box/encrypted-store-20261128.md` (Owner ruling 2026-11-28). Library: login-billing 0.28.0, contract 1.64 section 12.10 "Data sets without teams" (package alias `login-billing-028`; the login itself stays on 0.22.4).

### Function diagram
| Function | Part | Input -> output | Failure / exit |
| --- | --- | --- | --- |
| window | server seal.ts vaultFromEnv/vaultOf | AUTH_MODULE_SOCKET -> brokerWindow (grant `approvalbox-data`); else ABX_DATA_KEY(_FILE) (base64, 32 bytes) -> keyWindow | none configured -> Vault not ready: create, answer, upload refuse with 503 `store_unavailable` (nothing is stored in plaintext); start-up logs `content_store_unavailable` |
| data key | seal.ts Vault (createDataSets) | set = the account id (users.id) at first seal -> DK_n wrapped by the window in `data_sets` (`dset:<set>`, JSON, one transaction per write); unwrapped keys cached at most 60 s | window down -> 503 for that call; a broken record -> 500, logged as its code only |
| seal / open | decisions.ts, attachments.ts, http.ts idempotent | plaintext -> lbd1 (AES-256-GCM) with context `<decision id>\|<column>`, `<decision id>\|note`, `<attachment id>\|name`, `<attachment id>\|file`, `idempotency\|<key>`; opened in memory for one response | every write reseals the whole row under the set's current key |
| device ack | http.ts POST /v1/decisions/{id}/stored -> Decisions.stored | signed request (keyhole = device id), decided request -> decision_stored row | idempotent; open request 409; not signed (pass, BellTeam session) 403 forbidden |
| AI has the result | Decisions.markFetched/reportDelivery/aiRead/cancel/assertOpen | delivered, fetched, AI read of a decided request, AI cancel -> decisions.ai_seen_at | - |
| purge sweep (every minute) | Decisions.sweepContent, then Attachments.gc | (a) ai_seen_at and every keyhole of the account acked, or (b) purge_by (decided + 7 days) -> content columns emptied, notes nulled, attachments rows and files, acks and the request's idempotency answers deleted; tombstone kept | a failure leaves the rest to the next minute |
| tombstone | Decisions.sweepContent | purged_at + 30 days -> row deleted, `decision.deleted` | - |
| key sweep (hourly) | Vault.sweep | DK older than 30 days -> rotated; records still under an older DK (DB headers and attachment files) -> resealed under the current one (a row changed meanwhile is left: its write resealed it); an old DK no record uses -> retired; sets with no account and no row -> deleted | resumable |
| account deletion | Accounts.deleteUser | after commit: the account's set and the sets its rows were sealed under, when no row references them -> deleteSet | the hourly sweep catches the rest |
| migration | seal.ts sealExisting at start (main.ts, before serving; retried every minute on failure) | content_state plain rows, plain attachment files and names, idempotency answers -> sealed in place, batches of 50, one transaction each; then vacuum and WAL truncate | a row is replaced only while unchanged, so it is plain or sealed, never neither; a sealed file under a plain row is recognized by opening it |

### Data flow
AI -> connector or remote MCP -> Decisions.create (seal) -> SQLite (blobs) -> push and SSE (ids only; the APNs/FCM title is opened in memory as before) -> device GET /v1/decisions/{id} (open) -> TLS -> device. Answer: device -> POST answer -> seal answer and delivery text -> connector or call-bridge delivery (open) -> AI. Decided: devices store it in their history -> POST stored -> purge sweep deletes the content; a later GET answers the tombstone (`content_removed: true`).

### Content state of a request on the server
`plain` (rows from before e02, until sealExisting) -> `sealed` (open, held, decided waiting for the AI and the acks) -> `purged` (tombstone: id, state, timestamps, metadata; no title, context, options, answer, notes or attachments) -> gone (30 days after the purge). decided -> purged also at purge_by (7 days). Already-decided rows at the migration get purge_by = migration + 7 days.

### Schema 19
decisions: content_state, sealed_set, decided_at, purge_by, ai_seen_at, purged_at (norm_title is always empty; the duplicate check compares opened titles). attachments, request_uploads, idempotency: sealed_set. New tables data_sets (the library's DataSetStore) and decision_stored (decision_id, device, at). A row keeps its sealed_set when it moves between entries, so it stays readable.

### What stays in plaintext
Metadata the server routes and lists by: ids, status, urgency, deadline, timestamps, session_label, requester, requester_bot_id, client, route, delivery state and its detail, setup check codes. The decided content leaves the server; open and held content stays sealed until decided or cancelled (no expiry).

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
| server Attachments/Decisions | SQLite＋添付原本、Web/native/AI。中身は封をして保存（下の「Sealed content」） | 決まった申請の中身はAIと全端末へ届いたら、遅くとも7日で消し、印（tombstone）は30日。closed保持期間、下書き24h、part1h、孤立原本GC。SQLiteは `secure_delete = on` で開き、消した行を空きページに残さない。起動時に空きページがあれば一度 `vacuum` とWALの切り詰め（2026-11-21、ミランダ f02s） | DB参照ある原本を削除せず、強制終了のpartは次通常hourly GC |
| daemon saveAttachment | home/attachments、回答に書いたpathとget_attachment | hash一致を再利用、30日超はpruneAttachments | 保存失敗も本文配送は継続、get_attachmentを案内。唯一の資料は利用者が別保存 |
| server main cleanup/停止 | DB event/pairing/診断/決裁/添付、Web/API | hourly prune、SIGTERM/INTでabort→HTTP close→DB close | WAL/DBを容量理由で除去しない。利用者のpending/heldは保持 |
| 通常配備normal_entry | expectedrun/manifest/prepared-source.tar、complete/bundle/outbox、監査/復旧reader | commit＋policy＋変換recipe＋hashに結んだ耐久原本 | resultだけでoutbox終端としない。unknown/唯一archiveを保持し自動再配備しない |
| SSH payload/remote-change | /tmpの専有payload、src/src.old、製品image | EXIT trap回収。現用＋直前2imageを通常受入後に保持 | shell終了とremote実終端を区別。未確認payloadは使用者確認後のみ回収 |
| up.sh backup | 整合local staging→正規NAS.partial→確定directory、復旧reader | SHA/属性/SQLite確認・rename後local重複回収。利用者の情報を含むので、確定後にそれより前の世代と残った.partialを消し、NASには最新の1世代だけ残す（オーナー決裁 privacy/d04、2026-11-20） | NAS不達/未完はstaging保持・次配備拒否で、前の世代は消さない。旧DBへ自動復元しない。live volumeに手作業の控えを置かない（次の控えに写り込む） |
| 専有検証scratch | 署名archive/source/lock→展開tree・依存/cache→結果原本 | worker終端・未参照・必要証拠確定後、生成物だけ回収 | active/未完/ignored固有物/refを守る。旧実験は再開せず次入口で同じ終了条件を適用 |

当席専用の配備・保持helperの正本は `/srv/bellteam/bots/bot-4366a50b/docs/approval-box/storage-lifecycle-20261106.md` とそこから辿る既配備手順。製品repoへ別コピーを作らない。
