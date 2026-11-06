# GrokBot宛ての回答配送

Bridgeの`queued`は保存完了であり、配達前に`call_hangup`すると配送を取り消す。稼働版90066748はこの順に呼んでいた。2026-11-02の直近9件は未claim/attempts0で取消された（本文を使わず宛先と時刻で一意照合）。本修理はBridgeの現契約に合わせ、同じ通話を追跡し終端を保存してから閉じる。

[全体図](overview.png) → [配送詳細](delivery.png)（各同名mmdが原本）。製品全域の図は[受入済み機能索引](https://github.com/kitepon/approval-box/blob/4a4f0e1e3e85ff784e9af6d62876aa2b324aa322/docs/refactoring/README.md)を参照。この修理branchは稼働版90066748をbaseとし、未mergeのrefactor PR15を取り込まない。図のHTTP表記はbaseの単一http.tsに対応する。

## 所有状態と接続

- `Decisions`が回答・公開deliveryを所有。既存のAPI v0.37 enumを維持し、`waiting`は配送待ち、`delivered`はadapter受付、`unknown`は未確認、`fetched`は明示取得。gateway受付をAIの業務完了・本人読了とは扱わない。
- `CallBridgeDeliverer`がschema10の`bridge_deliveries`を所有。decision_id（削除cascade）・session_id・seq・state・detail・closedのみ。回答本文/資格は複製しない。stateはpending/delivered/failed/unknown。failedとunknownはjournalで区別し、既存の公開unknown表示へ写す。
- `callBridgeSender`が元当事者の認証でopen/send/info/hangupする。Bridge・配達役・gatewayは外部所有。receipt書込、claim、本文履歴、既読変更は使わない。
- 新規通話のsessionを本文送信より先にDB保存し、送信応答のseqを保存。プロセス停止・応答消失・一時通信断でも同sessionのcall_infoだけを続ける。seq不明時は、専用の新規通話で唯一の配送行がseq1の場合だけ採用する。他番号や複数行から推測しない。
- queued/inflight/照会失敗は閉じず、既存main.tsのstartup/60秒syncで再照会する。submittedはdelivered、failed/unknownは区別して保存。journal終端とDecisions結果を同transactionで確定した後hangupする。close失敗時は結果を保持してcloseだけ再試行する。
- remote getでfetchedになった場合も元通話を追跡し、fetchedを上書きしない。削除はjournalをcascade削除。接続失効後はその接続を使って照会しない。既にBridgeへ保存した本文をfetchedや接続失効だけで取消す実装は作らない。
- 通話が不明な旧sendingは以前どおりunknown。未開設・未送信保証のdirectory_link_downだけ30秒/回答後10分の再試行を維持する。元9件や旧target_not_found群を書き換えず、自動再送しない。

## 変更範囲と確認

| 窓口 | 全caller/データ/試験への到達 |
|---|---|
| callbridge.ts: CallSender/SendResult/callBridgeSender/CallBridgeDeliverer | main.tsが生成しstartup/60秒でsync。remote-mcp.test.tsが偽senderで既存経路を検証。新callbridge-tracking.test.tsはSDK公開窓口を模擬し永続DB・再起動・回復を検証。callbridge-retry.test.tsは旧未送信保証を維持 |
| db.ts migration10 | 新規/旧schema9/旧migration経由を確認。account-deletion/diagnostics/localeの最終版assertを10へ更新し、従来のデータ保持assertを残す。decision FK削除も検証 |
| Decisions: serverDeliveries/markSending/defer/interrupted/reportDelivery | 実装は維持。journalのある旧sendingは追跡、無い旧sendingはunknown。terminal保存とreportDeliveryは同取引。remote get/fetchedの競合を追加試験 |
| Web/API/connector/native boundary | 公開enum・入力/認証・route・本文・添付契約を維持。Webはwaiting表示を使用。native/connectorの改修・export/資格/設定追加なし。コネクタの本文配送は変更しない |

新10試験はqueued取消の反例、queued→inflight→submitted/failed/unknown、disk DBの再起動、応答消失後の唯一seq回復、call_info通信失敗、fetched保持、close失敗後の再試行、schema9移行とcascade、曖昧seq非採用、checkpoint失敗時の未送信を含む。旧senderに戻した限定試験では即hangup反例が失敗し、修理後は成功した。

通常`npm test`はserver103/connector36で全件成功。型検査とbuildは実行記録を参照。試験側のshutdown reader後始末は受入済み5925da9から別commit fbf78a5として取り込んだ。これは製品の配送修理と区別する。最初の通常試験はこの旧fixtureで終了せず、次回はschema最終版assert4件の9→10追従不足で失敗し、修正後の通常全件が成功した。force-exitは使用しない。

図はMermaid CLI12でPNGへ実描画し2枚とも目視。rendererはBot project配下の正規依存で、OS変更なし。

## 限界と残作業

実Bridgeの本番送信/実GrokBot起動/本番migration/配備は未実施。試験は合成回答と模擬MCP結果だけを使う。稼働9件の観測は修理成功の証拠とは別。Bridge担当の接点確認・正規CI/候補受入・既条件内の反映・通常結果確認を続ける。

call_open応答が消えてsession不明の場合は再送しない。call_send応答が消え、公開metadataでseqを一意に特定できない場合は同sessionを保持し照会を続ける。期限で元本文を再送/通話取消しないため、receiptが永久に現れない場合は自動完了しない。元会話の明示get_decisionで保存回答を取得できる。複数serverの同時稼働は既存の単一worker構成を前提とし、本修理で分散claimを追加しない。

非秘密検証原本: ナユタの `docs/approval-box/grokbot-delivery-20261102/`、Bridge調査契約正本: リターの `docs/approval-box-delivery-20261102.md`。責任境界と本番条件は各担当の既手順を維持する。
# 全体の機能とデータフロー

[現用製品の全体図](../README.md)と[保存・実行環境](../storage-lifecycle.md)から、この配送詳細へ辿る。
