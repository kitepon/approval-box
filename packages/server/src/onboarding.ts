import type { Locale } from "./locales.ts";
// クライアント別の登録手順（GET /v1/onboarding）。文面はアプリに焼き込まず、ここから配る。

export const SETUP_PHRASE = "Approval Boxのsetup_testを実行して";

type Step = { text: string; copy?: string };
type Guide = { client: string; title: string; steps: Step[] };

const CLIENTS: { client: string; name: string; note?: string }[] = [
  { client: "claude-code", name: "Claude Code" },
  { client: "codex", name: "Codex", note: "作業中にも答えを割り込ませるには、開いているCodexをすべて閉じて開き直します。" },
  { client: "cursor", name: "Cursor", note: "Cursorは、答えを受け取るコマンドの実行を一度だけ確かめてくることがあります。許可してください。" },
  { client: "grok", name: "Grok" },
];

export function onboarding(publicUrl: string, locale: Locale = "ja"): Guide[] {
  const command = `npx -y approval-box@latest setup --server ${publicUrl}`;
  if (locale !== "ja" && locale !== "en") {
    const text = {
      ko: {
        title: "{name} 설정", terminal: "PC의 터미널에서 다음 명령을 실행하세요. Claude Code·Codex·Cursor·Grok에 한 번에 등록됩니다(Node.js 20 이상 필요).",
        pair: "이 화면의 기기 추가에서 QR 코드를 스캔하거나 코드를 입력하세요. 화면이 없는 PC는 토큰 발급에서 제공하는 명령을 사용하세요.",
        restart: "{name}를 다시 시작한 뒤 다음과 같이 요청하세요.", phrase: "Approval Box의 setup_test를 실행해 줘",
        answer: "도착한 테스트 요청에 답변하세요. 답변이 {name}에 도착하면 설정이 완료됩니다.",
        codex: "작업 중에도 답변을 받으려면 열려 있는 Codex를 모두 닫고 다시 여세요.", cursor: "Cursor가 답변을 받는 명령의 실행 권한을 한 번 물어볼 수 있습니다. 허용해 주세요.",
      },
      "zh-Hans": {
        title: "设置{name}", terminal: "请在电脑终端中运行以下命令，一次性为Claude Code、Codex、Cursor和Grok注册Approval Box（需要Node.js 20或更高版本）。",
        pair: "请在此页面的“添加设备”中扫描二维码或输入配对码。无屏幕电脑请使用“签发令牌”提供的命令。",
        restart: "重启{name}后，对它说：", phrase: "运行Approval Box的setup_test", answer: "请答复收到的测试请求。答复送达{name}后即完成设置。",
        codex: "如需在工作时接收答复，请关闭所有已打开的Codex窗口并重新打开。", cursor: "Cursor可能会询问一次是否允许执行接收答复的命令，请允许。",
      },
      "zh-Hant": {
        title: "設定{name}", terminal: "請在電腦終端機中執行以下指令，一次為Claude Code、Codex、Cursor和Grok註冊Approval Box（需要Node.js 20或更新版本）。",
        pair: "請在此頁面的「新增裝置」中掃描QR碼或輸入配對碼。無螢幕電腦請使用「核發權杖」提供的指令。",
        restart: "重新啟動{name}後，對它說：", phrase: "執行Approval Box的setup_test", answer: "請答覆收到的測試請求。答覆送達{name}後即完成設定。",
        codex: "如需在工作時接收答覆，請關閉所有已開啟的Codex視窗並重新開啟。", cursor: "Cursor可能會詢問一次是否允許執行接收答覆的指令，請允許。",
      },
    }[locale];
    return CLIENTS.map(({ client, name }) => ({ client, title: text.title.replace("{name}", name), steps: [
      { text: text.terminal, copy: command }, { text: text.pair },
      { text: text.restart.replace("{name}", name), copy: text.phrase },
      { text: text.answer.replace("{name}", name) + (client === "codex" ? " " + text.codex : client === "cursor" ? " " + text.cursor : "") },
    ] }));
  }
  if (locale === "en") return CLIENTS.map(({ client, name }) => ({
    client, title: `Set up ${name}`,
    steps: [
      { text: "Run this command in a terminal on your computer. It registers Approval Box with Claude Code, Codex, Cursor, and Grok (Node.js 20 or later required).", copy: command },
      { text: "Scan the QR code or enter the code under Add a device on this screen. On a headless computer, use the command from Issue token." },
      { text: `Restart ${name} and ask:`, copy: "Run Approval Box setup_test" },
      { text: `Answer the test request. Setup is complete when your answer reaches ${name}.${client === "codex" ? " To receive answers while working, close all open Codex windows and reopen them." : client === "cursor" ? " Cursor may ask once for permission to run the command that receives your answer. Allow it to continue." : ""}` },
    ],
  }));
  return CLIENTS.map(({ client, name, note }) => ({
    client,
    title: `${name}を登録する`,
    steps: [
      { text: `PCの端末で次の1行を実行します。PCにあるClaude Code・Codex・Cursor・Grokへまとめて登録します（Node.js 20以上が要ります）。`, copy: command },
      { text: "端末に出たQRコードかコードを、この画面の「端末を追加」で読み取ります。画面の無い端末では「トークンを発行」で出る1行を使います。" },
      { text: `${name}を開き直して、こう言います。`, copy: SETUP_PHRASE },
      { text: `届いたテストの申請に答えます。答えが${name}に届けば準備完了です。${note ? ` ${note}` : ""}` },
    ],
  }));
}
