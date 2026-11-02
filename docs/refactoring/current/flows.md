# 現状の責任・データ・異常経路

各図のノードは[実ファイル・関数索引](code-index.md)へ辿る。基準はsource-index.jsonのcommit/hash。以下は読取結果であり、整理方針の決定は次のAstra設計工程で行う。

## ログインと接続

図: [identity.mmd](identity.mmd)。入口: server/http.ts createApp、Accounts、oidc.verifyIdToken。利用者sessionとAI connection tokenは異なる主体。requester名/channelは表示/配送先であり認証主体ではない。Web/nativeはapi.md v0.37契約、外部AI・Apple/Google SDKの実装は対象外。

- session所有: Accountsがusers/identities/sessionsを書き、token hashと期限を保存する。Apple/Googleの異なるsubjectは別user。verifyIdTokenは公開鍵・issuer/aud/expiry/nonce/署名を確認してからsubjectを返す。検証失敗やJWKS取得失敗はHTTP/MCP入口へ例外、未検証のidentityを保存しない。
- Appleブラウザ認証: startAuthFlow→callback takeAuthFlow→verify→bindAuthFlow→一時session revoke→createAppCode→アプリのredeemAppCode。state/nonce/PKCE/used/期限をDBが持つ。callback取消はアプリschemeへerror、session/tokenをURLへ載せない。独立取引の境目があることを隠さない。
- 接続所有: Accounts。CLI pairが匿名startPairing、アプリsessionでlookup/claim/reject、poll-secretでPCが一度だけconnection tokenを取得。tokenはpairingsから取得時に消す。setup取消/期限切れ/既deliveredはCLIエラー。設定登録の一部失敗は既保存token/configが残り得る。自動で設定全体を巻戻す機構はない。
- 解除: revokeConnectionはtoken失効・setup_checks/request_uploads削除。既存decisionの画像は保持。uninstallは自製品の設定を外し、daemon停止、サーバー接続解除を試み、失敗は利用者へ案内してlocal configを消す。logoutは指定sessionだけ削除する。アカウント削除は診断寄与を除きDB cascade、ファイルを消せなければ取引rollbackして認証を残す。ただし、途中まで削除した原本はDB rollbackで復元できない。
- 主な検証入口: account-deletion/connector-auth/api、connector instructions/session-routing/codex-acceptance/daemon-launch。実hostの設定や実Apple/Google認証は今回未実行。

## 申請と回答

図: [decisions.mmd](decisions.mmd)。所有: Decisionsがdecisions/history/request_checks/setup_checksと添付の論理結合を持つ。HTTP/MCPは入力schemaと認証接続を渡す。物理ファイルはAttachments。

- requireCheckは申請前に確認札を作りconfirm_requiredと要約一覧を返す。この時点で申請未受付。createは同connectionの札を検証/消費し、レート・推薦選択肢・同題重複・画像全件を検証、同txでdecision/history/添付結合/event rowを確定する。失敗はrollback、bus通知は出さない。
- amendはversion/20回上限/選択肢整合/画像全置換を同txで行う。pending/heldを維持し、version/historyを更新、commit後に通知。cancelはclosedへ移し、回答draftを除去し申請画像と理由を保持する。
- answerはuser所有・open・version・option・添付全件を同txで検証。409には最新Decisionを含めWebが表示を置換する。成功でansweredとdelivery waiting・delivery_id・delivery_textを保存し、setupならwaiting_ai。回答保存完了とAI配送完了は別。
- idempotentはHTTP上で同期変更と応答控え保存の間に実行を譲らず、同user/key/routeの初回応答を言語込みで再返却する。5xx/rate_limitedは控えに残さない。HTTP requestの応答を失ったクライアントのwrite再試行は同key。AI新規申請APIは自動再POSTせず要約一覧で照合する。同期処理でも業務commitと控え保存は別であり、プロセス停止まで原子的に保護する仕組みではない。
- deleteClosed/purgeExpiredはclosedだけ削除しevent、添付原本はGC。DELETE meは別の全削除取引。deleteClosedは取引内、purgeExpiredは行ごとの削除と通知であり、一括取引ではない。DB schema9のcascadeとafterCommitが後始末/通知を支える。
- 主な検証入口: server api/request-images/attachments/decision-summary/db/account-deletion/locale、remote-mcp。

