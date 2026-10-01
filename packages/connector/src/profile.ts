import type { ProductProfile } from "aiterm-steer-delivery";
import { homedir } from "node:os";
import { join } from "node:path";

/** MCPの登録名。Claudeのhook matcherがこの名前に固定されるため、setupは必ずこの名前で登録する。 */
export const MCP_SERVER = "approval-box";
/** 答えが返ってくる（親の会話へ配送する）tool。 */
export const DISPATCH_TOOLS = ["request_decision", "setup_test"] as const;

/** 置き場はホーム配下に固定する（TMPDIRやXDG_RUNTIME_DIRに頼らない。Cursor CLIはMCPとhookを別の環境で起動するため）。 */
export const home = () => process.env.APPROVAL_BOX_HOME ?? join(homedir(), ".approval-box");
export const stateRoot = () => join(home(), "state");

export const HOOK_FILES = {
  claude: "approval-box-claude-hook.mjs",
  codex: "approval-box-codex-hook.mjs",
  cursor: "approval-box-cursor-hook.mjs",
  receive: "approval-box-receive.mjs",
} as const;

export const PROFILE: ProductProfile = {
  id: "approval-box",
  display_name: "Approval Box",
  setup_command: "approval-box setup",
  codex_steer_command: "approval-box setup --only codex",
  mcp_server: MCP_SERVER,
  dispatch_tools: DISPATCH_TOOLS,
  state_root: stateRoot,
  config_root: home,
  hooks: { codex: HOOK_FILES.codex, claude: HOOK_FILES.claude, cursor: HOOK_FILES.cursor },
  codex_client_name: "approval_box_delivery",
  codex_hook_schema: "approval-box.codex-parent-hooks.v1",
  backup_suffix: ".approval-box-backup",
  channels: { claude_expiry_notice: "[Approval Box] 答えの待ち受けを張り直すための通知です。対応は要りません。" },
};
