import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { navigate } from "../router";
import { bump, loadMe, useResource } from "../store";
import { ago, CHECK_LABEL, clientLabel, dateTime, FAILED_STEP } from "../format";
import type { Check, Connection } from "../types";

const INSTALL = "npx -y approval-box@latest setup";

function CopyLine({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div class="copyline">
      <code>{text}</code>
      <button class="ghost small" onClick={async () => {
        try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { prompt("コピーしてください", text); }
      }}>{copied ? "済" : "コピー"}</button>
    </div>
  );
}

export function SetupGuide() {
  return (
    <div class="panel">
      <h2>はじめに: PCにコネクタを入れる</h2>
      <p>AI（Claude Code・Codex・Cursor・Grok）を使っているPCで、次を実行してください。</p>
      <CopyLine text={INSTALL} />
      <p class="muted">画面にQRコードとコードが出たら、下の「端末を追加」で読み取るか、コードを入力します。</p>
    </div>
  );
}

function checkLine(check: Check) {
  return (
    <li key={`${check.connection_id}-${check.client}`} class={`check check-${check.status}`}>
      <span>{clientLabel(check.client)}</span>
      <span>{CHECK_LABEL[check.status] ?? check.status}{check.tested_at ? `（${dateTime(check.tested_at)}）` : ""}</span>
      {check.status === "failed" && check.failed_step && <div class="muted">{FAILED_STEP[check.failed_step]}{check.detail ? `（${check.detail}）` : ""}</div>}
    </li>
  );
}

export function Connections() {
  const me = useResource(loadMe);
  const conns = useResource(() => api<Connection[]>("GET", "/connections"));
  const [code, setCode] = useState("");
  const [testing, setTesting] = useState<string | null>(null);

  async function revoke(c: Connection) {
    if (!confirm(`「${c.label}」の接続を外します。この端末のAIはApproval Boxを使えなくなります。`)) return;
    try { await api("DELETE", `/connections/${c.id}`); bump(); } catch (e) { alert((e as Error).message); }
  }

  return (
    <section>
      <h1>接続</h1>
      <div class="panel">
        <h2>端末を追加</h2>
        <form class="row" onSubmit={(e) => { e.preventDefault(); if (code.trim()) navigate(`/pair?c=${encodeURIComponent(code.trim())}`); }}>
          <input class="code-input" value={code} onInput={(e) => setCode((e.target as HTMLInputElement).value)} placeholder="ABCD-EFGH" autocomplete="off" autocapitalize="characters" />
          <button class="primary" type="submit">次へ</button>
        </form>
        <p class="muted">PCで <code>npx -y approval-box@latest setup</code> を実行すると出るコードです。QRコードはスマホのカメラで読めます。</p>
      </div>

      {conns.data && !conns.data.length && <SetupGuide />}

      {conns.data?.map((c) => {
        const checks = me.data?.setup.checks.filter((x) => x.connection_id === c.id) ?? [];
        return (
          <div class="panel" key={c.id}>
            <div class="row spread">
              <h2>{c.label}</h2>
              <span class="muted">{c.os ?? ""} {c.last_seen_at ? `・${ago(c.last_seen_at)}` : ""}</span>
            </div>
            <ul class="checks">{checks.map(checkLine)}</ul>
            <div class="row">
              <button class="ghost" onClick={() => setTesting(c.id)}>接続テスト</button>
              <button class="ghost danger" onClick={() => revoke(c)}>外す</button>
            </div>
            {testing === c.id && (
              <p class="notice">テストしたいAIを開いて「<strong>Approval Boxのテストをして</strong>」と言ってください。テストの申請が受信一覧に届くので、答えるとAIへ届き、ここが「確認済み」になります。</p>
            )}
          </div>
        );
      })}

      <div class="panel">
        <h2>チャットのAI（Claude・ChatGPT）</h2>
        <p class="muted">Claude.ai・ChatGPTのコネクタからの接続は準備中です。</p>
      </div>
    </section>
  );
}

export function Pair({ code }: { code: string }) {
  const [info, setInfo] = useState<{ pairing_id: string; device_name: string; os?: string; clients: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    api<typeof info>("GET", `/pairing/lookup?code=${encodeURIComponent(code)}`).then(setInfo).catch((e: Error) => setError(e.message));
  }, [code]);

  async function decide(claim: boolean) {
    try {
      await api("POST", `/pairing/${info!.pairing_id}/${claim ? "claim" : "reject"}`);
      setDone(claim ? "追加しました。PCの画面でセットアップが続きます。" : "断りました。この端末は追加されません。");
      bump();
    } catch (e) { setError((e as Error).message); }
  }

  return (
    <section>
      <h1>端末を追加</h1>
      {error && <p class="error">{error}</p>}
      {done && <><p class="notice">{done}</p><button class="ghost" onClick={() => navigate("/connections")}>接続へ</button></>}
      {info && !done && (
        <div class="panel">
          <p>次の端末を、あなたのApproval Boxに追加しますか？</p>
          <dl class="pairing">
            <dt>端末名</dt><dd>{info.device_name}</dd>
            {info.os && <><dt>OS</dt><dd>{info.os}</dd></>}
            <dt>使うAI</dt><dd>{info.clients.map(clientLabel).join("・") || "—"}</dd>
          </dl>
          <p class="muted">自分で approval-box の setup を実行した覚えがなければ「心当たりがない」を押してください。</p>
          <div class="row">
            <button class="primary" onClick={() => decide(true)}>この端末を追加</button>
            <button class="ghost danger" onClick={() => decide(false)}>心当たりがない</button>
          </div>
        </div>
      )}
    </section>
  );
}