## ファイル

図: [attachments.mmd](attachments.mmd)。原本所有: Attachments(dir)、メタデータ: request_uploadsまたはattachments。request画像の未結合はconnection所有、結合後はdecision所有。answer draftはuser/decision所有、position null。answer保存時にpositionとanswer JSONへ結ぶ。

- connector uploadImagePathsは全ローカルfileを読取サイズ/形式/変更競合/件数/合計を検証してから順にupload。途中upload失敗なら申請は未作成、一部の未結合画像は残り24h GC対象。remoteはstrict base64→同Attachments.uploadRequest。local pathをserverへ保存しない。
- request uploadはpartを作り、rename後にDB公開する。失敗時はpart/原本を削除する。answer uploadはpart→DB確定→renameであり、両者の順序差は現状の事実。DBとFSは一つの原子取引ではない。停止窓・rename失敗の挙動は既存試験以上に成功扱いしない。
- 読取境界はHTTP/remoteでuser/connection所属確認をした後、readForUser/readForAi。返すHTTPはattachment disposition/no-store/nosniff/CSP sandbox。Web request画像はsize/hashを検証してObjectURLを作り、unmountでrevoke。connectorはhash一致後だけprivate local pathへ保存、取得失敗は本文を止めずget_attachmentを案内する。
- GCは24h draft、DB参照なし原本、1h古いpart。アカウント削除のeraseFilesは失敗を握りつぶさずDB削除をrollback。既決削除のsweepは失敗をログに残し、既完了の操作は成功のまま。
- 上限: 単体20MiB、10件、合計50MiB、account1GiB。ブラウザ側検査とserver trust境界検査は役割が違う。重複して見えても片方の削除を自動で整理案にしない。

## 配送

図: [delivery.mmd](delivery.mmd)。保存されたanswer/delivery/routeはDecisions、local journalはconnector daemon、実channel投函/取り出し/Codex parent操作は外部aiterm-steer-delivery/Aiterm、call-bridgeの通話は外部Bridgeが持つ。

- local: syncの多重呼出しは一つのPromiseとagainで直列化。添付保存後、journal sendingを永続化してからsendChannelAnswer。submittedはdelivered報告、queuedはstate照合。emittedと不明/withdrawn/closedを区別し、journal reportのAPI報告だけを失敗後再送する。API報告成功後にjournalを消す。
- 再起動: sendingをchannelAnswerStateと照合し、queued/emitted/sendingは追跡へ、それ以外はunknown。元本文が存在する証拠と元送信状態を失っても未送信と推測しない。
- resume/getによって配送待ちやchannelが変わった時は未消費本文だけwithdrawする。取出しと競合した時はdeliveredまたはunknownを報告し、このsyncで新channelへ再送しない。
- server callbridge: serverDeliveries→markSending→CallSender。通話未開設/未送信を保証する構造化directory_link_downだけ30秒以降・回答後10分までdefer。送信前例外/open拒否/明示delivery errorはfailed、送信開始後の例外/結果不明/起動時sendingはunknown。再試行期限超過もfailedとし、これらは本文を自動再送しない。remote明示getはfetchedにして自動配送を止める。
- deliveredは実際のharness/adapter契約に基づく受付/出力の結果であり、AIの作業完了やOwner画面の更新と同一ではない。今回のリターBridge修理は別製品の工程で、このリファクタリングから引き継がない。
- 主な検証入口: daemon/channel-delivery/session-routing/aiterm-provider/codex-acceptance、server callbridge-retry/remote-mcp。

## 通知と画面

図: [events.mmd](events.mmd)。EventHubはevents表とin-process busを持つ。userイベントはpublishが保存しsince/Last-Event-IDで再取得、connection wakeは揮発の再取得合図。図は外側取引内の経路を示す。取引外のpublish/notifyConnectionはafterCommitが直ちに通知し、取引内ではcommit後だけ通知する。

