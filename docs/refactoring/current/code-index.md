# 実ファイル・関数の対応（現状）

基準commit: 90066748bf7ca4686716c67c91d76fcd20afa519。静的import・宣言の全件一覧。呼出し順とデータ所有者は各機能詳細を参照。動的呼出しの完全解析を主張しない。Python/shellは対象一覧のみで関数展開は未調査。

## packages/connector/scripts/build.mjs

import: esbuild, node:fs, node:path

定数/設定/スクリプト入口。関数展開なし。

## packages/connector/src/api.ts

import: ./config.ts

- [ServerError](../../../packages/connector/src/api.ts#L3) (ClassDeclaration)
- [ServerError.constructor](../../../packages/connector/src/api.ts#L7) (Constructor)
- [Api](../../../packages/connector/src/api.ts#L16) (ClassDeclaration)
- [Api.constructor](../../../packages/connector/src/api.ts#L20) (Constructor)
- [Api.url](../../../packages/connector/src/api.ts#L25) (MethodDeclaration)
- [Api.call](../../../packages/connector/src/api.ts#L29) (MethodDeclaration)
- [Api.uploadRequestImage](../../../packages/connector/src/api.ts#L63) (MethodDeclaration)
- [Api.download](../../../packages/connector/src/api.ts#L73) (MethodDeclaration)
- [Api.stream](../../../packages/connector/src/api.ts#L86) (MethodDeclaration)

## packages/connector/src/attachments.ts

import: node:crypto, node:fs, node:path, ./api.ts, ./profile.ts

- [AttachmentMeta](../../../packages/connector/src/attachments.ts#L9) (TypeAliasDeclaration)
- [attachmentsRoot](../../../packages/connector/src/attachments.ts#L13) (FunctionVariable)
- [safeFileName](../../../packages/connector/src/attachments.ts#L16) (FunctionDeclaration)
- [saveAttachment](../../../packages/connector/src/attachments.ts#L22) (FunctionDeclaration)
- [saveAll](../../../packages/connector/src/attachments.ts#L34) (FunctionDeclaration)
- [pruneAttachments](../../../packages/connector/src/attachments.ts#L47) (FunctionDeclaration)
- [sha256](../../../packages/connector/src/attachments.ts#L57) (FunctionVariable)

## packages/connector/src/channel-delivery.ts

import: aiterm-steer-delivery, ./profile.ts

- [CodexParent](../../../packages/connector/src/channel-delivery.ts#L4) (TypeAliasDeclaration)
- [CodexProvider](../../../packages/connector/src/channel-delivery.ts#L5) (TypeAliasDeclaration)
- [sendChannelAnswer](../../../packages/connector/src/channel-delivery.ts#L15) (FunctionDeclaration)
- [channelAnswerState](../../../packages/connector/src/channel-delivery.ts#L35) (FunctionDeclaration)

## packages/connector/src/claude-channel.ts

import: node:fs, node:path, aiterm-steer-delivery

- [ClaudeParent](../../../packages/connector/src/claude-channel.ts#L5) (TypeAliasDeclaration)
- [Profile](../../../packages/connector/src/claude-channel.ts#L6) (TypeAliasDeclaration)
- [claudeChannelIsCurrent](../../../packages/connector/src/claude-channel.ts#L17) (FunctionDeclaration)

## packages/connector/src/cli.ts

import: node:fs, node:os, node:path, node:readline/promises, qrcode, ./api.ts, ./config.ts, ./daemon.ts, ./harness.ts, ./instructions.ts, ./mcp.ts, ./profile.ts, ./runtime.ts, ./version.ts

- [flag](../../../packages/connector/src/cli.ts#L19) (FunctionVariable)
- [option](../../../packages/connector/src/cli.ts#L20) (FunctionVariable)
- [out](../../../packages/connector/src/cli.ts#L24) (FunctionVariable)
- [Check](../../../packages/connector/src/cli.ts#L26) (TypeAliasDeclaration)
- [ask](../../../packages/connector/src/cli.ts#L36) (FunctionDeclaration)
- [installRuntime](../../../packages/connector/src/cli.ts#L42) (FunctionDeclaration)
- [selectedTargets](../../../packages/connector/src/cli.ts#L52) (FunctionDeclaration)
- [pair](../../../packages/connector/src/cli.ts#L62) (FunctionDeclaration)
- [waitForChecks](../../../packages/connector/src/cli.ts#L83) (FunctionDeclaration)
- [setup](../../../packages/connector/src/cli.ts#L105) (FunctionDeclaration)
- [registerTargets](../../../packages/connector/src/cli.ts#L156) (FunctionDeclaration)
- [uninstall](../../../packages/connector/src/cli.ts#L170) (FunctionDeclaration)
- [status](../../../packages/connector/src/cli.ts#L188) (FunctionDeclaration)
- [doctor](../../../packages/connector/src/cli.ts#L207) (FunctionDeclaration)
- [test](../../../packages/connector/src/cli.ts#L240) (FunctionDeclaration)
- [help](../../../packages/connector/src/cli.ts#L248) (FunctionDeclaration)
- [cursorContext](../../../packages/connector/src/cli.ts#L260) (FunctionDeclaration)

## packages/connector/src/config.ts

import: node:fs, node:path, ./profile.ts

- [Config](../../../packages/connector/src/config.ts#L5) (TypeAliasDeclaration)
- [configFile](../../../packages/connector/src/config.ts#L8) (FunctionVariable)
- [readConfig](../../../packages/connector/src/config.ts#L10) (FunctionDeclaration)
- [requireConfig](../../../packages/connector/src/config.ts#L15) (FunctionDeclaration)
- [writeJsonFile](../../../packages/connector/src/config.ts#L21) (FunctionDeclaration)
- [writeConfig](../../../packages/connector/src/config.ts#L28) (FunctionDeclaration)

## packages/connector/src/cursor-binding.ts

import: aiterm-steer-delivery

- [bindCursorResult](../../../packages/connector/src/cursor-binding.ts#L4) (FunctionDeclaration)

## packages/connector/src/daemon-launch.ts

import: node:child_process, node:fs, node:path, ./profile.ts

- [windowsDaemonLaunchScript](../../../packages/connector/src/daemon-launch.ts#L7) (FunctionDeclaration)
- [literal](../../../packages/connector/src/daemon-launch.ts#L12) (FunctionVariable)
- [launchDaemon](../../../packages/connector/src/daemon-launch.ts#L17) (FunctionDeclaration)

## packages/connector/src/daemon.ts

import: aiterm-steer-delivery, ./daemon-launch.ts, ./channel-delivery.ts, node:fs, node:path, ./api.ts, ./attachments.ts, ./config.ts, ./profile.ts, ./runtime.ts

- [Delivery](../../../packages/connector/src/daemon.ts#L12) (TypeAliasDeclaration)
- [Entry](../../../packages/connector/src/daemon.ts#L13) (TypeAliasDeclaration)
- [Journal](../../../packages/connector/src/daemon.ts#L17) (TypeAliasDeclaration)
- [lockFile](../../../packages/connector/src/daemon.ts#L19) (FunctionVariable)
- [journalFile](../../../packages/connector/src/daemon.ts#L20) (FunctionVariable)
- [alive](../../../packages/connector/src/daemon.ts#L23) (FunctionDeclaration)
- [daemonStatus](../../../packages/connector/src/daemon.ts#L27) (FunctionDeclaration)
- [versionOfEntry](../../../packages/connector/src/daemon.ts#L36) (FunctionDeclaration)
- [shouldReplaceDaemon](../../../packages/connector/src/daemon.ts#L45) (FunctionDeclaration)
- [daemonNode](../../../packages/connector/src/daemon.ts#L58) (FunctionDeclaration)
- [ensureDaemon](../../../packages/connector/src/daemon.ts#L63) (FunctionDeclaration)
- [sleep](../../../packages/connector/src/daemon.ts#L76) (FunctionVariable)
- [runDaemon](../../../packages/connector/src/daemon.ts#L78) (FunctionDeclaration)
- [save](../../../packages/connector/src/daemon.ts#L91) (FunctionVariable)
- [log](../../../packages/connector/src/daemon.ts#L92) (FunctionVariable)
- [report](../../../packages/connector/src/daemon.ts#L105) (FunctionDeclaration)
- [deliver](../../../packages/connector/src/daemon.ts#L116) (FunctionDeclaration)
- [safeState](../../../packages/connector/src/daemon.ts#L140) (FunctionDeclaration)
- [checkQueued](../../../packages/connector/src/daemon.ts#L144) (FunctionDeclaration)
- [sync](../../../packages/connector/src/daemon.ts#L162) (FunctionDeclaration)
- [releaseLock](../../../packages/connector/src/daemon.ts#L202) (FunctionVariable)
- [stop](../../../packages/connector/src/daemon.ts#L210) (FunctionVariable)

## packages/connector/src/harness.ts

import: aiterm-steer-delivery, node:child_process, node:fs, node:os, node:path, ./config.ts, ./instructions.ts, ./profile.ts, ./runtime.ts

- [Target](../../../packages/connector/src/harness.ts#L12) (TypeAliasDeclaration)
- [claudeDir](../../../packages/connector/src/harness.ts#L16) (FunctionVariable)
- [claudeJson](../../../packages/connector/src/harness.ts#L17) (FunctionVariable)
- [cursorDir](../../../packages/connector/src/harness.ts#L18) (FunctionVariable)
- [codexHome](../../../packages/connector/src/harness.ts#L19) (FunctionVariable)
- [grokDir](../../../packages/connector/src/harness.ts#L20) (FunctionVariable)
- [filesOf](../../../packages/connector/src/harness.ts#L23) (FunctionDeclaration)
- [instructionsFileOf](../../../packages/connector/src/harness.ts#L31) (FunctionDeclaration)
- [onPath](../../../packages/connector/src/harness.ts#L38) (FunctionDeclaration)
- [detect](../../../packages/connector/src/harness.ts#L46) (FunctionDeclaration)
- [stableNode](../../../packages/connector/src/harness.ts#L57) (FunctionDeclaration)
- [cursorCliConfig](../../../packages/connector/src/harness.ts#L63) (FunctionVariable)
- [setCursorPermissions](../../../packages/connector/src/harness.ts#L64) (FunctionDeclaration)
- [setCursorContext](../../../packages/connector/src/harness.ts#L81) (FunctionDeclaration)
- [ours](../../../packages/connector/src/harness.ts#L88) (FunctionVariable)
- [cursorContextRegistered](../../../packages/connector/src/harness.ts#L94) (FunctionVariable)
- [registration](../../../packages/connector/src/harness.ts#L96) (FunctionVariable)
- [readJson](../../../packages/connector/src/harness.ts#L98) (FunctionDeclaration)
- [backupOnce](../../../packages/connector/src/harness.ts#L103) (FunctionDeclaration)
- [setMcpJson](../../../packages/connector/src/harness.ts#L108) (FunctionDeclaration)
- [withCodexConfig](../../../packages/connector/src/harness.ts#L117) (FunctionDeclaration)
- [RegisterResult](../../../packages/connector/src/harness.ts#L121) (TypeAliasDeclaration)
- [register](../../../packages/connector/src/harness.ts#L123) (FunctionDeclaration)
- [registerTools](../../../packages/connector/src/harness.ts#L135) (FunctionDeclaration)
- [hook](../../../packages/connector/src/harness.ts#L136) (FunctionVariable)
- [unregister](../../../packages/connector/src/harness.ts#L173) (FunctionDeclaration)
- [registered](../../../packages/connector/src/harness.ts#L203) (FunctionDeclaration)
- [registeredTools](../../../packages/connector/src/harness.ts#L212) (FunctionDeclaration)
- [entryOf](../../../packages/connector/src/harness.ts#L213) (FunctionVariable)
- [configDirOf](../../../packages/connector/src/harness.ts#L233) (FunctionVariable)

## packages/connector/src/hooks/claude.ts

import: aiterm-steer-delivery, ../profile.ts

定数/設定/スクリプト入口。関数展開なし。

## packages/connector/src/hooks/cursor.ts

import: ../cursor-binding.ts, ../profile.ts

定数/設定/スクリプト入口。関数展開なし。

## packages/connector/src/hooks/receive.ts

import: aiterm-steer-delivery, ../profile.ts

定数/設定/スクリプト入口。関数展開なし。

## packages/connector/src/instructions.ts

import: node:fs, node:os, node:path

- [hasInstructions](../../../packages/connector/src/instructions.ts#L20) (FunctionDeclaration)
- [hasInstructionsInDir](../../../packages/connector/src/instructions.ts#L33) (FunctionDeclaration)
- [managedElsewhere](../../../packages/connector/src/instructions.ts#L47) (FunctionDeclaration)
- [writeInstructions](../../../packages/connector/src/instructions.ts#L56) (FunctionDeclaration)
- [removeInstructions](../../../packages/connector/src/instructions.ts#L65) (FunctionDeclaration)

## packages/connector/src/mcp.ts

import: @modelcontextprotocol/sdk/server/index.js, @modelcontextprotocol/sdk/server/stdio.js, @modelcontextprotocol/sdk/types.js, aiterm-steer-delivery, node:fs, node:path, ./api.ts, ./attachments.ts, ./config.ts, ./daemon.ts, ./request-images.ts, ./runtime.ts, ./claude-channel.ts, ./profile.ts, ./version.ts

- [Harness](../../../packages/connector/src/mcp.ts#L17) (TypeAliasDeclaration)
- [harnessOf](../../../packages/connector/src/mcp.ts#L21) (FunctionDeclaration)
- [ParentKey](../../../packages/connector/src/mcp.ts#L133) (TypeAliasDeclaration)
- [parentsFile](../../../packages/connector/src/mcp.ts#L134) (FunctionVariable)
- [savedParents](../../../packages/connector/src/mcp.ts#L138) (FunctionDeclaration)
- [reuse](../../../packages/connector/src/mcp.ts#L142) (FunctionDeclaration)
- [remember](../../../packages/connector/src/mcp.ts#L148) (FunctionDeclaration)
- [channelFor](../../../packages/connector/src/mcp.ts#L157) (FunctionDeclaration)
- [named](../../../packages/connector/src/mcp.ts#L204) (FunctionDeclaration)
- [receiveGuide](../../../packages/connector/src/mcp.ts#L210) (FunctionDeclaration)
- [announced](../../../packages/connector/src/mcp.ts#L227) (FunctionDeclaration)
- [text](../../../packages/connector/src/mcp.ts#L231) (FunctionDeclaration)
- [describe](../../../packages/connector/src/mcp.ts#L235) (FunctionDeclaration)
- [runMcp](../../../packages/connector/src/mcp.ts#L245) (FunctionDeclaration)

## packages/connector/src/profile.ts

import: aiterm-steer-delivery, node:os, node:path

- [home](../../../packages/connector/src/profile.ts#L11) (FunctionVariable)
- [stateRoot](../../../packages/connector/src/profile.ts#L12) (FunctionVariable)

## packages/connector/src/request-images.ts

import: node:fs/promises, node:path, ./api.ts

- [imageType](../../../packages/connector/src/request-images.ts#L7) (FunctionDeclaration)
- [uploadImagePaths](../../../packages/connector/src/request-images.ts#L17) (FunctionDeclaration)

## packages/connector/src/runtime.ts

import: node:path, node:url, ./profile.ts

- [runtimeDir](../../../packages/connector/src/runtime.ts#L6) (FunctionVariable)
- [runtimeEntry](../../../packages/connector/src/runtime.ts#L12) (FunctionDeclaration)

## packages/connector/src/version.ts

import: なし/未解析

- [osName](../../../packages/connector/src/version.ts#L5) (FunctionDeclaration)

## packages/server/src/accounts.ts

import: ./locales.ts, node:crypto, ./db.ts, ./errors.ts, ./events.ts, ./ids.ts, ./decisions.ts, ./diagnostics.ts

- [effectivePlan](../../../packages/server/src/accounts.ts#L15) (FunctionDeclaration)
- [UserRow](../../../packages/server/src/accounts.ts#L19) (TypeAliasDeclaration)
- [ConnectionRow](../../../packages/server/src/accounts.ts#L20) (TypeAliasDeclaration)
- [PairingRow](../../../packages/server/src/accounts.ts#L21) (TypeAliasDeclaration)
- [CheckRow](../../../packages/server/src/accounts.ts#L22) (TypeAliasDeclaration)
- [BillingMode](../../../packages/server/src/accounts.ts#L24) (TypeAliasDeclaration)
- [Accounts](../../../packages/server/src/accounts.ts#L26) (ClassDeclaration)
- [Accounts.constructor](../../../packages/server/src/accounts.ts#L31) (Constructor)
- [Accounts.createUser](../../../packages/server/src/accounts.ts#L39) (MethodDeclaration)
- [Accounts.issueSession](../../../packages/server/src/accounts.ts#L45) (MethodDeclaration)
- [Accounts.userBySession](../../../packages/server/src/accounts.ts#L52) (MethodDeclaration)
- [Accounts.createAppCode](../../../packages/server/src/accounts.ts#L63) (MethodDeclaration)
- [Accounts.redeemAppCode](../../../packages/server/src/accounts.ts#L70) (MethodDeclaration)
- [Accounts.startAuthFlow](../../../packages/server/src/accounts.ts#L83) (MethodDeclaration)
- [Accounts.takeAuthFlow](../../../packages/server/src/accounts.ts#L93) (MethodDeclaration)
- [Accounts.bindAuthFlow](../../../packages/server/src/accounts.ts#L102) (MethodDeclaration)
- [Accounts.signInWithIdentity](../../../packages/server/src/accounts.ts#L110) (MethodDeclaration)
- [Accounts.revokeSession](../../../packages/server/src/accounts.ts#L119) (MethodDeclaration)
- [Accounts.deleteUser](../../../packages/server/src/accounts.ts#L123) (MethodDeclaration)
- [Accounts.me](../../../packages/server/src/accounts.ts#L130) (MethodDeclaration)
- [Accounts.settings](../../../packages/server/src/accounts.ts#L160) (MethodDeclaration)
- [Accounts.updateSettings](../../../packages/server/src/accounts.ts#L165) (MethodDeclaration)
- [Accounts.assertCanUse](../../../packages/server/src/accounts.ts#L170) (MethodDeclaration)
- [Accounts.setPlan](../../../packages/server/src/accounts.ts#L177) (MethodDeclaration)
- [Accounts.assertSetupVerified](../../../packages/server/src/accounts.ts#L181) (MethodDeclaration)
- [Accounts.connections](../../../packages/server/src/accounts.ts#L188) (MethodDeclaration)
- [Accounts.createConnection](../../../packages/server/src/accounts.ts#L195) (MethodDeclaration)
- [Accounts.registerDevice](../../../packages/server/src/accounts.ts#L205) (MethodDeclaration)
- [Accounts.removeDevice](../../../packages/server/src/accounts.ts#L219) (MethodDeclaration)
- [Accounts.issueToken](../../../packages/server/src/accounts.ts#L226) (MethodDeclaration)
- [Accounts.tokens](../../../packages/server/src/accounts.ts#L232) (MethodDeclaration)
- [Accounts.revokeToken](../../../packages/server/src/accounts.ts#L237) (MethodDeclaration)
- [Accounts.revokeConnection](../../../packages/server/src/accounts.ts#L242) (MethodDeclaration)
- [Accounts.connectionByToken](../../../packages/server/src/accounts.ts#L249) (MethodDeclaration)
- [Accounts.updateConnectionClients](../../../packages/server/src/accounts.ts#L257) (MethodDeclaration)
- [Accounts.connectionInfo](../../../packages/server/src/accounts.ts#L262) (MethodDeclaration)
- [Accounts.startPairing](../../../packages/server/src/accounts.ts#L269) (MethodDeclaration)
- [Accounts.lookupPairing](../../../packages/server/src/accounts.ts#L280) (MethodDeclaration)
- [Accounts.claimPairing](../../../packages/server/src/accounts.ts#L288) (MethodDeclaration)
- [Accounts.rejectPairing](../../../packages/server/src/accounts.ts#L300) (MethodDeclaration)
- [Accounts.pollPairing](../../../packages/server/src/accounts.ts#L304) (MethodDeclaration)
- [Accounts.prunePairings](../../../packages/server/src/accounts.ts#L317) (MethodDeclaration)

## packages/server/src/appstore.ts

import: @apple/app-store-server-library, node:fs, node:path, ./accounts.ts, ./db.ts, ./errors.ts, ./ids.ts

- [AppStoreConfig](../../../packages/server/src/appstore.ts#L11) (TypeAliasDeclaration)
- [appleRootCertificates](../../../packages/server/src/appstore.ts#L23) (FunctionDeclaration)
- [peekPayload](../../../packages/server/src/appstore.ts#L29) (FunctionDeclaration)
- [Accepted](../../../packages/server/src/appstore.ts#L37) (TypeAliasDeclaration)
- [asEnvironment](../../../packages/server/src/appstore.ts#L39) (FunctionDeclaration)
- [AppStore](../../../packages/server/src/appstore.ts#L45) (ClassDeclaration)
- [catch](../../../packages/server/src/appstore.ts#L70) (MethodDeclaration)

## packages/server/src/attachments.ts

import: node:crypto, node:fs, node:path, ./db.ts, ./errors.ts, ./ids.ts

- [Kind](../../../packages/server/src/attachments.ts#L18) (TypeAliasDeclaration)
- [Attachment](../../../packages/server/src/attachments.ts#L19) (TypeAliasDeclaration)
- [Row](../../../packages/server/src/attachments.ts#L21) (TypeAliasDeclaration)
- [isHeif](../../../packages/server/src/attachments.ts#L42) (FunctionDeclaration)
- [isZip](../../../packages/server/src/attachments.ts#L46) (FunctionDeclaration)
- [isUtf8Text](../../../packages/server/src/attachments.ts#L49) (FunctionDeclaration)
- [cleanName](../../../packages/server/src/attachments.ts#L55) (FunctionDeclaration)
- [mediaType](../../../packages/server/src/attachments.ts#L60) (FunctionDeclaration)
- [formatBytes](../../../packages/server/src/attachments.ts#L64) (FunctionDeclaration)
- [readLimited](../../../packages/server/src/attachments.ts#L71) (FunctionDeclaration)
- [Attachments](../../../packages/server/src/attachments.ts#L89) (ClassDeclaration)
- [Attachments.constructor](../../../packages/server/src/attachments.ts#L93) (Constructor)
- [Attachments.toApi](../../../packages/server/src/attachments.ts#L99) (MethodDeclaration)
- [Attachments.userFileIds](../../../packages/server/src/attachments.ts#L103) (MethodDeclaration)
- [Attachments.eraseFiles](../../../packages/server/src/attachments.ts#L108) (MethodDeclaration)
- [Attachments.open](../../../packages/server/src/attachments.ts#L119) (MethodDeclaration)
- [Attachments.upload](../../../packages/server/src/attachments.ts#L126) (MethodDeclaration)
- [Attachments.uploadRequest](../../../packages/server/src/attachments.ts#L164) (MethodDeclaration)
- [Attachments.staged](../../../packages/server/src/attachments.ts#L192) (MethodDeclaration)
- [Attachments.removeStaged](../../../packages/server/src/attachments.ts#L197) (MethodDeclaration)
- [Attachments.readForUser](../../../packages/server/src/attachments.ts#L208) (MethodDeclaration)
- [Attachments.readForAi](../../../packages/server/src/attachments.ts#L214) (MethodDeclaration)
- [Attachments.read](../../../packages/server/src/attachments.ts#L218) (MethodDeclaration)
- [Attachments.gc](../../../packages/server/src/attachments.ts#L225) (MethodDeclaration)
- [contentDisposition](../../../packages/server/src/attachments.ts#L243) (FunctionDeclaration)

## packages/server/src/callbridge.ts

import: @modelcontextprotocol/sdk/client/index.js, @modelcontextprotocol/sdk/client/streamableHttp.js, node:fs, ./db.ts, ./decisions.ts, ./events.ts

- [SendResult](../../../packages/server/src/callbridge.ts#L11) (TypeAliasDeclaration)
- [CallSender](../../../packages/server/src/callbridge.ts#L13) (TypeAliasDeclaration)
- [CallBridgeConfig](../../../packages/server/src/callbridge.ts#L15) (TypeAliasDeclaration)
- [readHeaderFile](../../../packages/server/src/callbridge.ts#L27) (FunctionDeclaration)
- [ToolResult](../../../packages/server/src/callbridge.ts#L36) (TypeAliasDeclaration)
- [payload](../../../packages/server/src/callbridge.ts#L38) (FunctionDeclaration)
- [callBridgeSender](../../../packages/server/src/callbridge.ts#L45) (FunctionDeclaration)
- [CallBridgeDeliverer](../../../packages/server/src/callbridge.ts#L85) (ClassDeclaration)
- [CallBridgeDeliverer.constructor](../../../packages/server/src/callbridge.ts#L93) (Constructor)
- [CallBridgeDeliverer.connection](../../../packages/server/src/callbridge.ts#L106) (MethodDeclaration)
- [CallBridgeDeliverer.sync](../../../packages/server/src/callbridge.ts#L111) (MethodDeclaration)

## packages/server/src/db.ts

import: ./ids.ts, node:sqlite, node:fs, node:path

- [Db](../../../packages/server/src/db.ts#L238) (TypeAliasDeclaration)
- [openDb](../../../packages/server/src/db.ts#L240) (FunctionDeclaration)
- [migrate](../../../packages/server/src/db.ts#L352) (FunctionDeclaration)
- [get](../../../packages/server/src/db.ts#L367) (FunctionDeclaration)
- [all](../../../packages/server/src/db.ts#L371) (FunctionDeclaration)
- [run](../../../packages/server/src/db.ts#L375) (FunctionDeclaration)
- [afterCommit](../../../packages/server/src/db.ts#L382) (FunctionDeclaration)
- [tx](../../../packages/server/src/db.ts#L388) (FunctionDeclaration)

## packages/server/src/decisions.ts

import: zod, ./attachments.ts, ./db.ts, ./errors.ts, ./events.ts, ./ids.ts

- [Option](../../../packages/server/src/decisions.ts#L16) (TypeAliasDeclaration)
- [Route](../../../packages/server/src/decisions.ts#L17) (TypeAliasDeclaration)
- [Answer](../../../packages/server/src/decisions.ts#L18) (TypeAliasDeclaration)
- [Row](../../../packages/server/src/decisions.ts#L20) (TypeAliasDeclaration)
- [HistoryRow](../../../packages/server/src/decisions.ts#L28) (TypeAliasDeclaration)
- [Connection](../../../packages/server/src/decisions.ts#L30) (TypeAliasDeclaration)
- [compareDeadlines](../../../packages/server/src/decisions.ts#L85) (FunctionDeclaration)
- [Decisions](../../../packages/server/src/decisions.ts#L95) (ClassDeclaration)
- [Decisions.constructor](../../../packages/server/src/decisions.ts#L99) (Constructor)
- [Decisions.toApi](../../../packages/server/src/decisions.ts#L106) (MethodDeclaration)
- [Decisions.toAi](../../../packages/server/src/decisions.ts#L141) (MethodDeclaration)
- [Decisions.connectionLabel](../../../packages/server/src/decisions.ts#L167) (MethodDeclaration)
- [Decisions.requestAttachments](../../../packages/server/src/decisions.ts#L173) (MethodDeclaration)
- [Decisions.bindRequest](../../../packages/server/src/decisions.ts#L178) (MethodDeclaration)
- [Decisions.row](../../../packages/server/src/decisions.ts#L194) (MethodDeclaration)
- [Decisions.history](../../../packages/server/src/decisions.ts#L198) (MethodDeclaration)
- [Decisions.changed](../../../packages/server/src/decisions.ts#L203) (MethodDeclaration)
- [Decisions.forUser](../../../packages/server/src/decisions.ts#L209) (MethodDeclaration)
- [Decisions.list](../../../packages/server/src/decisions.ts#L215) (MethodDeclaration)
- [Decisions.answer](../../../packages/server/src/decisions.ts#L229) (MethodDeclaration)
- [Decisions.bindAttachments](../../../packages/server/src/decisions.ts#L257) (MethodDeclaration)
- [Decisions.setHold](../../../packages/server/src/decisions.ts#L269) (MethodDeclaration)
- [Decisions.deleteClosed](../../../packages/server/src/decisions.ts#L283) (MethodDeclaration)
- [Decisions.purgeExpired](../../../packages/server/src/decisions.ts#L292) (MethodDeclaration)
- [Decisions.assertOpen](../../../packages/server/src/decisions.ts#L304) (MethodDeclaration)
- [Decisions.forConnection](../../../packages/server/src/decisions.ts#L314) (MethodDeclaration)
- [Decisions.listMine](../../../packages/server/src/decisions.ts#L321) (MethodDeclaration)
- [Decisions.summary](../../../packages/server/src/decisions.ts#L330) (MethodDeclaration)
- [Decisions.create](../../../packages/server/src/decisions.ts#L343) (MethodDeclaration)
- [Decisions.requireCheck](../../../packages/server/src/decisions.ts#L381) (MethodDeclaration)
- [Decisions.checkUsable](../../../packages/server/src/decisions.ts#L399) (MethodDeclaration)
- [Decisions.useCheck](../../../packages/server/src/decisions.ts#L404) (MethodDeclaration)
- [Decisions.amend](../../../packages/server/src/decisions.ts#L409) (MethodDeclaration)
- [Decisions.resume](../../../packages/server/src/decisions.ts#L432) (MethodDeclaration)
- [Decisions.cancel](../../../packages/server/src/decisions.ts#L447) (MethodDeclaration)
- [Decisions.aiView](../../../packages/server/src/decisions.ts#L461) (MethodDeclaration)
- [Decisions.markFetched](../../../packages/server/src/decisions.ts#L466) (MethodDeclaration)
- [Decisions.pendingDeliveries](../../../packages/server/src/decisions.ts#L474) (MethodDeclaration)
- [Decisions.serverDeliveries](../../../packages/server/src/decisions.ts#L486) (MethodDeclaration)
- [Decisions.markSending](../../../packages/server/src/decisions.ts#L493) (MethodDeclaration)
- [Decisions.deferServerDelivery](../../../packages/server/src/decisions.ts#L498) (MethodDeclaration)
- [Decisions.interruptedServerDeliveries](../../../packages/server/src/decisions.ts#L507) (MethodDeclaration)
- [Decisions.reportDelivery](../../../packages/server/src/decisions.ts#L511) (MethodDeclaration)
- [Decisions.startSetupTest](../../../packages/server/src/decisions.ts#L529) (MethodDeclaration)
- [Decisions.confirmSetupTest](../../../packages/server/src/decisions.ts#L558) (MethodDeclaration)
- [displayLabel](../../../packages/server/src/decisions.ts#L583) (FunctionDeclaration)
- [uniqueId](../../../packages/server/src/decisions.ts#L592) (FunctionDeclaration)
- [deliveryText](../../../packages/server/src/decisions.ts#L599) (FunctionDeclaration)

## packages/server/src/diagnostics.ts

import: node:crypto, node:net, @hono/node-server/conninfo, hono, zod, ./db.ts, ./attachments.ts, ./errors.ts

- [Diagnostic](../../../packages/server/src/diagnostics.ts#L36) (TypeAliasDeclaration)
- [DiagnosticInvestigation](../../../packages/server/src/diagnostics.ts#L41) (TypeAliasDeclaration)
- [InvestigationRow](../../../packages/server/src/diagnostics.ts#L42) (TypeAliasDeclaration)
- [investigationOf](../../../packages/server/src/diagnostics.ts#L43) (FunctionDeclaration)
- [canonical](../../../packages/server/src/diagnostics.ts#L46) (FunctionDeclaration)
- [hash](../../../packages/server/src/diagnostics.ts#L51) (FunctionVariable)
- [diagnosticFingerprint](../../../packages/server/src/diagnostics.ts#L52) (FunctionDeclaration)
- [referenceOnly](../../../packages/server/src/diagnostics.ts#L56) (FunctionDeclaration)
- [assessmentNote](../../../packages/server/src/diagnostics.ts#L63) (FunctionDeclaration)
- [diagnosticReportSummary](../../../packages/server/src/diagnostics.ts#L78) (FunctionDeclaration)
- [severity](../../../packages/server/src/diagnostics.ts#L98) (FunctionDeclaration)
- [Diagnostics](../../../packages/server/src/diagnostics.ts#L104) (ClassDeclaration)
- [Diagnostics.constructor](../../../packages/server/src/diagnostics.ts#L106) (Constructor)
- [Diagnostics.removeUser](../../../packages/server/src/diagnostics.ts#L108) (MethodDeclaration)
- [Diagnostics.prune](../../../packages/server/src/diagnostics.ts#L122) (MethodDeclaration)
- [Diagnostics.accept](../../../packages/server/src/diagnostics.ts#L135) (MethodDeclaration)
- [readDiagnostic](../../../packages/server/src/diagnostics.ts#L170) (FunctionDeclaration)
- [privateAddress](../../../packages/server/src/diagnostics.ts#L177) (FunctionDeclaration)
- [diagnosticsAdmin](../../../packages/server/src/diagnostics.ts#L182) (FunctionDeclaration)

## packages/server/src/error-messages-east-asian.ts

import: なし/未解析

定数/設定/スクリプト入口。関数展開なし。

## packages/server/src/error-messages-en.ts

import: なし/未解析

定数/設定/スクリプト入口。関数展開なし。

## packages/server/src/errors.ts

import: ./locales.ts, ./error-messages-east-asian.ts, ./error-messages-en.ts

- [ErrorCode](../../../packages/server/src/errors.ts#L4) (TypeAliasDeclaration)
- [fixedErrorTranslation](../../../packages/server/src/errors.ts#L69) (FunctionDeclaration)
- [ApiError](../../../packages/server/src/errors.ts#L93) (ClassDeclaration)
- [ApiError.constructor](../../../packages/server/src/errors.ts#L99) (Constructor)
- [ApiError.body](../../../packages/server/src/errors.ts#L107) (MethodDeclaration)

## packages/server/src/events.ts

import: node:events, ./db.ts, ./ids.ts

- [UserEvent](../../../packages/server/src/events.ts#L5) (TypeAliasDeclaration)
- [EventHub](../../../packages/server/src/events.ts#L11) (ClassDeclaration)
- [EventHub.constructor](../../../packages/server/src/events.ts#L15) (Constructor)
- [EventHub.publish](../../../packages/server/src/events.ts#L20) (MethodDeclaration)
- [EventHub.subscribeAll](../../../packages/server/src/events.ts#L30) (MethodDeclaration)
- [EventHub.since](../../../packages/server/src/events.ts#L35) (MethodDeclaration)
- [EventHub.subscribe](../../../packages/server/src/events.ts#L40) (MethodDeclaration)
- [EventHub.notifyConnection](../../../packages/server/src/events.ts#L45) (MethodDeclaration)
- [EventHub.subscribeConnection](../../../packages/server/src/events.ts#L49) (MethodDeclaration)
- [EventHub.prune](../../../packages/server/src/events.ts#L54) (MethodDeclaration)

## packages/server/src/http.ts

import: ./locales.ts, ./locale.ts, ./diagnostics.ts, ./oidc.ts, ./onboarding.ts, hono, hono/streaming, zod, ./accounts.ts, ./appstore.ts, ./attachments.ts, ./db.ts, ./errors.ts, ./events.ts, ./decisions.ts, ./ids.ts, ./remote-mcp.ts

- [Services](../../../packages/server/src/http.ts#L19) (TypeAliasDeclaration)
- [untilWake](../../../packages/server/src/http.ts#L26) (FunctionDeclaration)
- [resume](../../../packages/server/src/http.ts#L29) (FunctionVariable)
- [bearer](../../../packages/server/src/http.ts#L35) (FunctionDeclaration)
- [body](../../../packages/server/src/http.ts#L40) (FunctionDeclaration)
- [idempotent](../../../packages/server/src/http.ts#L50) (FunctionDeclaration)
- [fileResponse](../../../packages/server/src/http.ts#L75) (FunctionDeclaration)
- [createApp](../../../packages/server/src/http.ts#L87) (FunctionDeclaration)
- [files](../../../packages/server/src/http.ts#L89) (FunctionVariable)
- [sweep](../../../packages/server/src/http.ts#L94) (FunctionVariable)
- [signIn](../../../packages/server/src/http.ts#L121) (FunctionVariable)
- [back](../../../packages/server/src/http.ts#L147) (FunctionVariable)
- [stop](../../../packages/server/src/http.ts#L229) (FunctionVariable)
- [routeChannel](../../../packages/server/src/http.ts#L336) (FunctionVariable)
- [stop](../../../packages/server/src/http.ts#L407) (FunctionVariable)

## packages/server/src/ids.ts

import: node:crypto

- [pick](../../../packages/server/src/ids.ts#L6) (FunctionDeclaration)
- [uuid](../../../packages/server/src/ids.ts#L12) (FunctionVariable)
- [now](../../../packages/server/src/ids.ts#L13) (FunctionVariable)
- [decisionId](../../../packages/server/src/ids.ts#L14) (FunctionVariable)
- [pairingCode](../../../packages/server/src/ids.ts#L15) (FunctionVariable)
- [testCode](../../../packages/server/src/ids.ts#L16) (FunctionVariable)
- [secret](../../../packages/server/src/ids.ts#L17) (FunctionVariable)
- [hash](../../../packages/server/src/ids.ts#L18) (FunctionVariable)
- [normalizePairingCode](../../../packages/server/src/ids.ts#L21) (FunctionDeclaration)
- [normalizeTitle](../../../packages/server/src/ids.ts#L28) (FunctionDeclaration)

## packages/server/src/locale.ts

import: ./locales.ts

- [requestLocale](../../../packages/server/src/locale.ts#L3) (FunctionDeclaration)

## packages/server/src/locales.ts

import: なし/未解析

- [Locale](../../../packages/server/src/locales.ts#L2) (TypeAliasDeclaration)
- [supportedLocale](../../../packages/server/src/locales.ts#L4) (FunctionDeclaration)

## packages/server/src/main.ts

import: ./diagnostics.ts, ./push.ts, @hono/node-server, node:fs, node:path, node:url, hono, ./accounts.ts, ./attachments.ts, ./db.ts, ./decisions.ts, ./events.ts, ./appstore.ts, ./http.ts, ./callbridge.ts

- [staticHandler](../../../packages/server/src/main.ts#L51) (FunctionDeclaration)
- [finish](../../../packages/server/src/main.ts#L139) (FunctionVariable)

## packages/server/src/oidc.ts

import: node:crypto, ./errors.ts

- [Provider](../../../packages/server/src/oidc.ts#L6) (TypeAliasDeclaration)
- [Jwk](../../../packages/server/src/oidc.ts#L7) (TypeAliasDeclaration)
- [KeySource](../../../packages/server/src/oidc.ts#L8) (TypeAliasDeclaration)
- [fetchKeys](../../../packages/server/src/oidc.ts#L20) (FunctionVariable)
- [keyFor](../../../packages/server/src/oidc.ts#L26) (FunctionDeclaration)
- [decode](../../../packages/server/src/oidc.ts#L32) (FunctionVariable)
- [sha256hex](../../../packages/server/src/oidc.ts#L33) (FunctionVariable)
- [verifyIdToken](../../../packages/server/src/oidc.ts#L35) (FunctionDeclaration)
- [invalid](../../../packages/server/src/oidc.ts#L37) (FunctionVariable)
- [resetKeyCache](../../../packages/server/src/oidc.ts#L59) (FunctionDeclaration)

## packages/server/src/onboarding.ts

import: ./locales.ts

- [Step](../../../packages/server/src/onboarding.ts#L6) (TypeAliasDeclaration)
- [Guide](../../../packages/server/src/onboarding.ts#L7) (TypeAliasDeclaration)
- [onboarding](../../../packages/server/src/onboarding.ts#L16) (FunctionDeclaration)

## packages/server/src/push.ts

import: ./locales.ts, node:http2, node:crypto, ./db.ts, ./decisions.ts, ./events.ts

- [ApnsConfig](../../../packages/server/src/push.ts#L10) (TypeAliasDeclaration)
- [Send](../../../packages/server/src/push.ts#L11) (TypeAliasDeclaration)
- [Apns](../../../packages/server/src/push.ts#L16) (ClassDeclaration)
- [enc](../../../packages/server/src/push.ts#L29) (FunctionVariable)
- [Notifier](../../../packages/server/src/push.ts#L68) (ClassDeclaration)
- [Notifier.constructor](../../../packages/server/src/push.ts#L72) (Constructor)
- [Notifier.handle](../../../packages/server/src/push.ts#L78) (MethodDeclaration)

## packages/server/src/remote-mcp.ts

import: @modelcontextprotocol/sdk/server/index.js, @modelcontextprotocol/sdk/server/webStandardStreamableHttp.js, @modelcontextprotocol/sdk/types.js, hono, zod, ./accounts.ts, ./attachments.ts, ./decisions.ts, ./errors.ts

- [RemoteMcpOptions](../../../packages/server/src/remote-mcp.ts#L14) (TypeAliasDeclaration)
- [tools](../../../packages/server/src/remote-mcp.ts#L33) (FunctionDeclaration)
- [describe](../../../packages/server/src/remote-mcp.ts#L120) (FunctionDeclaration)
- [result](../../../packages/server/src/remote-mcp.ts#L127) (FunctionDeclaration)
- [buildServer](../../../packages/server/src/remote-mcp.ts#L136) (FunctionDeclaration)
- [remoteMcpHandler](../../../packages/server/src/remote-mcp.ts#L235) (FunctionDeclaration)

## packages/web/playwright.config.ts

import: @playwright/test

定数/設定/スクリプト入口。関数展開なし。

## packages/web/src/api.ts

import: ./i18n.ts, ./types

- [getSession](../../../packages/web/src/api.ts#L6) (FunctionDeclaration)
- [setSession](../../../packages/web/src/api.ts#L9) (FunctionDeclaration)
- [ApiError](../../../packages/web/src/api.ts#L13) (ClassDeclaration)
- [ApiError.constructor](../../../packages/web/src/api.ts#L16) (Constructor)
- [onUnauthorized](../../../packages/web/src/api.ts#L23) (FunctionVariable)
- [setUnauthorizedHandler](../../../packages/web/src/api.ts#L24) (FunctionVariable)
- [api](../../../packages/web/src/api.ts#L26) (FunctionDeclaration)
- [failure](../../../packages/web/src/api.ts#L51) (FunctionDeclaration)
- [uploadAttachment](../../../packages/web/src/api.ts#L58) (FunctionDeclaration)
- [fetchAttachment](../../../packages/web/src/api.ts#L77) (FunctionDeclaration)
- [subscribeEvents](../../../packages/web/src/api.ts#L89) (FunctionDeclaration)

## packages/web/src/format.ts

import: ./i18n.ts

- [clientLabel](../../../packages/web/src/format.ts#L5) (FunctionVariable)
- [ago](../../../packages/web/src/format.ts#L15) (FunctionDeclaration)
- [dateTime](../../../packages/web/src/format.ts#L22) (FunctionDeclaration)
- [deadlineText](../../../packages/web/src/format.ts#L25) (FunctionDeclaration)

## packages/web/src/i18n.ts

import: ../../server/src/errors.ts, preact/hooks, ./messages.ts, ./messages-east-asian.ts, ./locales.ts

- [LanguagePreference](../../../packages/web/src/i18n.ts#L9) (TypeAliasDeclaration)
- [resolveLocale](../../../packages/web/src/i18n.ts#L11) (FunctionDeclaration)
- [storedPreference](../../../packages/web/src/i18n.ts#L19) (FunctionDeclaration)
- [languagePreference](../../../packages/web/src/i18n.ts#L25) (FunctionVariable)
- [locale](../../../packages/web/src/i18n.ts#L26) (FunctionVariable)
- [changed](../../../packages/web/src/i18n.ts#L27) (FunctionDeclaration)
- [setLanguage](../../../packages/web/src/i18n.ts#L31) (FunctionDeclaration)
- [useLocale](../../../packages/web/src/i18n.ts#L41) (FunctionDeclaration)
- [notify](../../../packages/web/src/i18n.ts#L43) (FunctionVariable)
- [translate](../../../packages/web/src/i18n.ts#L46) (FunctionDeclaration)
- [t](../../../packages/web/src/i18n.ts#L52) (FunctionVariable)
- [labels](../../../packages/web/src/i18n.ts#L54) (FunctionDeclaration)
- [relative](../../../packages/web/src/i18n.ts#L57) (FunctionDeclaration)
- [days](../../../packages/web/src/i18n.ts#L60) (FunctionDeclaration)
- [UiMessage](../../../packages/web/src/i18n.ts#L64) (TypeAliasDeclaration)
- [systemMessage](../../../packages/web/src/i18n.ts#L69) (FunctionDeclaration)

## packages/web/src/idlogin.tsx

import: ./i18n.ts, preact/hooks, ./api

- [Config](../../../packages/web/src/idlogin.tsx#L7) (TypeAliasDeclaration)
- [Result](../../../packages/web/src/idlogin.tsx#L8) (TypeAliasDeclaration)
- [Window](../../../packages/web/src/idlogin.tsx#L11) (InterfaceDeclaration)
- [loadScript](../../../packages/web/src/idlogin.tsx#L18) (FunctionDeclaration)
- [loginConfig](../../../packages/web/src/idlogin.tsx#L28) (FunctionVariable)
- [IdLogin](../../../packages/web/src/idlogin.tsx#L30) (FunctionDeclaration)
- [send](../../../packages/web/src/idlogin.tsx#L37) (FunctionVariable)
- [apple](../../../packages/web/src/idlogin.tsx#L48) (FunctionDeclaration)

## packages/web/src/locales.ts

import: なし/未解析

- [Locale](../../../packages/web/src/locales.ts#L2) (TypeAliasDeclaration)
- [supportedLocale](../../../packages/web/src/locales.ts#L4) (FunctionDeclaration)

## packages/web/src/main.tsx

import: ./i18n.ts, preact, preact/hooks, ./api, ./router, ./store, ./pages/Connections, ./pages/DecisionView, ./pages/History, ./pages/Inbox, ./pages/Settings, ./idlogin, ./style.css

- [Login](../../../packages/web/src/main.tsx#L15) (FunctionDeclaration)
- [Nav](../../../packages/web/src/main.tsx#L29) (FunctionDeclaration)
- [item](../../../packages/web/src/main.tsx#L33) (FunctionVariable)
- [LanguagePicker](../../../packages/web/src/main.tsx#L46) (FunctionDeclaration)
- [App](../../../packages/web/src/main.tsx#L53) (FunctionDeclaration)
- [onVisible](../../../packages/web/src/main.tsx#L63) (FunctionVariable)

## packages/web/src/messages-east-asian.ts

import: ./messages.ts

定数/設定/スクリプト入口。関数展開なし。

## packages/web/src/messages.ts

import: なし/未解析

- [MessageKey](../../../packages/web/src/messages.ts#L39) (TypeAliasDeclaration)

## packages/web/src/pages/Attachments.tsx

import: ../i18n.ts, preact/hooks, ../api, ../types

- [typeOf](../../../packages/web/src/pages/Attachments.tsx#L22) (FunctionDeclaration)
- [bytes](../../../packages/web/src/pages/Attachments.tsx#L28) (FunctionDeclaration)
- [useDraftAttachments](../../../packages/web/src/pages/Attachments.tsx#L35) (FunctionDeclaration)
- [add](../../../packages/web/src/pages/Attachments.tsx#L48) (FunctionDeclaration)
- [remove](../../../packages/web/src/pages/Attachments.tsx#L71) (FunctionDeclaration)
- [AttachmentList](../../../packages/web/src/pages/Attachments.tsx#L85) (FunctionDeclaration)
- [AttachmentItem](../../../packages/web/src/pages/Attachments.tsx#L94) (FunctionDeclaration)
- [save](../../../packages/web/src/pages/Attachments.tsx#L111) (FunctionDeclaration)
- [RequestImages](../../../packages/web/src/pages/Attachments.tsx#L137) (FunctionDeclaration)
- [RequestImage](../../../packages/web/src/pages/Attachments.tsx#L141) (FunctionDeclaration)

## packages/web/src/pages/Connections.tsx

import: ../i18n.ts, preact/hooks, ../api, ../router, ../store, ../format, ../types

- [CopyLine](../../../packages/web/src/pages/Connections.tsx#L11) (FunctionDeclaration)
- [SetupGuide](../../../packages/web/src/pages/Connections.tsx#L23) (FunctionDeclaration)
- [checkLine](../../../packages/web/src/pages/Connections.tsx#L34) (FunctionDeclaration)
- [Connections](../../../packages/web/src/pages/Connections.tsx#L44) (FunctionDeclaration)
- [revoke](../../../packages/web/src/pages/Connections.tsx#L50) (FunctionDeclaration)
- [Pair](../../../packages/web/src/pages/Connections.tsx#L97) (FunctionDeclaration)
- [decide](../../../packages/web/src/pages/Connections.tsx#L106) (FunctionDeclaration)

## packages/web/src/pages/DecisionView.tsx

import: ../i18n.ts, preact/hooks, ../api, ../router, ../store, ../format, ../types, ./Source, ./Attachments

- [PlainText](../../../packages/web/src/pages/DecisionView.tsx#L12) (FunctionDeclaration)
- [DecisionView](../../../packages/web/src/pages/DecisionView.tsx#L23) (FunctionDeclaration)
- [act](../../../packages/web/src/pages/DecisionView.tsx#L66) (FunctionDeclaration)
- [copyResume](../../../packages/web/src/pages/DecisionView.tsx#L86) (FunctionDeclaration)

## packages/web/src/pages/History.tsx

import: ../i18n.ts, preact/hooks, ../api, ../router, ../store, ../format, ./Source

- [History](../../../packages/web/src/pages/History.tsx#L9) (FunctionDeclaration)
- [deleteAll](../../../packages/web/src/pages/History.tsx#L13) (FunctionDeclaration)

## packages/web/src/pages/Inbox.tsx

import: ../i18n.ts, ../router, ../store, ../format, ../types, ./Source

- [DecisionCard](../../../packages/web/src/pages/Inbox.tsx#L8) (FunctionDeclaration)
- [Inbox](../../../packages/web/src/pages/Inbox.tsx#L28) (FunctionDeclaration)

## packages/web/src/pages/Settings.tsx

import: ../i18n.ts, preact/hooks, ../api, ../router, ../store, ../format

- [Settings](../../../packages/web/src/pages/Settings.tsx#L9) (FunctionDeclaration)
- [setRetention](../../../packages/web/src/pages/Settings.tsx#L16) (FunctionDeclaration)
- [deleteHistory](../../../packages/web/src/pages/Settings.tsx#L19) (FunctionDeclaration)
- [deleteAccount](../../../packages/web/src/pages/Settings.tsx#L25) (FunctionDeclaration)
- [logout](../../../packages/web/src/pages/Settings.tsx#L30) (FunctionDeclaration)

## packages/web/src/pages/Source.tsx

import: ../format, ../types

- [Source](../../../packages/web/src/pages/Source.tsx#L8) (FunctionDeclaration)

## packages/web/src/router.ts

import: preact/hooks

- [navigate](../../../packages/web/src/router.ts#L3) (FunctionDeclaration)
- [useLocation](../../../packages/web/src/router.ts#L8) (FunctionDeclaration)
- [update](../../../packages/web/src/router.ts#L11) (FunctionVariable)
- [linkProps](../../../packages/web/src/router.ts#L19) (FunctionDeclaration)

## packages/web/src/store.ts

import: preact/hooks, ./api, ./types

- [Listener](../../../packages/web/src/store.ts#L5) (TypeAliasDeclaration)
- [bump](../../../packages/web/src/store.ts#L10) (FunctionDeclaration)
- [useBump](../../../packages/web/src/store.ts#L15) (FunctionDeclaration)
- [listener](../../../packages/web/src/store.ts#L18) (FunctionVariable)
- [useResource](../../../packages/web/src/store.ts#L25) (FunctionDeclaration)
- [loadOpen](../../../packages/web/src/store.ts#L36) (FunctionVariable)
- [loadClosed](../../../packages/web/src/store.ts#L37) (FunctionVariable)
- [loadMe](../../../packages/web/src/store.ts#L38) (FunctionVariable)

## packages/web/src/types.ts

import: なし/未解析

- [Option](../../../packages/web/src/types.ts#L1) (TypeAliasDeclaration)
- [Attachment](../../../packages/web/src/types.ts#L2) (TypeAliasDeclaration)
- [HistoryEntry](../../../packages/web/src/types.ts#L3) (TypeAliasDeclaration)
- [Decision](../../../packages/web/src/types.ts#L4) (TypeAliasDeclaration)
- [Check](../../../packages/web/src/types.ts#L16) (TypeAliasDeclaration)
- [Me](../../../packages/web/src/types.ts#L17) (TypeAliasDeclaration)
- [Connection](../../../packages/web/src/types.ts#L18) (TypeAliasDeclaration)
- [ApiErrorBody](../../../packages/web/src/types.ts#L19) (TypeAliasDeclaration)

## packages/web/src/vite-env.d.ts

import: なし/未解析

定数/設定/スクリプト入口。関数展開なし。

## packages/web/vite.config.ts

import: vite, @preact/preset-vite

定数/設定/スクリプト入口。関数展開なし。

## tools/deploy/block-public-admin.py

import: なし/未解析

定数/設定/スクリプト入口。関数展開なし。

## tools/deploy/diagnostic-trigger-smoke.mjs

import: node:assert/strict, node:fs, node:crypto, /app/server/dist/db.js, /app/server/dist/accounts.js, /app/server/dist/events.js

- [send](../../../tools/deploy/diagnostic-trigger-smoke.mjs#L13) (FunctionVariable)

## tools/deploy/diagnostics-admin.py

import: なし/未解析

定数/設定/スクリプト入口。関数展開なし。

## tools/deploy/node-release/install.sh

import: なし/未解析

定数/設定/スクリプト入口。関数展開なし。

## tools/deploy/node-release/test-verification.sh

import: なし/未解析

定数/設定/スクリプト入口。関数展開なし。

## tools/deploy/node-release/verify.sh

import: なし/未解析

定数/設定/スクリプト入口。関数展開なし。

## tools/deploy/start-with-secrets.sh

import: なし/未解析

定数/設定/スクリプト入口。関数展開なし。

## tools/e2e/bundle.mjs

import: esbuild, node:url

定数/設定/スクリプト入口。関数展開なし。

## tools/e2e/claude-binary.mjs

import: node:child_process

- [claudeBinaryForShell](../../../tools/e2e/claude-binary.mjs#L5) (FunctionDeclaration)

## tools/e2e/codex-consumer-migration.mjs

import: node:assert/strict, node:fs, node:path, aiterm-steer-delivery, ../../packages/connector/src/profile.ts, ../../packages/connector/src/harness.ts

- [group](../../../tools/e2e/codex-consumer-migration.mjs#L17) (FunctionVariable)
- [rpc](../../../tools/e2e/codex-consumer-migration.mjs#L25) (FunctionVariable)
- [list](../../../tools/e2e/codex-consumer-migration.mjs#L26) (FunctionVariable)
- [normalized](../../../tools/e2e/codex-consumer-migration.mjs#L41) (FunctionVariable)

## tools/e2e/parent-e2e.mjs

import: @hono/node-server, @modelcontextprotocol/sdk/client/index.js, @modelcontextprotocol/sdk/client/stdio.js, aiterm-steer-delivery, node:child_process, node:crypto, node:fs, node:os, node:path, node:url, ../../packages/server/src/accounts.ts, ../../packages/server/src/db.ts, ../../packages/server/src/decisions.ts, ../../packages/server/src/events.ts, ../../packages/server/src/http.ts, ../../packages/connector/src/profile.ts, ./claude-binary.mjs

- [sleep](../../../tools/e2e/parent-e2e.mjs#L33) (FunctionVariable)
- [log](../../../tools/e2e/parent-e2e.mjs#L34) (FunctionVariable)
- [openOf](../../../tools/e2e/parent-e2e.mjs#L105) (FunctionVariable)
- [waitFor](../../../tools/e2e/parent-e2e.mjs#L106) (FunctionVariable)
- [waitDecision](../../../tools/e2e/parent-e2e.mjs#L112) (FunctionVariable)
- [answer](../../../tools/e2e/parent-e2e.mjs#L113) (FunctionVariable)
- [deliveryOf](../../../tools/e2e/parent-e2e.mjs#L114) (FunctionVariable)
- [call](../../../tools/e2e/parent-e2e.mjs#L122) (FunctionVariable)
- [clean](../../../tools/e2e/parent-e2e.mjs#L123) (FunctionVariable)
- [screen](../../../tools/e2e/parent-e2e.mjs#L125) (FunctionVariable)
- [cursorTranscript](../../../tools/e2e/parent-e2e.mjs#L132) (FunctionVariable)
- [grokTranscript](../../../tools/e2e/parent-e2e.mjs#L152) (FunctionVariable)
- [transcript](../../../tools/e2e/parent-e2e.mjs#L169) (FunctionVariable)
- [waitScreen](../../../tools/e2e/parent-e2e.mjs#L170) (FunctionVariable)
- [send](../../../tools/e2e/parent-e2e.mjs#L175) (FunctionVariable)
- [channelsOf](../../../tools/e2e/parent-e2e.mjs#L284) (FunctionVariable)
- [liveBound](../../../tools/e2e/parent-e2e.mjs#L292) (FunctionVariable)

## tools/e2e/session-routing-production.mjs

import: node:assert/strict, node:fs, node:path, @modelcontextprotocol/sdk/client/index.js, @modelcontextprotocol/sdk/client/stdio.js, aiterm-steer-delivery, ../../packages/connector/src/profile.ts

- [call](../../../tools/e2e/session-routing-production.mjs#L13) (FunctionVariable)
- [delay](../../../tools/e2e/session-routing-production.mjs#L25) (FunctionVariable)

## tools/e2e/session-routing-smoke.mjs

import: node:assert/strict, node:http, node:fs, node:os, node:path, node:url, @modelcontextprotocol/sdk/client/index.js, @modelcontextprotocol/sdk/client/stdio.js, node:fs

定数/設定/スクリプト入口。関数展開なし。

