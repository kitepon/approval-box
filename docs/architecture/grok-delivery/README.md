# Bridge宛ての回答配送（GrokBot・BellTeam）

2026-11-11、Owner指示「ApprovalBoxに取り込むのではなくて、grokbot-bridgeを使え」により、Approval Boxは宛先別の配達追跡を持たず、Bridgeの公開の口（`call_open` + `call_send`）へ一度渡すだけにする。本人を起こして届ける処理、GrokBot配達役の途絶検知と復旧はBridgeが持つ（リターの正本 `/srv/bellteam/bots/bot-df96182b/docs/approval-box-bridge-entry-20261111.md`）。

[全体図](overview.mmd) → [配送詳細](delivery.mmd)。

## 所有状態と接続

- `Decisions`が回答・公開deliveryを所有。API enumは不変。`waiting`は配送待ち、`delivered`はBridgeが受け付けた（GrokBotは`queued`の耐久保存、BellTeamは受付）、`unknown`は結果不明または失敗、`fetched`は明示取得。`delivered`はAIが動いた証明ではない。
- `CallBridgeDeliverer`がschema10の`bridge_deliveries`を所有（decision_id・session_id・seq・state・detail・closed）。stateはpending/delivered/failed/unknown。`closed`は旧版の列で、新しい行では使わない（schema変更なし）。
- `callBridgeSender`はApproval Box自身の認証で`call_open`と`call_send`だけを呼ぶ。`call_info`の追跡、`call_hangup`（queuedのGrokBot宛てを取り消す）、receipt、既読変更は使わない。通話は開いたまま残す。
- 宛先は`route.channel_id`（電話帳のid）と、Bridge接続ごとの環境変数`CALL_BRIDGE_MEMBER_SYSTEM`（既定grokbot、電話帳のsystem）。申請ごとのsystem指定は持たない。
- Bridge経路は明示的に指定された接続だけに使う。通常のBellTeam・stdio・コネクタ配送経路は変更しない。
- 新規通話のsessionを本文送信より先にDB保存する。`call_send`が受け付けたら、journal deliveredとreportDeliveryを同じtransactionで確定する。応答が消えた送信は再送せずunknown。
- `call_open`の保証付き未開設`directory_link_down`だけ、30秒/回答後10分の再試行を維持する（Bridgeは本文を受けていない）。
- 再起動時、旧版が残したpending行はseqがあればBridge受付済みとしてdelivered、seqが無ければunknownで確定する。どちらも本文を再送しない。通話のない旧sendingは以前どおりunknown。
- reportDeliveryは`fetched`を上書きしない。

## 変更範囲と確認

| 窓口 | callerと試験 |
|---|---|
| callbridge.ts: CallSender/SendResult/callBridgeSender/CallBridgeDeliverer | main.tsが生成しstartup/60秒でsync。callbridge-tracking.test.tsを受け渡し方式の試験へ置き換え、callbridge-retry.test.tsは未開設再試行を維持、remote-mcp.test.tsは偽senderで既存経路 |
| remote-mcp.ts / decisions.ts route | 不変（`requester_id`→`route.channel_id`） |
| Web/API/connector/native | 公開enum・認証・本文・添付の契約は不変 |

## 限界

Bridgeの受付は本人の読了・作業完了ではない。配達役が止まった時の復旧はBridgeの通知と箱側の再起動に依存し、Approval Boxからは見えない。必要ならAIは`get_decision`で保存回答を取れる。
