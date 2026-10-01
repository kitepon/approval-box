import type { ProductProfile } from "aiterm-steer-delivery";
import { homedir } from "node:os";
import { join } from "node:path";

/** MCPの登録名。Claudeのhook matcherがこの名前に固定されるため、setupは必ずこの名前で登録する。 */
export const MCP_SERVER = "kessaibako";
/** 答えが返ってくる（親の会話へ配送する）tool。 */
export const DISPATCH_TOOLS = ["request_decision", "setup_test"] as const;

/** 置き場はホーム配下に固定する（TMPDIRやXDG_RUNTIME_DIRに頼らない。Cursor CLIはMCPとhookを別の環境で起動するため）。 */
export const home = () => process.env.KESSAIBAKO_HOME ?? join(homedir(), ".kessaibako");
export const stateRoot = () => join(home(), "state");

export const HOOK_FILES = {
  claude: "kessaibako-claude-hook.mjs",
  codex: "kessaibako-codex-hook.mjs",
  cursor: "kessaibako-cursor-hook.mjs",
  receive: "kessaibako-receive.mjs",
} as const;

export const PROFILE: ProductProfile = {
  id: "kessaibako",
  display_name: "決裁箱",
  setup_command: "kessaibako setup",
  codex_steer_command: "kessaibako setup --only codex",
  mcp_server: MCP_SERVER,
  dispatch_tools: DISPATCH_TOOLS,
  state_root: stateRoot,
  config_root: home,
  hooks: { codex: HOOK_FILES.codex, claude: HOOK_FILES.claude, cursor: HOOK_FILES.cursor },
  codex_client_name: "kessaibako_delivery",
  codex_hook_schema: "kessaibako.codex-parent-hooks.v1",
  backup_suffix: ".kessaibako-backup",
  channels: { claude_expiry_notice: "[決裁箱] 答えの待ち受けを張り直すための通知です。対応は要りません。" },
};
