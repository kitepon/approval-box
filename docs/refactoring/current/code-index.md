# 実ファイル・関数の対応（現状）

基準commit: 90066748bf7ca4686716c67c91d76fcd20afa519。静的import・宣言の全件一覧。呼出し順とデータ所有者は各機能詳細を参照。動的呼出しの完全解析を主張しない。Python/shellは対象一覧のみで関数展開は未調査。

## packages/connector/scripts/build.mjs

import: esbuild, node:fs, node:path

定数/設定/スクリプト入口。関数展開なし。

## packages/connector/src/api.ts

import: ./config.ts

- [ServerError](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/api.ts#L3) (ClassDeclaration)
- [ServerError.constructor](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/api.ts#L7) (Constructor)
- [Api](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/api.ts#L16) (ClassDeclaration)
- [Api.constructor](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/api.ts#L20) (Constructor)
- [Api.url](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/api.ts#L25) (MethodDeclaration)
- [Api.call](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/api.ts#L29) (MethodDeclaration)
- [Api.uploadRequestImage](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/api.ts#L63) (MethodDeclaration)
- [Api.download](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/api.ts#L73) (MethodDeclaration)
- [Api.stream](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/api.ts#L86) (MethodDeclaration)

## packages/connector/src/attachments.ts

import: node:crypto, node:fs, node:path, ./api.ts, ./profile.ts

- [AttachmentMeta](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/attachments.ts#L9) (TypeAliasDeclaration)
- [attachmentsRoot](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/attachments.ts#L13) (FunctionVariable)
- [safeFileName](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/attachments.ts#L16) (FunctionDeclaration)
- [saveAttachment](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/attachments.ts#L22) (FunctionDeclaration)
- [saveAll](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/attachments.ts#L34) (FunctionDeclaration)
- [pruneAttachments](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/attachments.ts#L47) (FunctionDeclaration)
- [sha256](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/attachments.ts#L57) (FunctionVariable)

## packages/connector/src/channel-delivery.ts

import: aiterm-steer-delivery, ./profile.ts

- [CodexParent](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/channel-delivery.ts#L4) (TypeAliasDeclaration)
- [CodexProvider](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/channel-delivery.ts#L5) (TypeAliasDeclaration)
- [sendChannelAnswer](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/channel-delivery.ts#L15) (FunctionDeclaration)
- [channelAnswerState](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/channel-delivery.ts#L35) (FunctionDeclaration)

## packages/connector/src/claude-channel.ts

import: node:fs, node:path, aiterm-steer-delivery

- [ClaudeParent](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/claude-channel.ts#L5) (TypeAliasDeclaration)
- [Profile](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/claude-channel.ts#L6) (TypeAliasDeclaration)
- [claudeChannelIsCurrent](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/claude-channel.ts#L17) (FunctionDeclaration)

## packages/connector/src/cli.ts

import: node:fs, node:os, node:path, node:readline/promises, qrcode, ./api.ts, ./config.ts, ./daemon.ts, ./harness.ts, ./instructions.ts, ./mcp.ts, ./profile.ts, ./runtime.ts, ./version.ts

- [flag](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/cli.ts#L19) (FunctionVariable)
- [option](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/cli.ts#L20) (FunctionVariable)
- [out](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/cli.ts#L24) (FunctionVariable)
- [Check](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/cli.ts#L26) (TypeAliasDeclaration)
- [ask](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/cli.ts#L36) (FunctionDeclaration)
- [installRuntime](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/cli.ts#L42) (FunctionDeclaration)
- [selectedTargets](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/cli.ts#L52) (FunctionDeclaration)
- [pair](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/cli.ts#L62) (FunctionDeclaration)
- [waitForChecks](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/cli.ts#L83) (FunctionDeclaration)
- [setup](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/cli.ts#L105) (FunctionDeclaration)
- [registerTargets](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/cli.ts#L156) (FunctionDeclaration)
- [uninstall](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/cli.ts#L170) (FunctionDeclaration)
- [status](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/cli.ts#L188) (FunctionDeclaration)
- [doctor](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/cli.ts#L207) (FunctionDeclaration)
- [test](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/cli.ts#L240) (FunctionDeclaration)
- [help](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/cli.ts#L248) (FunctionDeclaration)
- [cursorContext](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/cli.ts#L260) (FunctionDeclaration)

## packages/connector/src/config.ts

import: node:fs, node:path, ./profile.ts

- [Config](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/config.ts#L5) (TypeAliasDeclaration)
- [configFile](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/config.ts#L8) (FunctionVariable)
- [readConfig](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/config.ts#L10) (FunctionDeclaration)
- [requireConfig](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/config.ts#L15) (FunctionDeclaration)
- [writeJsonFile](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/config.ts#L21) (FunctionDeclaration)
- [writeConfig](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/config.ts#L28) (FunctionDeclaration)

## packages/connector/src/cursor-binding.ts

import: aiterm-steer-delivery

- [bindCursorResult](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/cursor-binding.ts#L4) (FunctionDeclaration)

## packages/connector/src/daemon-launch.ts

import: node:child_process, node:fs, node:path, ./profile.ts

- [windowsDaemonLaunchScript](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/daemon-launch.ts#L7) (FunctionDeclaration)
- [literal](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/daemon-launch.ts#L12) (FunctionVariable)
- [launchDaemon](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/daemon-launch.ts#L17) (FunctionDeclaration)

## packages/connector/src/daemon.ts

import: aiterm-steer-delivery, ./daemon-launch.ts, ./channel-delivery.ts, node:fs, node:path, ./api.ts, ./attachments.ts, ./config.ts, ./profile.ts, ./runtime.ts

- [Delivery](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/daemon.ts#L12) (TypeAliasDeclaration)
- [Entry](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/daemon.ts#L13) (TypeAliasDeclaration)
- [Journal](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/daemon.ts#L17) (TypeAliasDeclaration)
- [lockFile](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/daemon.ts#L19) (FunctionVariable)
- [journalFile](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/daemon.ts#L20) (FunctionVariable)
- [alive](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/daemon.ts#L23) (FunctionDeclaration)
- [daemonStatus](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/daemon.ts#L27) (FunctionDeclaration)
- [versionOfEntry](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/daemon.ts#L36) (FunctionDeclaration)
- [shouldReplaceDaemon](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/daemon.ts#L45) (FunctionDeclaration)
- [daemonNode](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/daemon.ts#L58) (FunctionDeclaration)
- [ensureDaemon](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/daemon.ts#L63) (FunctionDeclaration)
- [sleep](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/daemon.ts#L76) (FunctionVariable)
- [runDaemon](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/daemon.ts#L78) (FunctionDeclaration)
- [save](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/daemon.ts#L91) (FunctionVariable)
- [log](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/daemon.ts#L92) (FunctionVariable)
- [report](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/daemon.ts#L105) (FunctionDeclaration)
- [deliver](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/daemon.ts#L116) (FunctionDeclaration)
- [safeState](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/daemon.ts#L140) (FunctionDeclaration)
- [checkQueued](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/daemon.ts#L144) (FunctionDeclaration)
- [sync](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/daemon.ts#L162) (FunctionDeclaration)
- [releaseLock](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/daemon.ts#L202) (FunctionVariable)
- [stop](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/daemon.ts#L210) (FunctionVariable)

## packages/connector/src/harness.ts

import: aiterm-steer-delivery, node:child_process, node:fs, node:os, node:path, ./config.ts, ./instructions.ts, ./profile.ts, ./runtime.ts

- [Target](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/harness.ts#L12) (TypeAliasDeclaration)
- [claudeDir](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/harness.ts#L16) (FunctionVariable)
- [claudeJson](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/harness.ts#L17) (FunctionVariable)
- [cursorDir](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/harness.ts#L18) (FunctionVariable)
- [codexHome](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/harness.ts#L19) (FunctionVariable)
- [grokDir](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/harness.ts#L20) (FunctionVariable)
- [filesOf](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/harness.ts#L23) (FunctionDeclaration)
- [instructionsFileOf](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/harness.ts#L31) (FunctionDeclaration)
- [onPath](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/harness.ts#L38) (FunctionDeclaration)
- [detect](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/harness.ts#L46) (FunctionDeclaration)
- [stableNode](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/harness.ts#L57) (FunctionDeclaration)
- [cursorCliConfig](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/harness.ts#L63) (FunctionVariable)
- [setCursorPermissions](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/harness.ts#L64) (FunctionDeclaration)
- [setCursorContext](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/harness.ts#L81) (FunctionDeclaration)
- [ours](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/harness.ts#L88) (FunctionVariable)
- [cursorContextRegistered](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/harness.ts#L94) (FunctionVariable)
- [registration](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/harness.ts#L96) (FunctionVariable)
- [readJson](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/harness.ts#L98) (FunctionDeclaration)
- [backupOnce](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/harness.ts#L103) (FunctionDeclaration)
- [setMcpJson](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/harness.ts#L108) (FunctionDeclaration)
- [withCodexConfig](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/harness.ts#L117) (FunctionDeclaration)
- [RegisterResult](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/harness.ts#L121) (TypeAliasDeclaration)
- [register](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/harness.ts#L123) (FunctionDeclaration)
- [registerTools](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/harness.ts#L135) (FunctionDeclaration)
- [hook](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/harness.ts#L136) (FunctionVariable)
- [unregister](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/harness.ts#L173) (FunctionDeclaration)
- [registered](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/harness.ts#L203) (FunctionDeclaration)
- [registeredTools](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/harness.ts#L212) (FunctionDeclaration)
- [entryOf](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/harness.ts#L213) (FunctionVariable)
- [configDirOf](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/harness.ts#L233) (FunctionVariable)

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

- [hasInstructions](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/instructions.ts#L20) (FunctionDeclaration)
- [hasInstructionsInDir](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/instructions.ts#L33) (FunctionDeclaration)
- [managedElsewhere](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/instructions.ts#L47) (FunctionDeclaration)
- [writeInstructions](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/instructions.ts#L56) (FunctionDeclaration)
- [removeInstructions](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/instructions.ts#L65) (FunctionDeclaration)

## packages/connector/src/mcp.ts

import: @modelcontextprotocol/sdk/server/index.js, @modelcontextprotocol/sdk/server/stdio.js, @modelcontextprotocol/sdk/types.js, aiterm-steer-delivery, node:fs, node:path, ./api.ts, ./attachments.ts, ./config.ts, ./daemon.ts, ./request-images.ts, ./runtime.ts, ./claude-channel.ts, ./profile.ts, ./version.ts

- [Harness](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/mcp.ts#L17) (TypeAliasDeclaration)
- [harnessOf](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/mcp.ts#L21) (FunctionDeclaration)
- [ParentKey](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/mcp.ts#L133) (TypeAliasDeclaration)
- [parentsFile](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/mcp.ts#L134) (FunctionVariable)
- [savedParents](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/mcp.ts#L138) (FunctionDeclaration)
- [reuse](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/mcp.ts#L142) (FunctionDeclaration)
- [remember](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/mcp.ts#L148) (FunctionDeclaration)
- [channelFor](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/mcp.ts#L157) (FunctionDeclaration)
- [named](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/mcp.ts#L204) (FunctionDeclaration)
- [receiveGuide](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/mcp.ts#L210) (FunctionDeclaration)
- [announced](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/mcp.ts#L227) (FunctionDeclaration)
- [text](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/mcp.ts#L231) (FunctionDeclaration)
- [describe](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/mcp.ts#L235) (FunctionDeclaration)
- [runMcp](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/mcp.ts#L245) (FunctionDeclaration)

## packages/connector/src/profile.ts

import: aiterm-steer-delivery, node:os, node:path

- [home](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/profile.ts#L11) (FunctionVariable)
- [stateRoot](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/profile.ts#L12) (FunctionVariable)

## packages/connector/src/request-images.ts

import: node:fs/promises, node:path, ./api.ts

- [imageType](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/request-images.ts#L7) (FunctionDeclaration)
- [uploadImagePaths](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/request-images.ts#L17) (FunctionDeclaration)

## packages/connector/src/runtime.ts

import: node:path, node:url, ./profile.ts

- [runtimeDir](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/runtime.ts#L6) (FunctionVariable)
- [runtimeEntry](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/runtime.ts#L12) (FunctionDeclaration)

## packages/connector/src/version.ts

import: なし/未解析

- [osName](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/connector/src/version.ts#L5) (FunctionDeclaration)

## packages/server/src/accounts.ts

import: ./locales.ts, node:crypto, ./db.ts, ./errors.ts, ./events.ts, ./ids.ts, ./decisions.ts, ./diagnostics.ts

- [effectivePlan](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/accounts.ts#L15) (FunctionDeclaration)
- [UserRow](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/accounts.ts#L19) (TypeAliasDeclaration)
- [ConnectionRow](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/accounts.ts#L20) (TypeAliasDeclaration)
- [PairingRow](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/accounts.ts#L21) (TypeAliasDeclaration)
- [CheckRow](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/accounts.ts#L22) (TypeAliasDeclaration)
- [BillingMode](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/accounts.ts#L24) (TypeAliasDeclaration)
- [Accounts](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/accounts.ts#L26) (ClassDeclaration)
- [Accounts.constructor](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/accounts.ts#L31) (Constructor)
- [Accounts.createUser](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/accounts.ts#L39) (MethodDeclaration)
- [Accounts.issueSession](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/accounts.ts#L45) (MethodDeclaration)
- [Accounts.userBySession](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/accounts.ts#L52) (MethodDeclaration)
- [Accounts.createAppCode](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/accounts.ts#L63) (MethodDeclaration)
- [Accounts.redeemAppCode](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/accounts.ts#L70) (MethodDeclaration)
- [Accounts.startAuthFlow](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/accounts.ts#L83) (MethodDeclaration)
- [Accounts.takeAuthFlow](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/accounts.ts#L93) (MethodDeclaration)
- [Accounts.bindAuthFlow](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/accounts.ts#L102) (MethodDeclaration)
- [Accounts.signInWithIdentity](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/accounts.ts#L110) (MethodDeclaration)
- [Accounts.revokeSession](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/accounts.ts#L119) (MethodDeclaration)
- [Accounts.deleteUser](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/accounts.ts#L123) (MethodDeclaration)
- [Accounts.me](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/accounts.ts#L130) (MethodDeclaration)
- [Accounts.settings](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/accounts.ts#L160) (MethodDeclaration)
- [Accounts.updateSettings](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/accounts.ts#L165) (MethodDeclaration)
- [Accounts.assertCanUse](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/accounts.ts#L170) (MethodDeclaration)
- [Accounts.setPlan](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/accounts.ts#L177) (MethodDeclaration)
- [Accounts.assertSetupVerified](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/accounts.ts#L181) (MethodDeclaration)
- [Accounts.connections](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/accounts.ts#L188) (MethodDeclaration)
- [Accounts.createConnection](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/accounts.ts#L195) (MethodDeclaration)
- [Accounts.registerDevice](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/accounts.ts#L205) (MethodDeclaration)
- [Accounts.removeDevice](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/accounts.ts#L219) (MethodDeclaration)
- [Accounts.issueToken](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/accounts.ts#L226) (MethodDeclaration)
- [Accounts.tokens](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/accounts.ts#L232) (MethodDeclaration)
- [Accounts.revokeToken](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/accounts.ts#L237) (MethodDeclaration)
- [Accounts.revokeConnection](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/accounts.ts#L242) (MethodDeclaration)
- [Accounts.connectionByToken](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/accounts.ts#L249) (MethodDeclaration)
- [Accounts.updateConnectionClients](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/accounts.ts#L257) (MethodDeclaration)
- [Accounts.connectionInfo](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/accounts.ts#L262) (MethodDeclaration)
- [Accounts.startPairing](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/accounts.ts#L269) (MethodDeclaration)
- [Accounts.lookupPairing](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/accounts.ts#L280) (MethodDeclaration)
- [Accounts.claimPairing](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/accounts.ts#L288) (MethodDeclaration)
- [Accounts.rejectPairing](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/accounts.ts#L300) (MethodDeclaration)
- [Accounts.pollPairing](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/accounts.ts#L304) (MethodDeclaration)
- [Accounts.prunePairings](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/accounts.ts#L317) (MethodDeclaration)

## packages/server/src/appstore.ts

import: @apple/app-store-server-library, node:fs, node:path, ./accounts.ts, ./db.ts, ./errors.ts, ./ids.ts

- [AppStoreConfig](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/appstore.ts#L11) (TypeAliasDeclaration)
- [appleRootCertificates](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/appstore.ts#L23) (FunctionDeclaration)
- [peekPayload](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/appstore.ts#L29) (FunctionDeclaration)
- [Accepted](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/appstore.ts#L37) (TypeAliasDeclaration)
- [asEnvironment](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/appstore.ts#L39) (FunctionDeclaration)
- [AppStore](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/appstore.ts#L45) (ClassDeclaration)
- [catch](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/appstore.ts#L70) (MethodDeclaration)

## packages/server/src/attachments.ts

import: node:crypto, node:fs, node:path, ./db.ts, ./errors.ts, ./ids.ts

- [Kind](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/attachments.ts#L18) (TypeAliasDeclaration)
- [Attachment](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/attachments.ts#L19) (TypeAliasDeclaration)
- [Row](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/attachments.ts#L21) (TypeAliasDeclaration)
- [isHeif](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/attachments.ts#L42) (FunctionDeclaration)
- [isZip](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/attachments.ts#L46) (FunctionDeclaration)
- [isUtf8Text](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/attachments.ts#L49) (FunctionDeclaration)
- [cleanName](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/attachments.ts#L55) (FunctionDeclaration)
- [mediaType](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/attachments.ts#L60) (FunctionDeclaration)
- [formatBytes](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/attachments.ts#L64) (FunctionDeclaration)
- [readLimited](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/attachments.ts#L71) (FunctionDeclaration)
- [Attachments](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/attachments.ts#L89) (ClassDeclaration)
- [Attachments.constructor](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/attachments.ts#L93) (Constructor)
- [Attachments.toApi](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/attachments.ts#L99) (MethodDeclaration)
- [Attachments.userFileIds](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/attachments.ts#L103) (MethodDeclaration)
- [Attachments.eraseFiles](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/attachments.ts#L108) (MethodDeclaration)
- [Attachments.open](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/attachments.ts#L119) (MethodDeclaration)
- [Attachments.upload](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/attachments.ts#L126) (MethodDeclaration)
- [Attachments.uploadRequest](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/attachments.ts#L164) (MethodDeclaration)
- [Attachments.staged](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/attachments.ts#L192) (MethodDeclaration)
- [Attachments.removeStaged](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/attachments.ts#L197) (MethodDeclaration)
- [Attachments.readForUser](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/attachments.ts#L208) (MethodDeclaration)
- [Attachments.readForAi](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/attachments.ts#L214) (MethodDeclaration)
- [Attachments.read](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/attachments.ts#L218) (MethodDeclaration)
- [Attachments.gc](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/attachments.ts#L225) (MethodDeclaration)
- [contentDisposition](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/attachments.ts#L243) (FunctionDeclaration)

## packages/server/src/callbridge.ts

import: @modelcontextprotocol/sdk/client/index.js, @modelcontextprotocol/sdk/client/streamableHttp.js, node:fs, ./db.ts, ./decisions.ts, ./events.ts

- [SendResult](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/callbridge.ts#L11) (TypeAliasDeclaration)
- [CallSender](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/callbridge.ts#L13) (TypeAliasDeclaration)
- [CallBridgeConfig](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/callbridge.ts#L15) (TypeAliasDeclaration)
- [readHeaderFile](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/callbridge.ts#L27) (FunctionDeclaration)
- [ToolResult](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/callbridge.ts#L36) (TypeAliasDeclaration)
- [payload](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/callbridge.ts#L38) (FunctionDeclaration)
- [callBridgeSender](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/callbridge.ts#L45) (FunctionDeclaration)
- [CallBridgeDeliverer](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/callbridge.ts#L85) (ClassDeclaration)
- [CallBridgeDeliverer.constructor](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/callbridge.ts#L93) (Constructor)
- [CallBridgeDeliverer.connection](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/callbridge.ts#L106) (MethodDeclaration)
- [CallBridgeDeliverer.sync](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/callbridge.ts#L111) (MethodDeclaration)

## packages/server/src/db.ts

import: ./ids.ts, node:sqlite, node:fs, node:path

- [Db](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/db.ts#L238) (TypeAliasDeclaration)
- [openDb](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/db.ts#L240) (FunctionDeclaration)
- [migrate](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/db.ts#L352) (FunctionDeclaration)
- [get](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/db.ts#L367) (FunctionDeclaration)
- [all](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/db.ts#L371) (FunctionDeclaration)
- [run](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/db.ts#L375) (FunctionDeclaration)
- [afterCommit](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/db.ts#L382) (FunctionDeclaration)
- [tx](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/db.ts#L388) (FunctionDeclaration)

## packages/server/src/decisions.ts

import: zod, ./attachments.ts, ./db.ts, ./errors.ts, ./events.ts, ./ids.ts

- [Option](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/decisions.ts#L16) (TypeAliasDeclaration)
- [Route](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/decisions.ts#L17) (TypeAliasDeclaration)
- [Answer](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/decisions.ts#L18) (TypeAliasDeclaration)
- [Row](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/decisions.ts#L20) (TypeAliasDeclaration)
- [HistoryRow](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/decisions.ts#L28) (TypeAliasDeclaration)
- [Connection](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/decisions.ts#L30) (TypeAliasDeclaration)
- [compareDeadlines](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/decisions.ts#L85) (FunctionDeclaration)
- [Decisions](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/decisions.ts#L95) (ClassDeclaration)
- [Decisions.constructor](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/decisions.ts#L99) (Constructor)
- [Decisions.toApi](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/decisions.ts#L106) (MethodDeclaration)
- [Decisions.toAi](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/decisions.ts#L141) (MethodDeclaration)
- [Decisions.connectionLabel](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/decisions.ts#L167) (MethodDeclaration)
- [Decisions.requestAttachments](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/decisions.ts#L173) (MethodDeclaration)
- [Decisions.bindRequest](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/decisions.ts#L178) (MethodDeclaration)
- [Decisions.row](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/decisions.ts#L194) (MethodDeclaration)
- [Decisions.history](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/decisions.ts#L198) (MethodDeclaration)
- [Decisions.changed](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/decisions.ts#L203) (MethodDeclaration)
- [Decisions.forUser](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/decisions.ts#L209) (MethodDeclaration)
- [Decisions.list](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/decisions.ts#L215) (MethodDeclaration)
- [Decisions.answer](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/decisions.ts#L229) (MethodDeclaration)
- [Decisions.bindAttachments](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/decisions.ts#L257) (MethodDeclaration)
- [Decisions.setHold](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/decisions.ts#L269) (MethodDeclaration)
- [Decisions.deleteClosed](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/decisions.ts#L283) (MethodDeclaration)
- [Decisions.purgeExpired](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/decisions.ts#L292) (MethodDeclaration)
- [Decisions.assertOpen](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/decisions.ts#L304) (MethodDeclaration)
- [Decisions.forConnection](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/decisions.ts#L314) (MethodDeclaration)
- [Decisions.listMine](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/decisions.ts#L321) (MethodDeclaration)
- [Decisions.summary](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/decisions.ts#L330) (MethodDeclaration)
- [Decisions.create](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/decisions.ts#L343) (MethodDeclaration)
- [Decisions.requireCheck](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/decisions.ts#L381) (MethodDeclaration)
- [Decisions.checkUsable](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/decisions.ts#L399) (MethodDeclaration)
- [Decisions.useCheck](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/decisions.ts#L404) (MethodDeclaration)
- [Decisions.amend](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/decisions.ts#L409) (MethodDeclaration)
- [Decisions.resume](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/decisions.ts#L432) (MethodDeclaration)
- [Decisions.cancel](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/decisions.ts#L447) (MethodDeclaration)
- [Decisions.aiView](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/decisions.ts#L461) (MethodDeclaration)
- [Decisions.markFetched](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/decisions.ts#L466) (MethodDeclaration)
- [Decisions.pendingDeliveries](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/decisions.ts#L474) (MethodDeclaration)
- [Decisions.serverDeliveries](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/decisions.ts#L486) (MethodDeclaration)
- [Decisions.markSending](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/decisions.ts#L493) (MethodDeclaration)
- [Decisions.deferServerDelivery](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/decisions.ts#L498) (MethodDeclaration)
- [Decisions.interruptedServerDeliveries](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/decisions.ts#L507) (MethodDeclaration)
- [Decisions.reportDelivery](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/decisions.ts#L511) (MethodDeclaration)
- [Decisions.startSetupTest](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/decisions.ts#L529) (MethodDeclaration)
- [Decisions.confirmSetupTest](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/decisions.ts#L558) (MethodDeclaration)
- [displayLabel](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/decisions.ts#L583) (FunctionDeclaration)
- [uniqueId](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/decisions.ts#L592) (FunctionDeclaration)
- [deliveryText](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/decisions.ts#L599) (FunctionDeclaration)

## packages/server/src/diagnostics.ts

import: node:crypto, node:net, @hono/node-server/conninfo, hono, zod, ./db.ts, ./attachments.ts, ./errors.ts

- [Diagnostic](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/diagnostics.ts#L36) (TypeAliasDeclaration)
- [DiagnosticInvestigation](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/diagnostics.ts#L41) (TypeAliasDeclaration)
- [InvestigationRow](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/diagnostics.ts#L42) (TypeAliasDeclaration)
- [investigationOf](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/diagnostics.ts#L43) (FunctionDeclaration)
- [canonical](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/diagnostics.ts#L46) (FunctionDeclaration)
- [hash](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/diagnostics.ts#L51) (FunctionVariable)
- [diagnosticFingerprint](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/diagnostics.ts#L52) (FunctionDeclaration)
- [referenceOnly](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/diagnostics.ts#L56) (FunctionDeclaration)
- [assessmentNote](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/diagnostics.ts#L63) (FunctionDeclaration)
- [diagnosticReportSummary](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/diagnostics.ts#L78) (FunctionDeclaration)
- [severity](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/diagnostics.ts#L98) (FunctionDeclaration)
- [Diagnostics](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/diagnostics.ts#L104) (ClassDeclaration)
- [Diagnostics.constructor](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/diagnostics.ts#L106) (Constructor)
- [Diagnostics.removeUser](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/diagnostics.ts#L108) (MethodDeclaration)
- [Diagnostics.prune](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/diagnostics.ts#L122) (MethodDeclaration)
- [Diagnostics.accept](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/diagnostics.ts#L135) (MethodDeclaration)
- [readDiagnostic](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/diagnostics.ts#L170) (FunctionDeclaration)
- [privateAddress](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/diagnostics.ts#L177) (FunctionDeclaration)
- [diagnosticsAdmin](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/diagnostics.ts#L182) (FunctionDeclaration)

## packages/server/src/error-messages-east-asian.ts

import: なし/未解析

定数/設定/スクリプト入口。関数展開なし。

## packages/server/src/error-messages-en.ts

import: なし/未解析

定数/設定/スクリプト入口。関数展開なし。

## packages/server/src/errors.ts

import: ./locales.ts, ./error-messages-east-asian.ts, ./error-messages-en.ts

- [ErrorCode](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/errors.ts#L4) (TypeAliasDeclaration)
- [fixedErrorTranslation](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/errors.ts#L69) (FunctionDeclaration)
- [ApiError](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/errors.ts#L93) (ClassDeclaration)
- [ApiError.constructor](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/errors.ts#L99) (Constructor)
- [ApiError.body](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/errors.ts#L107) (MethodDeclaration)

## packages/server/src/events.ts

import: node:events, ./db.ts, ./ids.ts

- [UserEvent](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/events.ts#L5) (TypeAliasDeclaration)
- [EventHub](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/events.ts#L11) (ClassDeclaration)
- [EventHub.constructor](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/events.ts#L15) (Constructor)
- [EventHub.publish](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/events.ts#L20) (MethodDeclaration)
- [EventHub.subscribeAll](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/events.ts#L30) (MethodDeclaration)
- [EventHub.since](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/events.ts#L35) (MethodDeclaration)
- [EventHub.subscribe](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/events.ts#L40) (MethodDeclaration)
- [EventHub.notifyConnection](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/events.ts#L45) (MethodDeclaration)
- [EventHub.subscribeConnection](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/events.ts#L49) (MethodDeclaration)
- [EventHub.prune](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/events.ts#L54) (MethodDeclaration)

## packages/server/src/http.ts

import: ./locales.ts, ./locale.ts, ./diagnostics.ts, ./oidc.ts, ./onboarding.ts, hono, hono/streaming, zod, ./accounts.ts, ./appstore.ts, ./attachments.ts, ./db.ts, ./errors.ts, ./events.ts, ./decisions.ts, ./ids.ts, ./remote-mcp.ts

- [Services](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/http.ts#L19) (TypeAliasDeclaration)
- [untilWake](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/http.ts#L26) (FunctionDeclaration)
- [resume](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/http.ts#L29) (FunctionVariable)
- [bearer](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/http.ts#L35) (FunctionDeclaration)
- [body](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/http.ts#L40) (FunctionDeclaration)
- [idempotent](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/http.ts#L50) (FunctionDeclaration)
- [fileResponse](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/http.ts#L75) (FunctionDeclaration)
- [createApp](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/http.ts#L87) (FunctionDeclaration)
- [files](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/http.ts#L89) (FunctionVariable)
- [sweep](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/http.ts#L94) (FunctionVariable)
- [signIn](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/http.ts#L121) (FunctionVariable)
- [back](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/http.ts#L147) (FunctionVariable)
- [stop](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/http.ts#L229) (FunctionVariable)
- [routeChannel](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/http.ts#L336) (FunctionVariable)
- [stop](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/http.ts#L407) (FunctionVariable)

## packages/server/src/ids.ts

import: node:crypto

- [pick](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/ids.ts#L6) (FunctionDeclaration)
- [uuid](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/ids.ts#L12) (FunctionVariable)
- [now](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/ids.ts#L13) (FunctionVariable)
- [decisionId](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/ids.ts#L14) (FunctionVariable)
- [pairingCode](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/ids.ts#L15) (FunctionVariable)
- [testCode](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/ids.ts#L16) (FunctionVariable)
- [secret](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/ids.ts#L17) (FunctionVariable)
- [hash](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/ids.ts#L18) (FunctionVariable)
- [normalizePairingCode](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/ids.ts#L21) (FunctionDeclaration)
- [normalizeTitle](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/ids.ts#L28) (FunctionDeclaration)

## packages/server/src/locale.ts

import: ./locales.ts

- [requestLocale](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/locale.ts#L3) (FunctionDeclaration)

## packages/server/src/locales.ts

import: なし/未解析

- [Locale](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/locales.ts#L2) (TypeAliasDeclaration)
- [supportedLocale](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/locales.ts#L4) (FunctionDeclaration)

## packages/server/src/main.ts

import: ./diagnostics.ts, ./push.ts, @hono/node-server, node:fs, node:path, node:url, hono, ./accounts.ts, ./attachments.ts, ./db.ts, ./decisions.ts, ./events.ts, ./appstore.ts, ./http.ts, ./callbridge.ts

- [staticHandler](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/main.ts#L51) (FunctionDeclaration)
- [finish](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/main.ts#L139) (FunctionVariable)

## packages/server/src/oidc.ts

import: node:crypto, ./errors.ts

- [Provider](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/oidc.ts#L6) (TypeAliasDeclaration)
- [Jwk](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/oidc.ts#L7) (TypeAliasDeclaration)
- [KeySource](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/oidc.ts#L8) (TypeAliasDeclaration)
- [fetchKeys](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/oidc.ts#L20) (FunctionVariable)
- [keyFor](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/oidc.ts#L26) (FunctionDeclaration)
- [decode](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/oidc.ts#L32) (FunctionVariable)
- [sha256hex](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/oidc.ts#L33) (FunctionVariable)
- [verifyIdToken](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/oidc.ts#L35) (FunctionDeclaration)
- [invalid](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/oidc.ts#L37) (FunctionVariable)
- [resetKeyCache](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/oidc.ts#L59) (FunctionDeclaration)

## packages/server/src/onboarding.ts

import: ./locales.ts

- [Step](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/onboarding.ts#L6) (TypeAliasDeclaration)
- [Guide](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/onboarding.ts#L7) (TypeAliasDeclaration)
- [onboarding](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/onboarding.ts#L16) (FunctionDeclaration)

## packages/server/src/push.ts

import: ./locales.ts, node:http2, node:crypto, ./db.ts, ./decisions.ts, ./events.ts

- [ApnsConfig](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/push.ts#L10) (TypeAliasDeclaration)
- [Send](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/push.ts#L11) (TypeAliasDeclaration)
- [Apns](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/push.ts#L16) (ClassDeclaration)
- [enc](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/push.ts#L29) (FunctionVariable)
- [Notifier](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/push.ts#L68) (ClassDeclaration)
- [Notifier.constructor](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/push.ts#L72) (Constructor)
- [Notifier.handle](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/push.ts#L78) (MethodDeclaration)

## packages/server/src/remote-mcp.ts

import: @modelcontextprotocol/sdk/server/index.js, @modelcontextprotocol/sdk/server/webStandardStreamableHttp.js, @modelcontextprotocol/sdk/types.js, hono, zod, ./accounts.ts, ./attachments.ts, ./decisions.ts, ./errors.ts

- [RemoteMcpOptions](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/remote-mcp.ts#L14) (TypeAliasDeclaration)
- [tools](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/remote-mcp.ts#L33) (FunctionDeclaration)
- [describe](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/remote-mcp.ts#L120) (FunctionDeclaration)
- [result](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/remote-mcp.ts#L127) (FunctionDeclaration)
- [buildServer](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/remote-mcp.ts#L136) (FunctionDeclaration)
- [remoteMcpHandler](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/server/src/remote-mcp.ts#L235) (FunctionDeclaration)

## packages/web/playwright.config.ts

import: @playwright/test

定数/設定/スクリプト入口。関数展開なし。

## packages/web/src/api.ts

import: ./i18n.ts, ./types

- [getSession](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/api.ts#L6) (FunctionDeclaration)
- [setSession](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/api.ts#L9) (FunctionDeclaration)
- [ApiError](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/api.ts#L13) (ClassDeclaration)
- [ApiError.constructor](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/api.ts#L16) (Constructor)
- [onUnauthorized](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/api.ts#L23) (FunctionVariable)
- [setUnauthorizedHandler](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/api.ts#L24) (FunctionVariable)
- [api](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/api.ts#L26) (FunctionDeclaration)
- [failure](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/api.ts#L51) (FunctionDeclaration)
- [uploadAttachment](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/api.ts#L58) (FunctionDeclaration)
- [fetchAttachment](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/api.ts#L77) (FunctionDeclaration)
- [subscribeEvents](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/api.ts#L89) (FunctionDeclaration)

## packages/web/src/format.ts

import: ./i18n.ts

- [clientLabel](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/format.ts#L5) (FunctionVariable)
- [ago](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/format.ts#L15) (FunctionDeclaration)
- [dateTime](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/format.ts#L22) (FunctionDeclaration)
- [deadlineText](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/format.ts#L25) (FunctionDeclaration)

## packages/web/src/i18n.ts

import: ../../server/src/errors.ts, preact/hooks, ./messages.ts, ./messages-east-asian.ts, ./locales.ts

- [LanguagePreference](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/i18n.ts#L9) (TypeAliasDeclaration)
- [resolveLocale](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/i18n.ts#L11) (FunctionDeclaration)
- [storedPreference](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/i18n.ts#L19) (FunctionDeclaration)
- [languagePreference](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/i18n.ts#L25) (FunctionVariable)
- [locale](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/i18n.ts#L26) (FunctionVariable)
- [changed](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/i18n.ts#L27) (FunctionDeclaration)
- [setLanguage](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/i18n.ts#L31) (FunctionDeclaration)
- [useLocale](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/i18n.ts#L41) (FunctionDeclaration)
- [notify](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/i18n.ts#L43) (FunctionVariable)
- [translate](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/i18n.ts#L46) (FunctionDeclaration)
- [t](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/i18n.ts#L52) (FunctionVariable)
- [labels](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/i18n.ts#L54) (FunctionDeclaration)
- [relative](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/i18n.ts#L57) (FunctionDeclaration)
- [days](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/i18n.ts#L60) (FunctionDeclaration)
- [UiMessage](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/i18n.ts#L64) (TypeAliasDeclaration)
- [systemMessage](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/i18n.ts#L69) (FunctionDeclaration)

## packages/web/src/idlogin.tsx

import: ./i18n.ts, preact/hooks, ./api

- [Config](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/idlogin.tsx#L7) (TypeAliasDeclaration)
- [Result](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/idlogin.tsx#L8) (TypeAliasDeclaration)
- [Window](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/idlogin.tsx#L11) (InterfaceDeclaration)
- [loadScript](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/idlogin.tsx#L18) (FunctionDeclaration)
- [loginConfig](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/idlogin.tsx#L28) (FunctionVariable)
- [IdLogin](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/idlogin.tsx#L30) (FunctionDeclaration)
- [send](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/idlogin.tsx#L37) (FunctionVariable)
- [apple](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/idlogin.tsx#L48) (FunctionDeclaration)

## packages/web/src/locales.ts

import: なし/未解析

- [Locale](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/locales.ts#L2) (TypeAliasDeclaration)
- [supportedLocale](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/locales.ts#L4) (FunctionDeclaration)

## packages/web/src/main.tsx

import: ./i18n.ts, preact, preact/hooks, ./api, ./router, ./store, ./pages/Connections, ./pages/DecisionView, ./pages/History, ./pages/Inbox, ./pages/Settings, ./idlogin, ./style.css

- [Login](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/main.tsx#L15) (FunctionDeclaration)
- [Nav](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/main.tsx#L29) (FunctionDeclaration)
- [item](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/main.tsx#L33) (FunctionVariable)
- [LanguagePicker](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/main.tsx#L46) (FunctionDeclaration)
- [App](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/main.tsx#L53) (FunctionDeclaration)
- [onVisible](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/main.tsx#L63) (FunctionVariable)

## packages/web/src/messages-east-asian.ts

import: ./messages.ts

定数/設定/スクリプト入口。関数展開なし。

## packages/web/src/messages.ts

import: なし/未解析

- [MessageKey](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/messages.ts#L39) (TypeAliasDeclaration)

## packages/web/src/pages/Attachments.tsx

import: ../i18n.ts, preact/hooks, ../api, ../types

- [typeOf](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/pages/Attachments.tsx#L22) (FunctionDeclaration)
- [bytes](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/pages/Attachments.tsx#L28) (FunctionDeclaration)
- [useDraftAttachments](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/pages/Attachments.tsx#L35) (FunctionDeclaration)
- [add](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/pages/Attachments.tsx#L48) (FunctionDeclaration)
- [remove](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/pages/Attachments.tsx#L71) (FunctionDeclaration)
- [AttachmentList](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/pages/Attachments.tsx#L85) (FunctionDeclaration)
- [AttachmentItem](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/pages/Attachments.tsx#L94) (FunctionDeclaration)
- [save](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/pages/Attachments.tsx#L111) (FunctionDeclaration)
- [RequestImages](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/pages/Attachments.tsx#L137) (FunctionDeclaration)
- [RequestImage](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/pages/Attachments.tsx#L141) (FunctionDeclaration)

## packages/web/src/pages/Connections.tsx

import: ../i18n.ts, preact/hooks, ../api, ../router, ../store, ../format, ../types

- [CopyLine](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/pages/Connections.tsx#L11) (FunctionDeclaration)
- [SetupGuide](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/pages/Connections.tsx#L23) (FunctionDeclaration)
- [checkLine](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/pages/Connections.tsx#L34) (FunctionDeclaration)
- [Connections](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/pages/Connections.tsx#L44) (FunctionDeclaration)
- [revoke](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/pages/Connections.tsx#L50) (FunctionDeclaration)
- [Pair](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/pages/Connections.tsx#L97) (FunctionDeclaration)
- [decide](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/pages/Connections.tsx#L106) (FunctionDeclaration)

## packages/web/src/pages/DecisionView.tsx

import: ../i18n.ts, preact/hooks, ../api, ../router, ../store, ../format, ../types, ./Source, ./Attachments

- [PlainText](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/pages/DecisionView.tsx#L12) (FunctionDeclaration)
- [DecisionView](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/pages/DecisionView.tsx#L23) (FunctionDeclaration)
- [act](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/pages/DecisionView.tsx#L66) (FunctionDeclaration)
- [copyResume](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/pages/DecisionView.tsx#L86) (FunctionDeclaration)

## packages/web/src/pages/History.tsx

import: ../i18n.ts, preact/hooks, ../api, ../router, ../store, ../format, ./Source

- [History](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/pages/History.tsx#L9) (FunctionDeclaration)
- [deleteAll](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/pages/History.tsx#L13) (FunctionDeclaration)

## packages/web/src/pages/Inbox.tsx

import: ../i18n.ts, ../router, ../store, ../format, ../types, ./Source

- [DecisionCard](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/pages/Inbox.tsx#L8) (FunctionDeclaration)
- [Inbox](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/pages/Inbox.tsx#L28) (FunctionDeclaration)

## packages/web/src/pages/Settings.tsx

import: ../i18n.ts, preact/hooks, ../api, ../router, ../store, ../format

- [Settings](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/pages/Settings.tsx#L9) (FunctionDeclaration)
- [setRetention](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/pages/Settings.tsx#L16) (FunctionDeclaration)
- [deleteHistory](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/pages/Settings.tsx#L19) (FunctionDeclaration)
- [deleteAccount](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/pages/Settings.tsx#L25) (FunctionDeclaration)
- [logout](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/pages/Settings.tsx#L30) (FunctionDeclaration)

## packages/web/src/pages/Source.tsx

import: ../format, ../types

- [Source](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/pages/Source.tsx#L8) (FunctionDeclaration)

## packages/web/src/router.ts

import: preact/hooks

- [navigate](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/router.ts#L3) (FunctionDeclaration)
- [useLocation](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/router.ts#L8) (FunctionDeclaration)
- [update](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/router.ts#L11) (FunctionVariable)
- [linkProps](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/router.ts#L19) (FunctionDeclaration)

## packages/web/src/store.ts

import: preact/hooks, ./api, ./types

- [Listener](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/store.ts#L5) (TypeAliasDeclaration)
- [bump](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/store.ts#L10) (FunctionDeclaration)
- [useBump](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/store.ts#L15) (FunctionDeclaration)
- [listener](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/store.ts#L18) (FunctionVariable)
- [useResource](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/store.ts#L25) (FunctionDeclaration)
- [loadOpen](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/store.ts#L36) (FunctionVariable)
- [loadClosed](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/store.ts#L37) (FunctionVariable)
- [loadMe](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/store.ts#L38) (FunctionVariable)

## packages/web/src/types.ts

import: なし/未解析

- [Option](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/types.ts#L1) (TypeAliasDeclaration)
- [Attachment](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/types.ts#L2) (TypeAliasDeclaration)
- [HistoryEntry](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/types.ts#L3) (TypeAliasDeclaration)
- [Decision](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/types.ts#L4) (TypeAliasDeclaration)
- [Check](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/types.ts#L16) (TypeAliasDeclaration)
- [Me](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/types.ts#L17) (TypeAliasDeclaration)
- [Connection](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/types.ts#L18) (TypeAliasDeclaration)
- [ApiErrorBody](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/packages/web/src/types.ts#L19) (TypeAliasDeclaration)

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

- [send](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/tools/deploy/diagnostic-trigger-smoke.mjs#L13) (FunctionVariable)

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

- [claudeBinaryForShell](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/tools/e2e/claude-binary.mjs#L5) (FunctionDeclaration)

## tools/e2e/codex-consumer-migration.mjs

import: node:assert/strict, node:fs, node:path, aiterm-steer-delivery, ../../packages/connector/src/profile.ts, ../../packages/connector/src/harness.ts

- [group](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/tools/e2e/codex-consumer-migration.mjs#L17) (FunctionVariable)
- [rpc](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/tools/e2e/codex-consumer-migration.mjs#L25) (FunctionVariable)
- [list](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/tools/e2e/codex-consumer-migration.mjs#L26) (FunctionVariable)
- [normalized](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/tools/e2e/codex-consumer-migration.mjs#L41) (FunctionVariable)

## tools/e2e/parent-e2e.mjs

import: @hono/node-server, @modelcontextprotocol/sdk/client/index.js, @modelcontextprotocol/sdk/client/stdio.js, aiterm-steer-delivery, node:child_process, node:crypto, node:fs, node:os, node:path, node:url, ../../packages/server/src/accounts.ts, ../../packages/server/src/db.ts, ../../packages/server/src/decisions.ts, ../../packages/server/src/events.ts, ../../packages/server/src/http.ts, ../../packages/connector/src/profile.ts, ./claude-binary.mjs

- [sleep](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/tools/e2e/parent-e2e.mjs#L33) (FunctionVariable)
- [log](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/tools/e2e/parent-e2e.mjs#L34) (FunctionVariable)
- [openOf](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/tools/e2e/parent-e2e.mjs#L105) (FunctionVariable)
- [waitFor](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/tools/e2e/parent-e2e.mjs#L106) (FunctionVariable)
- [waitDecision](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/tools/e2e/parent-e2e.mjs#L112) (FunctionVariable)
- [answer](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/tools/e2e/parent-e2e.mjs#L113) (FunctionVariable)
- [deliveryOf](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/tools/e2e/parent-e2e.mjs#L114) (FunctionVariable)
- [call](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/tools/e2e/parent-e2e.mjs#L122) (FunctionVariable)
- [clean](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/tools/e2e/parent-e2e.mjs#L123) (FunctionVariable)
- [screen](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/tools/e2e/parent-e2e.mjs#L125) (FunctionVariable)
- [cursorTranscript](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/tools/e2e/parent-e2e.mjs#L132) (FunctionVariable)
- [grokTranscript](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/tools/e2e/parent-e2e.mjs#L152) (FunctionVariable)
- [transcript](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/tools/e2e/parent-e2e.mjs#L169) (FunctionVariable)
- [waitScreen](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/tools/e2e/parent-e2e.mjs#L170) (FunctionVariable)
- [send](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/tools/e2e/parent-e2e.mjs#L175) (FunctionVariable)
- [channelsOf](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/tools/e2e/parent-e2e.mjs#L284) (FunctionVariable)
- [liveBound](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/tools/e2e/parent-e2e.mjs#L292) (FunctionVariable)

## tools/e2e/session-routing-production.mjs

import: node:assert/strict, node:fs, node:path, @modelcontextprotocol/sdk/client/index.js, @modelcontextprotocol/sdk/client/stdio.js, aiterm-steer-delivery, ../../packages/connector/src/profile.ts

- [call](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/tools/e2e/session-routing-production.mjs#L13) (FunctionVariable)
- [delay](https://github.com/kitepon/approval-box/blob/90066748bf7ca4686716c67c91d76fcd20afa519/tools/e2e/session-routing-production.mjs#L25) (FunctionVariable)

## tools/e2e/session-routing-smoke.mjs

import: node:assert/strict, node:http, node:fs, node:os, node:path, node:url, @modelcontextprotocol/sdk/client/index.js, @modelcontextprotocol/sdk/client/stdio.js, node:fs

定数/設定/スクリプト入口。関数展開なし。