- HTTP /v1/events: 保存分をqueueに積み購読、event idで重複を飛ばす。/connector/v1/streamはpendingフラグでdeliveries合図だけを送る。25秒heartbeat、abort/停止はwake/unsubscribe、shutdown listenerの解除がある。書込例外などで必ずfinallyまで後始末できるかは設計時に確認する。
- Web subscribeEventsは切断時backoff最大60秒で再接続、user lastIdを維持。AppはSSE/foregroundでbump、useResourceが実データを再GET、aliveフラグで古い応答を無視。画面反映はこのGET成功後。SSE合図だけを保存結果や表示成功と数えない。
- DecisionViewは回答のbusy/本文/draft/noticeとswipe gesture状態も持つ。actはAPI成功でstate/bump、回答後は一覧へ移動、409は最新Decisionを反映しnotice。swipeは無入力/非busy/単指/方向/距離/時間/selection/reduced-motionを判定し、unmountでanimation cancel。UI操作の整理でaccessibility/選択/取消を落とさない。
- APNs Notifierはcommit後イベントを購読、対象iOS device/localeをDBから取り送る。申請/修正だけ音を鳴らし、回答/配送/取消はbadge。無効tokenだけ削除。APNs送信失敗は申請保存を失敗へ戻さず、通知受理から端末画面表示を補完しない。

## 診断・課金・運用

図: [operations.mmd](operations.mmd)。Diagnosticsはstrict入力/制限/receipt/raw/group/user寄与/集計保持、admin routerはLAN+tokenを所有。AppStoreは署名検証/transaction所有/順不同更新の処理を持ち、Accountsがuser planを書く。

- 診断のaccepted202、重複受領、group昇格、管理画面表示は別。same event_idでもdigest不一致は409、原本/canonical receiptとfingerprintは保持。referenceOnlyは送信元の評価に従い新groupを作らず既存groupの参照回数は増やす。管理GETの説明生成は出力だけ、rawを書換えない。
- pruneはraw30日/10000件、group120日、receiptは再作成防止で長期保持。removeUserは他userの寄与に戻し共有状態を保つ。調査/解決自由記述は当人由来を分けられない時だけ消す。
- adminは接続peer+URL hostのprivate addressとproxy header不在を検証し、timingSafeEqualで専用token。利用者session/接続tokenでadminへ入らない。
- billingはApple JWSをroot/env/appで検証してからapply。productionのみsetup verified条件。originalTransactionIdの別user所有を拒否、古い期限通知で新期限を巻戻さず、revocationは反映。Google Play/Stripe/FCM/Web Pushは実装済みと描かない。現状の未実装窓口はエラーを返す。
- 言語は固定UI/エラー/案内/通知接頭辞のみ。server/locales.tsとweb/locales.tsに同一locale正規化があり、web/i18n.tsはserver/errors.tsを直接importする。この接続と重複を設計の検討材料に残す。申請本文/回答/識別子を翻訳しない。

## 実行環境

図: [runtime.mmd](runtime.mmd)。main.tsがDb/Services/環境/HTTP/static/APNs/課金/Bridge/cleanupを構築、SIGTERM/SIGINTでabort→HTTP close→Db close、3秒/6秒上限。本件では本番へ合図を送らない。

- connector buildは4entry+split chunksを依存ごとbundleしlicenseを列挙。setupはversioned runtimeへ複製しhook/stdioの絶対pathを固定。旧process用runtimeを無断削除しない。
- harnessは設定の自製品部分を変更、backupOnce、symlinkで別管理の規範を保護。Codexの配達はAitermを使い旧専用hookを無効化、Claudeは共通hook、Cursorはbindのみでreceiveだけが本文を消費。Windows daemonはpwsh+CIM、他OSはdetached node/private log。
- CIは3OS×4harnessの起動前/設定保持、browser、isolated server image。同じ改修のLinux単体成功を他OSや実AI操作の成功へ補完しない。tools/e2eの実AI起動、Host操作、コネクタ本登録、本番image反映、tag push/npm publishは本調査で未実行。
- 既存公開契約・データ保存は維持し、変更する窓口の全caller/test/fixture/exportを設計後に具体照合する。全範囲の機能図を理由に全ファイルを書換えない。
