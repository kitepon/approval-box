# 全実行ソースと関数の対応

source commit: 97dd816e8214cf925420a8039b2b2e9155c851da。hashを実ファイルと照合する。

全体図 → [機能別の責任](flows.md) → この索引。静的解析は動的呼出しや実行成功の証明とは区別する。

## docs/refactoring/refresh-index.mjs

sha256: 3ef7974f1d79854f0ec69f51d6dcc7fbc6d2242ad883d8dee07d8251911685ca

import: node:assert/strict, node:child_process, node:crypto, node:fs, typescript

- [line](../../../docs/refactoring/refresh-index.mjs#L16) (FunctionVariable)
- [visit](../../../docs/refactoring/refresh-index.mjs#L17) (FunctionVariable)
- [json](../../../docs/refactoring/refresh-index.mjs#L46) (FunctionVariable)
- [key](../../../docs/refactoring/refresh-index.mjs#L52) (FunctionVariable)
- [category](../../../docs/refactoring/refresh-index.mjs#L64) (FunctionVariable)

## docs/refactoring/verify-contracts.mjs

sha256: dc683290ca8c5a7d7ee66653fdc6d4b07306044621d77dbaeef00beb23de98fa

import: node:assert/strict, node:child_process, node:fs, typescript

- [old](../../../docs/refactoring/verify-contracts.mjs#L6) (FunctionVariable)
- [node](../../../docs/refactoring/verify-contracts.mjs#L7) (FunctionVariable)
- [visit](../../../docs/refactoring/verify-contracts.mjs#L7) (FunctionDeclaration)

## packages/connector/scripts/build.mjs

sha256: c65f19c353d35c85c4bc7058b39f9fa541e62786815fcb995024945b15b23c9e

import: esbuild, node:fs, node:path

定数・設定またはスクリプト入口。用途は[全ファイル対応](scope.md)を参照。

## packages/connector/src/api.ts

sha256: 478104c6412ca1ff5e5f9090d8db565a14e0e4496bbd7f033a411752a3014fcc

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

sha256: 062fb6bb1fdb08d7420d1a0ca1497a471abe117d2c83fa27e77ee4e012b2e9e4

import: node:crypto, node:fs, node:path, ./api.ts, ./profile.ts

- [AttachmentMeta](../../../packages/connector/src/attachments.ts#L9) (TypeAliasDeclaration)
- [attachmentsRoot](../../../packages/connector/src/attachments.ts#L13) (FunctionVariable)
- [safeFileName](../../../packages/connector/src/attachments.ts#L16) (FunctionDeclaration)
- [saveAttachment](../../../packages/connector/src/attachments.ts#L22) (FunctionDeclaration)
- [saveAll](../../../packages/connector/src/attachments.ts#L34) (FunctionDeclaration)
- [pruneAttachments](../../../packages/connector/src/attachments.ts#L47) (FunctionDeclaration)
- [sha256](../../../packages/connector/src/attachments.ts#L57) (FunctionVariable)

## packages/connector/src/channel-delivery.ts

sha256: bfd00d3dcfb44bb29648c69fff810b31f6fbec5596ecbdb695e8c63b33672c37

import: aiterm-steer-delivery, ./profile.ts

- [CodexParent](../../../packages/connector/src/channel-delivery.ts#L4) (TypeAliasDeclaration)
- [CodexProvider](../../../packages/connector/src/channel-delivery.ts#L5) (TypeAliasDeclaration)
- [sendChannelAnswer](../../../packages/connector/src/channel-delivery.ts#L15) (FunctionDeclaration)
- [channelAnswerState](../../../packages/connector/src/channel-delivery.ts#L35) (FunctionDeclaration)

## packages/connector/src/claude-channel.ts

sha256: 5a5fc01afcb1c4bb79bdfef9dd1d4f7e8c53830e5cf09ade7f6a8df25c3c0c8f

import: node:fs, node:path, aiterm-steer-delivery

- [ClaudeParent](../../../packages/connector/src/claude-channel.ts#L5) (TypeAliasDeclaration)
- [Profile](../../../packages/connector/src/claude-channel.ts#L6) (TypeAliasDeclaration)
- [claudeChannelIsCurrent](../../../packages/connector/src/claude-channel.ts#L17) (FunctionDeclaration)

## packages/connector/src/cli.ts

sha256: 48e1309569783f62ee79eb153f7ebd0f1977d3b19b7409c4dd12edc25c069b57

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

sha256: 2f5524ee7ca7fa43834b7ec8032ef2531ff22943e33f3801a412508014340621

import: node:fs, node:path, ./profile.ts

- [Config](../../../packages/connector/src/config.ts#L5) (TypeAliasDeclaration)
- [configFile](../../../packages/connector/src/config.ts#L8) (FunctionVariable)
- [readConfig](../../../packages/connector/src/config.ts#L10) (FunctionDeclaration)
- [requireConfig](../../../packages/connector/src/config.ts#L15) (FunctionDeclaration)
- [writeJsonFile](../../../packages/connector/src/config.ts#L21) (FunctionDeclaration)
- [writeConfig](../../../packages/connector/src/config.ts#L28) (FunctionDeclaration)

## packages/connector/src/cursor-binding.ts

sha256: ea783fe7dd5e0abf04eac8f1c2056b087abd9ae44ccca25537565ec68c4f204d

import: aiterm-steer-delivery

- [bindCursorResult](../../../packages/connector/src/cursor-binding.ts#L4) (FunctionDeclaration)

## packages/connector/src/daemon-launch.ts

sha256: b6bd13cde4f599fa03733956ef1cc9375d90bd32d94127d3b855480d24b46f59

import: node:child_process, node:fs, node:path, ./profile.ts

- [windowsDaemonLaunchScript](../../../packages/connector/src/daemon-launch.ts#L7) (FunctionDeclaration)
- [literal](../../../packages/connector/src/daemon-launch.ts#L12) (FunctionVariable)
- [launchDaemon](../../../packages/connector/src/daemon-launch.ts#L17) (FunctionDeclaration)

## packages/connector/src/daemon.ts

sha256: 007f83bc0bf6dac7bd37f4bc980c23dc8826789981d2e9eeff77bb051767a47e

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

sha256: cdc08b6d370a192de088b2773bb7aaa5e19e331882c0e7732e987460a39044d7

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

sha256: 9791cef266ed2d54c72598946a01b7faa19d5b03606fc2fa40d7d5b27182f92f

import: aiterm-steer-delivery, ../profile.ts

定数・設定またはスクリプト入口。用途は[全ファイル対応](scope.md)を参照。

## packages/connector/src/hooks/cursor.ts

sha256: cd44fa83e74794b669da9e227e4a4902fdb7e8367180e9e7d178e7f0b1d367d7

import: ../cursor-binding.ts, ../profile.ts

定数・設定またはスクリプト入口。用途は[全ファイル対応](scope.md)を参照。

## packages/connector/src/hooks/receive.ts

sha256: 5e82a48eda28b7b2010cf744ba56eccec93c549f91363a0ccdb809f27b272055

import: aiterm-steer-delivery, ../profile.ts

定数・設定またはスクリプト入口。用途は[全ファイル対応](scope.md)を参照。

## packages/connector/src/instructions.ts

sha256: c905766d70e2b6da5a55d0f278ce5c15279889fbc4332fe42e69f42b5466159e

import: node:fs, node:os, node:path

- [hasInstructions](../../../packages/connector/src/instructions.ts#L20) (FunctionDeclaration)
- [hasInstructionsInDir](../../../packages/connector/src/instructions.ts#L33) (FunctionDeclaration)
- [managedElsewhere](../../../packages/connector/src/instructions.ts#L47) (FunctionDeclaration)
- [writeInstructions](../../../packages/connector/src/instructions.ts#L56) (FunctionDeclaration)
- [removeInstructions](../../../packages/connector/src/instructions.ts#L65) (FunctionDeclaration)

## packages/connector/src/mcp.ts

sha256: 26fe44a2171c03f0c5a96a026fd998ecbdebfb742bec1012f448870642e66a7e

import: ./parent-channels.ts, ./parent-channels.ts, @modelcontextprotocol/sdk/server/index.js, @modelcontextprotocol/sdk/server/stdio.js, @modelcontextprotocol/sdk/types.js, aiterm-steer-delivery, node:fs, node:path, ./api.ts, ./attachments.ts, ./config.ts, ./daemon.ts, ./request-images.ts, ./runtime.ts, ./profile.ts, ./version.ts

- [named](../../../packages/connector/src/mcp.ts#L128) (FunctionDeclaration)
- [receiveGuide](../../../packages/connector/src/mcp.ts#L134) (FunctionDeclaration)
- [announced](../../../packages/connector/src/mcp.ts#L151) (FunctionDeclaration)
- [text](../../../packages/connector/src/mcp.ts#L155) (FunctionDeclaration)
- [describe](../../../packages/connector/src/mcp.ts#L159) (FunctionDeclaration)
- [runMcp](../../../packages/connector/src/mcp.ts#L169) (FunctionDeclaration)

## packages/connector/src/parent-channels.ts

sha256: 1f2c4db81eb9a2d30ac621d7354a5f442fa56e4c33f5499c4f798809a4ce9936

import: aiterm-steer-delivery, node:fs, node:path, ./config.ts, ./claude-channel.ts, ./profile.ts

- [Harness](../../../packages/connector/src/parent-channels.ts#L8) (TypeAliasDeclaration)
- [harnessOf](../../../packages/connector/src/parent-channels.ts#L10) (FunctionDeclaration)
- [ParentKey](../../../packages/connector/src/parent-channels.ts#L21) (TypeAliasDeclaration)
- [parentsFile](../../../packages/connector/src/parent-channels.ts#L22) (FunctionVariable)
- [savedParents](../../../packages/connector/src/parent-channels.ts#L25) (FunctionDeclaration)
- [reuse](../../../packages/connector/src/parent-channels.ts#L29) (FunctionDeclaration)
- [remember](../../../packages/connector/src/parent-channels.ts#L35) (FunctionDeclaration)
- [channelFor](../../../packages/connector/src/parent-channels.ts#L44) (FunctionDeclaration)

## packages/connector/src/profile.ts

sha256: 1069d14e547d7669824bb47a4c5767ea6cbd90db1b7d9483834024e84f39de29

import: aiterm-steer-delivery, node:os, node:path

- [home](../../../packages/connector/src/profile.ts#L11) (FunctionVariable)
- [stateRoot](../../../packages/connector/src/profile.ts#L12) (FunctionVariable)

## packages/connector/src/request-images.ts

sha256: 4e79e554094b18a136c5bd64d121977027b3d115ce3e4b6f52ef41282b6dbf86

import: node:fs/promises, node:path, ./api.ts

- [imageType](../../../packages/connector/src/request-images.ts#L7) (FunctionDeclaration)
- [uploadImagePaths](../../../packages/connector/src/request-images.ts#L17) (FunctionDeclaration)

## packages/connector/src/runtime.ts

sha256: 31725d80d04caa9c43494e4f2c8fc6450c4a55af5f277822db16cd6b2559e55a

import: node:path, node:url, ./profile.ts

- [runtimeDir](../../../packages/connector/src/runtime.ts#L6) (FunctionVariable)
- [runtimeEntry](../../../packages/connector/src/runtime.ts#L12) (FunctionDeclaration)

## packages/connector/src/version.ts

sha256: d91297a4ad8072b412541f20a8fbaa7f55ceb4aac5a1885ff6c28fd3245b2566

import: なし/非JS

- [osName](../../../packages/connector/src/version.ts#L5) (FunctionDeclaration)

## packages/connector/test/aiterm-provider.test.ts

sha256: 12b217324b946207e31771cb39becaeeb5a839e38c344d1ec8bea724001ee454

import: node:assert/strict, node:crypto, node:fs, node:os, node:path, node:test, aiterm-steer-delivery, ../src/profile.ts, ../src/channel-delivery.ts, ../src/config.ts

定数・設定またはスクリプト入口。用途は[全ファイル対応](scope.md)を参照。

## packages/connector/test/api.test.ts

sha256: 27d7c84b4e1bed62e1bc18fe2ed1a6e47313f50722282d7a7703c6445c17a11f

import: node:test, node:assert/strict, node:http, node:net, ../src/api.ts

- [serve](../../../packages/connector/test/api.test.ts#L7) (FunctionDeclaration)

## packages/connector/test/attachments.test.ts

sha256: f16172ea9a383df16c3f6ce7f2d0445a205e8bcf06253b042f11816c5655bc9c

import: node:test, node:assert/strict, node:crypto, node:fs, node:http, node:net, node:os, node:path, ../src/api.ts, ../src/attachments.ts

- [sha](../../../packages/connector/test/attachments.test.ts#L12) (FunctionVariable)

## packages/connector/test/channel-delivery.test.ts

sha256: 75ddf5d2842245840fbf904b3b4eb15600906feaa2926a7bf0a573e6faa892f0

import: node:assert/strict, node:crypto, node:fs, node:os, node:path, node:test, aiterm-steer-delivery, ../src/profile.ts, ../src/channel-delivery.ts, ../src/config.ts

定数・設定またはスクリプト入口。用途は[全ファイル対応](scope.md)を参照。

## packages/connector/test/claude-channel.test.ts

sha256: f0b232653d7a3fb9243c98b9892cc26fdc80a7baccc595e8685d4407bb9e439b

import: node:assert/strict, node:crypto, node:fs, node:os, node:path, node:test, aiterm-steer-delivery, ../src/claude-channel.ts, ../src/config.ts, ../src/profile.ts

- [setup](../../../packages/connector/test/claude-channel.test.ts#L12) (FunctionDeclaration)
- [request](../../../packages/connector/test/claude-channel.test.ts#L19) (FunctionVariable)
- [emit](../../../packages/connector/test/claude-channel.test.ts#L52) (FunctionVariable)

## packages/connector/test/claude-hook.test.ts

sha256: 25687de1c8174fcfdd6aee56dec086d263612da2a0023e486fcd62f5bce36930

import: node:assert/strict, node:crypto, node:child_process, node:fs, node:os, node:path, node:url, node:test, aiterm-steer-delivery, ../src/profile.ts, ../src/harness.ts, ../src/config.ts

定数・設定またはスクリプト入口。用途は[全ファイル対応](scope.md)を参照。

## packages/connector/test/codex-acceptance.test.ts

sha256: 573957f8db8647095400072e53bada574f45257e8ad148f4a8807d8868e53971

import: node:assert/strict, node:crypto, node:fs, node:http, node:net, node:os, node:path, node:test, @modelcontextprotocol/sdk/client/index.js, @modelcontextprotocol/sdk/client/stdio.js, ../src/config.ts

定数・設定またはスクリプト入口。用途は[全ファイル対応](scope.md)を参照。

## packages/connector/test/cursor-binding.test.ts

sha256: 16d92fa1b9b2960ab2f36eed503ed114e60cfe53c54a571870b2dcc78583adfc

import: node:assert/strict, node:crypto, node:fs, node:os, node:path, node:test, aiterm-steer-delivery, ../src/profile.ts, ../src/cursor-binding.ts

- [receive](../../../packages/connector/test/cursor-binding.test.ts#L26) (FunctionVariable)

## packages/connector/test/daemon-launch.test.ts

sha256: eddd9685d3c751062cf68fff72df1856fa953c4e3efa46d0637a78139d1ba40d

import: node:assert/strict, node:test, node:fs, node:os, node:path, ../src/daemon-launch.ts

定数・設定またはスクリプト入口。用途は[全ファイル対応](scope.md)を参照。

## packages/connector/test/daemon.test.ts

sha256: c704d0e32d53c0877bd05a451f60fd7485f762f231596a7750d2a8c4881670bf

import: node:assert/strict, node:test, ../src/daemon.ts

- [entry](../../../packages/connector/test/daemon.test.ts#L5) (FunctionVariable)

## packages/connector/test/instructions.test.ts

sha256: c0cf10749eaef2f8990ba151dbb8dd0f5067abc577f7b6600a9dbbe33837be8d

import: node:assert/strict, node:fs, node:os, node:path, node:test, ../src/instructions.ts

定数・設定またはスクリプト入口。用途は[全ファイル対応](scope.md)を参照。

## packages/connector/test/mcp-context.test.ts

sha256: 68ae9456df68c2063d16e1e07851719d59998af7dc2e2f531e551738f2043c50

import: node:assert/strict, node:test, node:crypto, node:http, node:fs, node:os, node:path, @modelcontextprotocol/sdk/client/index.js, @modelcontextprotocol/sdk/client/stdio.js, ../src/config.ts

- [call](../../../packages/connector/test/mcp-context.test.ts#L33) (FunctionVariable)
- [current](../../../packages/connector/test/mcp-context.test.ts#L34) (FunctionVariable)

## packages/connector/test/parent-channels.test.ts

sha256: 3ed38998734f062894655fd474af1f6becf595d897b625353a7a6dfd31efec70

import: node:assert/strict, node:child_process, node:fs, node:os, node:path, node:test

- [run](../../../packages/connector/test/parent-channels.test.ts#L28) (FunctionVariable)

## packages/connector/test/request-images.test.ts

sha256: ff2ea6192f2e78e06ecf2023ce5eccf3b55643c4b5e3bf036c2efe8156bd421e

import: node:test, node:assert/strict, node:fs, node:os, node:path, ../src/request-images.ts

- [object.uploadRequestImage](../../../packages/connector/test/request-images.test.ts#L11) (MethodDeclaration)

## packages/connector/test/session-routing.test.ts

sha256: 3d6dd200e8408be4142169740eb56e667971b39e0426b5f1fd51f6c803e44d0c

import: node:assert/strict, node:crypto, node:child_process, node:fs, node:http, node:os, node:path, node:test, aiterm-steer-delivery, ../src/profile.ts, ../src/config.ts

- [delay](../../../packages/connector/test/session-routing.test.ts#L13) (FunctionVariable)
- [until](../../../packages/connector/test/session-routing.test.ts#L14) (FunctionDeclaration)
- [recorded](../../../packages/connector/test/session-routing.test.ts#L52) (FunctionVariable)

## packages/server/src/accounts.ts

sha256: dd0a5a7527aca4eb061a08ebc3ec390a885a8e99379cc8d1fb91a0c77191931a

import: ./shared/locales.ts, node:crypto, ./db.ts, ./errors.ts, ./events.ts, ./ids.ts, ./decisions.ts, ./diagnostics.ts

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

sha256: 5df46b6604f5212010316a4e7f3a52552e713063c5b149ce3c238125316f3e67

import: @apple/app-store-server-library, node:fs, node:path, ./accounts.ts, ./db.ts, ./errors.ts, ./ids.ts

- [AppStoreConfig](../../../packages/server/src/appstore.ts#L11) (TypeAliasDeclaration)
- [appleRootCertificates](../../../packages/server/src/appstore.ts#L23) (FunctionDeclaration)
- [peekPayload](../../../packages/server/src/appstore.ts#L29) (FunctionDeclaration)
- [Accepted](../../../packages/server/src/appstore.ts#L37) (TypeAliasDeclaration)
- [asEnvironment](../../../packages/server/src/appstore.ts#L39) (FunctionDeclaration)
- [AppStore](../../../packages/server/src/appstore.ts#L45) (ClassDeclaration)
- [AppStore.constructor](../../../packages/server/src/appstore.ts#L52) (Constructor)
- [AppStore.verifier](../../../packages/server/src/appstore.ts#L58) (MethodDeclaration)
- [AppStore.decodeTransaction](../../../packages/server/src/appstore.ts#L68) (MethodDeclaration)
- [AppStore.verifyPurchase](../../../packages/server/src/appstore.ts#L77) (MethodDeclaration)
- [AppStore.notification](../../../packages/server/src/appstore.ts#L89) (MethodDeclaration)
- [AppStore.ownerOf](../../../packages/server/src/appstore.ts#L107) (MethodDeclaration)
- [AppStore.apply](../../../packages/server/src/appstore.ts#L116) (MethodDeclaration)

## packages/server/src/attachments.ts

sha256: 379c8ab7613c9b1787a573e8c1156be70cdb22811ff93c25e41e103f18e353a5

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

sha256: ccd99521532e4f02b810c1de0b62fbcab09186bd191481662c3a3ba802801ab5

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

sha256: 2e387218ed7ab0a8bf193ee0489e730781bf628224e7d5ac796953876a7bc7e5

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

sha256: 5a8be7ef47bb6021628133305f7c662745a0ba0fc3965991cec1579dc31af390

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

sha256: 48db24eb6081724574f304c8ad2b9d2ad71b4ae77d3bd451ccd1df17be65681b

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

## packages/server/src/errors.ts

sha256: ced7f24927d8054b2e2fd79d55bf4e376d82678079114ea281f8f53c98eb1490

import: ./shared/locales.ts, ./shared/error-translations.ts, ./shared/error-translations.ts

- [ApiError](../../../packages/server/src/errors.ts#L21) (ClassDeclaration)
- [ApiError.constructor](../../../packages/server/src/errors.ts#L27) (Constructor)
- [ApiError.body](../../../packages/server/src/errors.ts#L35) (MethodDeclaration)

## packages/server/src/events.ts

sha256: ea6c177e2b87dcce8c69adfe3008529fbbf8ee62b49826441d5cb22827484e6b

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

sha256: 6988823999515f4383c61ed470da0b9495e68fbe7625e15ffb46a71a7041a245

import: hono, zod, ./locale.ts, ./errors.ts, ./diagnostics.ts, ./remote-mcp.ts, ./http/types.ts, ./http/public.ts, ./http/user.ts, ./http/connector.ts, ./http/types.ts

- [createApp](../../../packages/server/src/http.ts#L13) (FunctionDeclaration)

## packages/server/src/http/common.ts

sha256: 57c111ce157536a1b548438054c149a6b2f047d0b94bc32ac96c8c8a0c6c7038

import: hono, zod, ./types.ts, ../locale.ts, ../attachments.ts, ../db.ts, ../errors.ts, ../ids.ts

- [bearer](../../../packages/server/src/http/common.ts#L10) (FunctionDeclaration)
- [body](../../../packages/server/src/http/common.ts#L15) (FunctionDeclaration)
- [idempotent](../../../packages/server/src/http/common.ts#L25) (FunctionDeclaration)
- [fileResponse](../../../packages/server/src/http/common.ts#L50) (FunctionDeclaration)
- [files](../../../packages/server/src/http/common.ts#L62) (FunctionDeclaration)
- [sweep](../../../packages/server/src/http/common.ts#L68) (FunctionDeclaration)

## packages/server/src/http/connector.ts

sha256: 2bb561b64aceb767c1bf3db6d75db4c45b7fd572ddd75b1945b144dff61448b7

import: hono, zod, ../accounts.ts, ../attachments.ts, ../db.ts, ../errors.ts, ../decisions.ts, ../ids.ts, ./types.ts, ./common.ts, ./streams.ts

- [registerConnectorRoutes](../../../packages/server/src/http/connector.ts#L19) (FunctionDeclaration)
- [routeChannel](../../../packages/server/src/http/connector.ts#L44) (FunctionVariable)

## packages/server/src/http/public.ts

sha256: ba84144139e6eb9d76c3e696d3cbd44db6e050460f57b464c36c7a4a3515311b

import: ../oidc.ts, hono, zod, ../db.ts, ../errors.ts, ./types.ts, ./common.ts

- [registerPublicRoutes](../../../packages/server/src/http/public.ts#L17) (FunctionDeclaration)
- [signIn](../../../packages/server/src/http/public.ts#L21) (FunctionVariable)
- [back](../../../packages/server/src/http/public.ts#L47) (FunctionVariable)

## packages/server/src/http/streams.ts

sha256: 8fccf292fdaaa255093d5967548cfe01353da4e98313a80ae0d397494bd2c9ab

import: hono, hono/streaming, ./types.ts, ../events.ts

- [untilWake](../../../packages/server/src/http/streams.ts#L8) (FunctionDeclaration)
- [resume](../../../packages/server/src/http/streams.ts#L11) (FunctionVariable)
- [userEvents](../../../packages/server/src/http/streams.ts#L17) (FunctionDeclaration)
- [stop](../../../packages/server/src/http/streams.ts#L25) (FunctionVariable)
- [connectorEvents](../../../packages/server/src/http/streams.ts#L49) (FunctionDeclaration)
- [stop](../../../packages/server/src/http/streams.ts#L56) (FunctionVariable)

## packages/server/src/http/types.ts

sha256: 93a9066b3425e69c64c256002a37f2f2e5ae228eea7392bdef390de79fb10068

import: ../accounts.ts, ../appstore.ts, ../attachments.ts, ../db.ts, ../decisions.ts, ../events.ts, ../oidc.ts, ../remote-mcp.ts

- [Services](../../../packages/server/src/http/types.ts#L10) (TypeAliasDeclaration)

## packages/server/src/http/user.ts

sha256: a975260aa3a0dc72ebaf996c490d1c78cd082a701dbdd348cc81448520a202ce

import: ../shared/locales.ts, ../locale.ts, ../diagnostics.ts, ../onboarding.ts, hono, zod, ../attachments.ts, ../db.ts, ../errors.ts, ../decisions.ts, ./types.ts, ./common.ts, ./streams.ts

- [registerUserRoutes](../../../packages/server/src/http/user.ts#L22) (FunctionDeclaration)

## packages/server/src/ids.ts

sha256: e256451eb87c5e21fd436dfddcd9e6d4538bf3cbd8e55ac16cf1f4eccf1abf9f

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

sha256: 5b21cd710765e4cc3f819fd0a22d78d2b9103ce34824e3ac081f2f4006cea6ab

import: ./shared/locales.ts

- [requestLocale](../../../packages/server/src/locale.ts#L3) (FunctionDeclaration)

## packages/server/src/main.ts

sha256: 411cacd7ae1e14947c1bf9635ae3503ff33a89dcd2276e8f3afa849acc30d9c1

import: ./diagnostics.ts, ./push.ts, @hono/node-server, node:fs, node:path, node:url, hono, ./accounts.ts, ./attachments.ts, ./db.ts, ./decisions.ts, ./events.ts, ./appstore.ts, ./http.ts, ./callbridge.ts

- [staticHandler](../../../packages/server/src/main.ts#L51) (FunctionDeclaration)
- [finish](../../../packages/server/src/main.ts#L139) (FunctionVariable)

## packages/server/src/oidc.ts

sha256: 64e939fe1d3347bc7ec838503891dd62e7b4c9aac24b5e7c9755218e0d92ab6d

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

sha256: c2d9c5550024efe6cb19ece0bf6e7cc2816802ad3fc487187367ffafb2dad340

import: ./shared/locales.ts

- [Step](../../../packages/server/src/onboarding.ts#L6) (TypeAliasDeclaration)
- [Guide](../../../packages/server/src/onboarding.ts#L7) (TypeAliasDeclaration)
- [onboarding](../../../packages/server/src/onboarding.ts#L16) (FunctionDeclaration)

## packages/server/src/push.ts

sha256: 549dcc7c381f7552cfce2f035c3a1caa71e4326236a1f1029a614374056dfca0

import: ./shared/locales.ts, node:http2, node:crypto, ./db.ts, ./decisions.ts, ./events.ts

- [ApnsConfig](../../../packages/server/src/push.ts#L10) (TypeAliasDeclaration)
- [Send](../../../packages/server/src/push.ts#L11) (TypeAliasDeclaration)
- [Apns](../../../packages/server/src/push.ts#L16) (ClassDeclaration)
- [Apns.constructor](../../../packages/server/src/push.ts#L22) (Constructor)
- [Apns.token](../../../packages/server/src/push.ts#L27) (MethodDeclaration)
- [enc](../../../packages/server/src/push.ts#L29) (FunctionVariable)
- [Apns.session](../../../packages/server/src/push.ts#L36) (MethodDeclaration)
- [Notifier](../../../packages/server/src/push.ts#L68) (ClassDeclaration)
- [Notifier.constructor](../../../packages/server/src/push.ts#L72) (Constructor)
- [Notifier.handle](../../../packages/server/src/push.ts#L78) (MethodDeclaration)

## packages/server/src/remote-mcp.ts

sha256: c64f0a27da2698a5ce113cc479f3cb556e0a5950c3ed620eddb5a1f0ebd9dfac

import: @modelcontextprotocol/sdk/server/index.js, @modelcontextprotocol/sdk/server/webStandardStreamableHttp.js, @modelcontextprotocol/sdk/types.js, hono, zod, ./accounts.ts, ./attachments.ts, ./decisions.ts, ./errors.ts

- [RemoteMcpOptions](../../../packages/server/src/remote-mcp.ts#L14) (TypeAliasDeclaration)
- [tools](../../../packages/server/src/remote-mcp.ts#L33) (FunctionDeclaration)
- [describe](../../../packages/server/src/remote-mcp.ts#L120) (FunctionDeclaration)
- [result](../../../packages/server/src/remote-mcp.ts#L127) (FunctionDeclaration)
- [buildServer](../../../packages/server/src/remote-mcp.ts#L136) (FunctionDeclaration)
- [remoteMcpHandler](../../../packages/server/src/remote-mcp.ts#L235) (FunctionDeclaration)

## packages/server/src/shared/error-messages-east-asian.ts

sha256: 8ce6cb81bb97d4ea654abe8d57e227298c8b37431cb74ddd4059057b605c9cad

import: なし/非JS

定数・設定またはスクリプト入口。用途は[全ファイル対応](scope.md)を参照。

## packages/server/src/shared/error-messages-en.ts

sha256: 4ce0588674317f04aaacb6ac67ce8251dc135c900eed5b534ef6d547617553ed

import: なし/非JS

定数・設定またはスクリプト入口。用途は[全ファイル対応](scope.md)を参照。

## packages/server/src/shared/error-translations.ts

sha256: 14e328bd11f92a47c78f7ab1f5b85683d1ffe4fd7e6212f421dbd59c0ac7d24f

import: ./locales.ts, ./error-messages-east-asian.ts, ./error-messages-en.ts

- [ErrorCode](../../../packages/server/src/shared/error-translations.ts#L4) (TypeAliasDeclaration)
- [fixedErrorTranslation](../../../packages/server/src/shared/error-translations.ts#L54) (FunctionDeclaration)
- [errorMessage](../../../packages/server/src/shared/error-translations.ts#L77) (FunctionDeclaration)

## packages/server/src/shared/locales.ts

sha256: db12481f0dcf55087b46ccedc5f9734b32ccd8b1c79d9871fba6628de867bb65

import: なし/非JS

- [Locale](../../../packages/server/src/shared/locales.ts#L2) (TypeAliasDeclaration)
- [supportedLocale](../../../packages/server/src/shared/locales.ts#L4) (FunctionDeclaration)

## packages/server/test/account-deletion.test.ts

sha256: 66623152bb03d35b279ef62b86dcfa26e0d7f5ec09f819bf99f26fbf9bf4178a

import: node:assert/strict, node:crypto, node:fs, node:os, node:path, node:test, ../src/accounts.ts, ../src/attachments.ts, ../src/db.ts, ../src/decisions.ts, ../src/diagnostics.ts, ../src/events.ts, ../src/http.ts

- [fixture](../../../packages/server/test/account-deletion.test.ts#L16) (FunctionDeclaration)
- [identity](../../../packages/server/test/account-deletion.test.ts#L21) (FunctionVariable)
- [call](../../../packages/server/test/account-deletion.test.ts#L27) (FunctionVariable)
- [event](../../../packages/server/test/account-deletion.test.ts#L31) (FunctionVariable)

## packages/server/test/api.test.ts

sha256: 76bcc964caf9c16d8a673ce68be7029903b31df84ad3716589fb828677c3b91e

import: node:test, node:assert/strict, ../src/accounts.ts, ../src/db.ts, ../src/decisions.ts, ../src/events.ts, ../src/http.ts

- [setup](../../../packages/server/test/api.test.ts#L9) (FunctionDeclaration)
- [call](../../../packages/server/test/api.test.ts#L17) (FunctionVariable)
- [paired](../../../packages/server/test/api.test.ts#L29) (FunctionDeclaration)
- [submit](../../../packages/server/test/api.test.ts#L44) (FunctionDeclaration)
- [tokenFor](../../../packages/server/test/api.test.ts#L300) (FunctionVariable)
- [enc](../../../packages/server/test/api.test.ts#L301) (FunctionVariable)
- [post](../../../packages/server/test/api.test.ts#L310) (FunctionVariable)
- [gToken](../../../packages/server/test/api.test.ts#L332) (FunctionVariable)
- [enc](../../../packages/server/test/api.test.ts#L333) (FunctionVariable)
- [startAs](../../../packages/server/test/api.test.ts#L358) (FunctionVariable)
- [idToken](../../../packages/server/test/api.test.ts#L362) (FunctionVariable)
- [enc](../../../packages/server/test/api.test.ts#L363) (FunctionVariable)
- [callback](../../../packages/server/test/api.test.ts#L367) (FunctionVariable)
- [link](../../../packages/server/test/api.test.ts#L379) (FunctionVariable)
- [view](../../../packages/server/test/api.test.ts#L441) (FunctionVariable)
- [send](../../../packages/server/test/api.test.ts#L491) (FunctionVariable)

## packages/server/test/appstore.test.ts

sha256: 428b9d9ce07ca22b6fd23377f9dc856c516fd09660710fb2e59c94aab1d0bbc1

import: node:test, node:assert/strict, node:child_process, node:crypto, node:fs, node:os, node:path, ../src/accounts.ts, ../src/appstore.ts, ../src/db.ts, ../src/decisions.ts, ../src/events.ts, ../src/http.ts

- [appleLikeChain](../../../packages/server/test/appstore.test.ts#L16) (FunctionDeclaration)
- [ssl](../../../packages/server/test/appstore.test.ts#L18) (FunctionVariable)
- [ext](../../../packages/server/test/appstore.test.ts#L19) (FunctionVariable)
- [der](../../../packages/server/test/appstore.test.ts#L29) (FunctionVariable)
- [sign](../../../packages/server/test/appstore.test.ts#L32) (FunctionVariable)
- [enc](../../../packages/server/test/appstore.test.ts#L33) (FunctionVariable)
- [setup](../../../packages/server/test/appstore.test.ts#L44) (FunctionDeclaration)
- [call](../../../packages/server/test/appstore.test.ts#L54) (FunctionVariable)
- [transaction](../../../packages/server/test/appstore.test.ts#L58) (FunctionVariable)
- [notify](../../../packages/server/test/appstore.test.ts#L96) (FunctionVariable)

## packages/server/test/attachments.test.ts

sha256: 9a8287e2e7d3baa0ad4d86b1f6fcb4c699d961e46851d5f17ac47d59d0943ed5

import: node:test, node:assert/strict, node:fs, node:os, node:path, @modelcontextprotocol/sdk/client/index.js, @modelcontextprotocol/sdk/client/streamableHttp.js, ../src/accounts.ts, ../src/attachments.ts, ../src/db.ts, ../src/decisions.ts, ../src/events.ts, ../src/http.ts

- [setup](../../../packages/server/test/attachments.test.ts#L19) (FunctionDeclaration)
- [call](../../../packages/server/test/attachments.test.ts#L29) (FunctionVariable)
- [upload](../../../packages/server/test/attachments.test.ts#L38) (FunctionVariable)
- [files](../../../packages/server/test/attachments.test.ts#L49) (FunctionVariable)
- [decision](../../../packages/server/test/attachments.test.ts#L56) (FunctionDeclaration)
- [send](../../../packages/server/test/attachments.test.ts#L177) (FunctionVariable)

## packages/server/test/callbridge-retry.test.ts

sha256: 4a35793d0aefafa940b6ac6cb1cf0b0ce3a132dae23decd416adb606c33a422f

import: node:test, node:assert/strict, @modelcontextprotocol/sdk/client/index.js, ../src/callbridge.ts

定数・設定またはスクリプト入口。用途は[全ファイル対応](scope.md)を参照。

## packages/server/test/connector-auth.test.ts

sha256: 6cc0de7fcd1bbbcc8dcfbf8c3f567164d8d568b0695754fbfe680f996f853404

import: node:test, node:assert/strict, ../src/accounts.ts, ../src/db.ts, ../src/decisions.ts, ../src/events.ts, ../src/http.ts

- [setup](../../../packages/server/test/connector-auth.test.ts#L9) (FunctionDeclaration)

## packages/server/test/db.test.ts

sha256: fadd92c3a60abac586a4a451d0988b655ea0cebb9791692cdd396304de5cb7a8

import: node:test, node:assert/strict, node:sqlite, node:fs, node:os, node:path, ../src/db.ts, ../src/accounts.ts, ../src/events.ts

定数・設定またはスクリプト入口。用途は[全ファイル対応](scope.md)を参照。

## packages/server/test/decision-summary.test.ts

sha256: 1a973c6aaf85c6151b47229e58a8c61bf6b318dea49a146314402ffe7b49606f

import: node:test, node:assert/strict, ../src/accounts.ts, ../src/db.ts, ../src/decisions.ts, ../src/events.ts, ../src/http.ts

- [call](../../../packages/server/test/decision-summary.test.ts#L18) (FunctionVariable)
- [create](../../../packages/server/test/decision-summary.test.ts#L25) (FunctionVariable)

## packages/server/test/diagnostics.test.ts

sha256: 39f60e5b2574617e6e612738f5987872779738fe77ec203c7faec8fb61a3dbeb

import: node:test, node:assert/strict, node:fs, node:os, node:path, node:crypto, ../src/db.ts, ../src/accounts.ts, ../src/events.ts, ../src/decisions.ts, ../src/http.ts, ../src/diagnostics.ts

- [setup](../../../packages/server/test/diagnostics.test.ts#L13) (FunctionDeclaration)
- [event](../../../packages/server/test/diagnostics.test.ts#L17) (FunctionVariable)
- [send](../../../packages/server/test/diagnostics.test.ts#L18) (FunctionVariable)
- [admin](../../../packages/server/test/diagnostics.test.ts#L19) (FunctionVariable)
- [originals](../../../packages/server/test/diagnostics.test.ts#L26) (FunctionVariable)
- [digest](../../../packages/server/test/diagnostics.test.ts#L28) (FunctionVariable)
- [snapshot](../../../packages/server/test/diagnostics.test.ts#L61) (FunctionVariable)
- [snapshot](../../../packages/server/test/diagnostics.test.ts#L115) (FunctionVariable)
- [patch](../../../packages/server/test/diagnostics.test.ts#L254) (FunctionVariable)

## packages/server/test/locale.test.ts

sha256: 03ccd7608970f6b4ce401b1ec600ea4a3d81d8c3d77985aea035057393022385

import: node:test, node:assert/strict, node:fs, node:os, node:path, ../src/db.ts, ../src/accounts.ts, ../src/decisions.ts, ../src/events.ts, ../src/push.ts, ../src/onboarding.ts, ../src/errors.ts, ../src/http.ts, ../src/shared/error-messages-en.ts, ../src/shared/error-messages-east-asian.ts, ../src/locale.ts

- [setup](../../../packages/server/test/locale.test.ts#L24) (FunctionDeclaration)
- [send](../../../packages/server/test/locale.test.ts#L38) (FunctionVariable)

## packages/server/test/push.test.ts

sha256: 4f84044d932359004063efe25a3bbf0e09260ccdb0f19f59b2d0224f77c721fc

import: node:test, node:assert/strict, node:crypto, ../src/db.ts, ../src/events.ts, ../src/accounts.ts, ../src/decisions.ts, ../src/push.ts

定数・設定またはスクリプト入口。用途は[全ファイル対応](scope.md)を参照。

## packages/server/test/remote-mcp.test.ts

sha256: b48a1e36b8c965609fadfeb8b23fd843b4044791eba0c1afdd1c173bfdebcfc6

import: node:test, node:assert/strict, @modelcontextprotocol/sdk/client/index.js, @modelcontextprotocol/sdk/client/streamableHttp.js, ../src/accounts.ts, ../src/callbridge.ts, ../src/db.ts, ../src/decisions.ts, ../src/events.ts, ../src/http.ts

- [setup](../../../packages/server/test/remote-mcp.test.ts#L12) (FunctionDeclaration)
- [call](../../../packages/server/test/remote-mcp.test.ts#L21) (FunctionVariable)
- [mcpClient](../../../packages/server/test/remote-mcp.test.ts#L33) (FunctionDeclaration)
- [ToolResult](../../../packages/server/test/remote-mcp.test.ts#L43) (TypeAliasDeclaration)
- [tool](../../../packages/server/test/remote-mcp.test.ts#L44) (FunctionVariable)
- [send](../../../packages/server/test/remote-mcp.test.ts#L201) (FunctionVariable)
- [send](../../../packages/server/test/remote-mcp.test.ts#L233) (FunctionVariable)

## packages/server/test/request-images.test.ts

sha256: 9a5394be21c2cc4ea8c1430a5ff28cb550ac0f815a3521d4a3f785ba586ee876

import: node:test, node:assert/strict, node:fs, node:os, node:path, ../src/accounts.ts, ../src/attachments.ts, ../src/db.ts, ../src/decisions.ts, ../src/events.ts, ../src/http.ts, @modelcontextprotocol/sdk/client/index.js, @modelcontextprotocol/sdk/client/streamableHttp.js

- [setup](../../../packages/server/test/request-images.test.ts#L16) (FunctionDeclaration)
- [call](../../../packages/server/test/request-images.test.ts#L19) (FunctionDeclaration)
- [upload](../../../packages/server/test/request-images.test.ts#L21) (FunctionDeclaration)
- [create](../../../packages/server/test/request-images.test.ts#L22) (FunctionDeclaration)
- [object.cleanup](../../../packages/server/test/request-images.test.ts#L23) (MethodDeclaration)
- [amend](../../../packages/server/test/request-images.test.ts#L41) (FunctionVariable)
- [tool](../../../packages/server/test/request-images.test.ts#L70) (FunctionVariable)

## packages/server/test/shutdown.test.ts

sha256: 04dd9d06c087d93e586f35a9166a3414201baca7924edf278e615caf36e0a776

import: node:test, node:assert/strict, ../src/accounts.ts, ../src/db.ts, ../src/decisions.ts, ../src/events.ts, ../src/http.ts

- [setup](../../../packages/server/test/shutdown.test.ts#L9) (FunctionDeclaration)
- [readToEnd](../../../packages/server/test/shutdown.test.ts#L21) (FunctionDeclaration)

## packages/server/test/start-with-secrets.test.ts

sha256: ad7d286c4ff09d5595f99f7ba197301179dff458aecceda01e11d462c846871b

import: node:test, node:assert/strict, node:crypto, node:child_process, node:fs, node:os, node:path, node:url, ../src/callbridge.ts, ../src/push.ts

- [start](../../../packages/server/test/start-with-secrets.test.ts#L20) (FunctionDeclaration)
- [withDir](../../../packages/server/test/start-with-secrets.test.ts#L26) (FunctionDeclaration)

## packages/server/test/streams.test.ts

sha256: 70a26bf7d9fffac4d043181d50b1b3bae2612c899de712d13ec3c1a36fe74823

import: node:assert/strict, node:events, node:test, hono/streaming, ../src/accounts.ts, ../src/db.ts, ../src/decisions.ts, ../src/events.ts, ../src/http.ts

定数・設定またはスクリプト入口。用途は[全ファイル対応](scope.md)を参照。

## packages/web/playwright.config.ts

sha256: fcd0e1780921e06778816c176de3e290c596932bed0a3fc75c3639d74f39c881

import: @playwright/test

定数・設定またはスクリプト入口。用途は[全ファイル対応](scope.md)を参照。

## packages/web/src/api.ts

sha256: 802c503fa56f3257c462d569068dde8f16733afbc54b73812909cc5e5b087b84

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

sha256: 2efd2db8dda148c3f86d40db345b682e4986d7e0546fe9ec2dfa23e4f7f3ed62

import: ./i18n.ts

- [clientLabel](../../../packages/web/src/format.ts#L5) (FunctionVariable)
- [ago](../../../packages/web/src/format.ts#L15) (FunctionDeclaration)
- [dateTime](../../../packages/web/src/format.ts#L22) (FunctionDeclaration)
- [deadlineText](../../../packages/web/src/format.ts#L25) (FunctionDeclaration)

## packages/web/src/i18n.ts

sha256: 2afc4232cf3d50a3a2011686545539df14078156111214f745056b2149898e51

import: ../../server/src/shared/error-translations.ts, preact/hooks, ./messages.ts, ./messages-east-asian.ts, ../../server/src/shared/locales.ts, ../../server/src/shared/locales.ts

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

sha256: 3fb1de8b636cb73d7214c53a745c24985cd034e6d4960924228bd1345d137654

import: ./i18n.ts, preact/hooks, ./api

- [Config](../../../packages/web/src/idlogin.tsx#L7) (TypeAliasDeclaration)
- [Result](../../../packages/web/src/idlogin.tsx#L8) (TypeAliasDeclaration)
- [Window](../../../packages/web/src/idlogin.tsx#L11) (InterfaceDeclaration)
- [loadScript](../../../packages/web/src/idlogin.tsx#L18) (FunctionDeclaration)
- [loginConfig](../../../packages/web/src/idlogin.tsx#L28) (FunctionVariable)
- [IdLogin](../../../packages/web/src/idlogin.tsx#L30) (FunctionDeclaration)
- [send](../../../packages/web/src/idlogin.tsx#L37) (FunctionVariable)
- [apple](../../../packages/web/src/idlogin.tsx#L48) (FunctionDeclaration)

## packages/web/src/main.tsx

sha256: c3856ec55cf322f1d93338dd8be9ae98361d67893cde6a2c5d81ed90cad523bb

import: ./i18n.ts, preact, preact/hooks, ./api, ./router, ./store, ./pages/Connections, ./pages/DecisionView, ./pages/History, ./pages/Inbox, ./pages/Settings, ./idlogin, ./style.css

- [Login](../../../packages/web/src/main.tsx#L15) (FunctionDeclaration)
- [Nav](../../../packages/web/src/main.tsx#L29) (FunctionDeclaration)
- [item](../../../packages/web/src/main.tsx#L33) (FunctionVariable)
- [LanguagePicker](../../../packages/web/src/main.tsx#L46) (FunctionDeclaration)
- [App](../../../packages/web/src/main.tsx#L53) (FunctionDeclaration)
- [onVisible](../../../packages/web/src/main.tsx#L63) (FunctionVariable)

## packages/web/src/messages-east-asian.ts

sha256: dbd04d794b37a8f28ad0845eac955ee9e4ded44bbd620fa8f7a5b9d8a14a0692

import: ./messages.ts

定数・設定またはスクリプト入口。用途は[全ファイル対応](scope.md)を参照。

## packages/web/src/messages.ts

sha256: 6f652d0bb4b8c614d349beff1265cc8629e93baf158029fd3d2b5a4587cde9eb

import: なし/非JS

- [MessageKey](../../../packages/web/src/messages.ts#L39) (TypeAliasDeclaration)

## packages/web/src/pages/Attachments.tsx

sha256: 1b58e2495c16445fbef117fcfda1d50f171cf26c71fe02bca57bb15aae1a6f47

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

sha256: 28c86abaca257de212468e2c88eb7a85f6489026df9e6b6fb9a9c0b2393b3ef5

import: ../i18n.ts, preact/hooks, ../api, ../router, ../store, ../format, ../types

- [CopyLine](../../../packages/web/src/pages/Connections.tsx#L11) (FunctionDeclaration)
- [SetupGuide](../../../packages/web/src/pages/Connections.tsx#L23) (FunctionDeclaration)
- [checkLine](../../../packages/web/src/pages/Connections.tsx#L34) (FunctionDeclaration)
- [Connections](../../../packages/web/src/pages/Connections.tsx#L44) (FunctionDeclaration)
- [revoke](../../../packages/web/src/pages/Connections.tsx#L50) (FunctionDeclaration)
- [Pair](../../../packages/web/src/pages/Connections.tsx#L97) (FunctionDeclaration)
- [decide](../../../packages/web/src/pages/Connections.tsx#L106) (FunctionDeclaration)

## packages/web/src/pages/DecisionView.tsx

sha256: 95a73e3afcd3ca47d1fcf47c72ebddd11cace15c0a9e3d105958c386d99e5bb4

import: ../i18n.ts, preact/hooks, ../api, ../router, ../store, ../format, ../types, ./Source, ./Attachments

- [PlainText](../../../packages/web/src/pages/DecisionView.tsx#L12) (FunctionDeclaration)
- [DecisionView](../../../packages/web/src/pages/DecisionView.tsx#L23) (FunctionDeclaration)
- [act](../../../packages/web/src/pages/DecisionView.tsx#L66) (FunctionDeclaration)
- [copyResume](../../../packages/web/src/pages/DecisionView.tsx#L86) (FunctionDeclaration)

## packages/web/src/pages/History.tsx

sha256: af582f3918273baf0f8103c1c2ef1f9a02ef9b8a5bd504befdbca2b8d3778e4e

import: ../i18n.ts, preact/hooks, ../api, ../router, ../store, ../format, ./Source

- [History](../../../packages/web/src/pages/History.tsx#L9) (FunctionDeclaration)
- [deleteAll](../../../packages/web/src/pages/History.tsx#L13) (FunctionDeclaration)

## packages/web/src/pages/Inbox.tsx

sha256: c21876b88aea2460bca623fbc2806a6e30df6bdbc17934de421488268b4d995f

import: ../i18n.ts, ../router, ../store, ../format, ../types, ./Source

- [DecisionCard](../../../packages/web/src/pages/Inbox.tsx#L8) (FunctionDeclaration)
- [Inbox](../../../packages/web/src/pages/Inbox.tsx#L28) (FunctionDeclaration)

## packages/web/src/pages/Settings.tsx

sha256: 95a43fd4a4b4a9856f211d106a8e1619ca99b4ac307174bb6bd7f9f10ef2a58e

import: ../i18n.ts, preact/hooks, ../api, ../router, ../store, ../format

- [Settings](../../../packages/web/src/pages/Settings.tsx#L9) (FunctionDeclaration)
- [setRetention](../../../packages/web/src/pages/Settings.tsx#L16) (FunctionDeclaration)
- [deleteHistory](../../../packages/web/src/pages/Settings.tsx#L19) (FunctionDeclaration)
- [deleteAccount](../../../packages/web/src/pages/Settings.tsx#L25) (FunctionDeclaration)
- [logout](../../../packages/web/src/pages/Settings.tsx#L30) (FunctionDeclaration)

## packages/web/src/pages/Source.tsx

sha256: 40dee2105ee05899b6232951c3f0704a7ca0493f760b6e792d3f522213aa76a5

import: ../format, ../types

- [Source](../../../packages/web/src/pages/Source.tsx#L8) (FunctionDeclaration)

## packages/web/src/router.ts

sha256: 80eaaf3d40221e7b326750ec1440c74d5e33c174575aa060781dbeec60d4062b

import: preact/hooks

- [navigate](../../../packages/web/src/router.ts#L3) (FunctionDeclaration)
- [useLocation](../../../packages/web/src/router.ts#L8) (FunctionDeclaration)
- [update](../../../packages/web/src/router.ts#L11) (FunctionVariable)
- [linkProps](../../../packages/web/src/router.ts#L19) (FunctionDeclaration)

## packages/web/src/store.ts

sha256: 3a08e0fc28bfdaa532d21d3a8363e6796a345a9593613239c6c4dbee84578dcc

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

sha256: df384b4ca279808aae9c4df312c3b66f844f01e32bd8f3c3800ac1909bb3c35b

import: なし/非JS

- [Option](../../../packages/web/src/types.ts#L1) (TypeAliasDeclaration)
- [Attachment](../../../packages/web/src/types.ts#L2) (TypeAliasDeclaration)
- [HistoryEntry](../../../packages/web/src/types.ts#L3) (TypeAliasDeclaration)
- [Decision](../../../packages/web/src/types.ts#L4) (TypeAliasDeclaration)
- [Check](../../../packages/web/src/types.ts#L16) (TypeAliasDeclaration)
- [Me](../../../packages/web/src/types.ts#L17) (TypeAliasDeclaration)
- [Connection](../../../packages/web/src/types.ts#L18) (TypeAliasDeclaration)
- [ApiErrorBody](../../../packages/web/src/types.ts#L19) (TypeAliasDeclaration)

## packages/web/src/vite-env.d.ts

sha256: 65996936fbb042915f7b74a200fcdde7e410f32a669b1ab9597cfaa4b0faddb5

import: なし/非JS

定数・設定またはスクリプト入口。用途は[全ファイル対応](scope.md)を参照。

## packages/web/test/browser/localization.spec.ts

sha256: c9c012b7388bfabdac2ca08d08ce7c3f43704f120a6082921f847ba1183153cb

import: @playwright/test

- [fixture](../../../packages/web/test/browser/localization.spec.ts#L8) (FunctionDeclaration)

## packages/web/test/browser/swipe.spec.ts

sha256: a25e13a3ff282899be0b1b12c35cfe4eea97dc7269564897f7ba6b1618e83cd5

import: @playwright/test

- [fixture](../../../packages/web/test/browser/swipe.spec.ts#L3) (FunctionDeclaration)
- [swipe](../../../packages/web/test/browser/swipe.spec.ts#L12) (FunctionDeclaration)

## packages/web/test/i18n.test.ts

sha256: 58f1aec09a08bfaaa12aff229a1bff0b6b049d505db7966492b4426c21488b68

import: node:test, node:assert/strict, ../src/i18n.ts, ../src/messages.ts, ../src/messages-east-asian.ts, ../src/format.ts

- [tokens](../../../packages/web/test/i18n.test.ts#L16) (FunctionVariable)
- [visit](../../../packages/web/test/i18n.test.ts#L48) (FunctionDeclaration)

## packages/web/vite.config.ts

sha256: efdfe80005c4efd131b6ca0c104940f8d7975b5ebf072959d34220f35156ce97

import: vite, @preact/preset-vite

定数・設定またはスクリプト入口。用途は[全ファイル対応](scope.md)を参照。

## tools/deploy/block-public-admin.py

sha256: 2da94d5b0d4e88e2e033bf80aacf3a94eaed08a2d45a3568bc868d50b206ccf8

import: なし/非JS

定数・設定またはスクリプト入口。用途は[全ファイル対応](scope.md)を参照。

## tools/deploy/diagnostic-trigger-smoke.mjs

sha256: 1ed18aa2b69927df4f6507c0713d7fc456cb501378f9d63df8c451dc736284f2

import: node:assert/strict, node:fs, node:crypto, /app/server/dist/db.js, /app/server/dist/accounts.js, /app/server/dist/events.js

- [send](../../../tools/deploy/diagnostic-trigger-smoke.mjs#L13) (FunctionVariable)

## tools/deploy/diagnostics-admin.py

sha256: 519372562d069b03a2294b4242d5dc134d1e8efb121be297daacd962bf78e8f3

import: なし/非JS

定数・設定またはスクリプト入口。用途は[全ファイル対応](scope.md)を参照。

## tools/deploy/node-release/install.sh

sha256: 2d76de4a5704fdc22f560eb69d6bfc9b900c4fd0e09484fee62139cd591b7ef0

import: なし/非JS

定数・設定またはスクリプト入口。用途は[全ファイル対応](scope.md)を参照。

## tools/deploy/node-release/test-verification.sh

sha256: 5c7417bc539563040de28e4bb881d9527e7d06380aad1d15aa820843beeed75b

import: なし/非JS

定数・設定またはスクリプト入口。用途は[全ファイル対応](scope.md)を参照。

## tools/deploy/node-release/verify.sh

sha256: e2c6a4a1e647ef48bbf7dfe8678962ed1b304d1b485d7119bce5099d47e7ce1c

import: なし/非JS

定数・設定またはスクリプト入口。用途は[全ファイル対応](scope.md)を参照。

## tools/deploy/server-image-smoke.cjs

sha256: 34b183dd24567900c499024a0a141728c21cf1f000b644dcc91a200565463c67

import: なし/非JS

- [delay](../../../tools/deploy/server-image-smoke.cjs#L4) (FunctionVariable)

## tools/deploy/start-with-secrets.sh

sha256: ffcd1191bce3266f45937cbdba20a3afe105a60411025fe152079cac56bde46c

import: なし/非JS

- [put](../../../tools/deploy/start-with-secrets.sh#L10) (ScriptFunction)
- [fail](../../../tools/deploy/start-with-secrets.sh#L27) (ScriptFunction)

## tools/e2e/bundle.mjs

sha256: 84d20fafe5c46815999a1ed545b4d518ff16d8a41a6ef528b05e7b9f3da1d517

import: esbuild, node:url

定数・設定またはスクリプト入口。用途は[全ファイル対応](scope.md)を参照。

## tools/e2e/claude-binary.mjs

sha256: 2b9ace015c54952c34668a5137701b789bc4c395cf86f781dc13c7c84f51b055

import: node:child_process

- [claudeBinaryForShell](../../../tools/e2e/claude-binary.mjs#L5) (FunctionDeclaration)

## tools/e2e/codex-consumer-migration.mjs

sha256: 5d37e87aaeb340f1f2988c68241131df2aeedfb5cce05086c286ba7fd035afa3

import: node:assert/strict, node:fs, node:path, aiterm-steer-delivery, ../../packages/connector/src/profile.ts, ../../packages/connector/src/harness.ts

- [group](../../../tools/e2e/codex-consumer-migration.mjs#L17) (FunctionVariable)
- [rpc](../../../tools/e2e/codex-consumer-migration.mjs#L25) (FunctionVariable)
- [list](../../../tools/e2e/codex-consumer-migration.mjs#L26) (FunctionVariable)
- [normalized](../../../tools/e2e/codex-consumer-migration.mjs#L41) (FunctionVariable)

## tools/e2e/parent-e2e.mjs

sha256: 25b95a6746cd38906dbf811d61e39995d5954e9734e847df6952a62f7b097654

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

## tools/e2e/parent-preflight.test.mjs

sha256: 2d7b3a4e7d618321997f54e538c564f2b2c3d2bed352e153e4e97c9845b4105a

import: node:assert/strict, node:child_process, node:fs, node:os, node:path, node:url, node:test

定数・設定またはスクリプト入口。用途は[全ファイル対応](scope.md)を参照。

## tools/e2e/session-routing-production.mjs

sha256: 2b757c61f21bdd4e6a621f2ee53b5d08b98f9774b9a15a4d5bce82f493f4b0b5

import: node:assert/strict, node:fs, node:path, @modelcontextprotocol/sdk/client/index.js, @modelcontextprotocol/sdk/client/stdio.js, aiterm-steer-delivery, ../../packages/connector/src/profile.ts

- [call](../../../tools/e2e/session-routing-production.mjs#L13) (FunctionVariable)
- [delay](../../../tools/e2e/session-routing-production.mjs#L25) (FunctionVariable)

## tools/e2e/session-routing-smoke.mjs

sha256: 0000aca2c42a533cc0fcfc220f5072f415da331634af0bb872eb920f2164c284

import: node:assert/strict, node:http, node:fs, node:os, node:path, node:url, @modelcontextprotocol/sdk/client/index.js, @modelcontextprotocol/sdk/client/stdio.js, node:fs

定数・設定またはスクリプト入口。用途は[全ファイル対応](scope.md)を参照。
