import { systemMessage, t } from "../i18n.ts";
import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { CopyLine } from "../copyline";
import { showAlert } from "../dialog";
import { INSTALL } from "../login";
import { linkProps, navigate } from "../router";
import { bump, loadMe, useResource } from "../store";
import { ago, CHECK_LABEL, clientLabel, dateTime, FAILED_STEP } from "../format";
import type { Check, Connection } from "../types";

function checkLine(check: Check) {
  return (
    <li key={`${check.connection_id}-${check.client}`} class={`check check-${check.status}`}>
      <span>{clientLabel(check.client)}</span>
      <span>{CHECK_LABEL[check.status] ?? check.status}{check.tested_at ? `（${dateTime(check.tested_at)}）` : ""}</span>
      {check.status === "waiting_answer" && check.decision_id && <a class="button-link" {...linkProps(`/d/${check.decision_id}`)}>{t("接続テストの申請を開く")}</a>}
      {check.status === "failed" && check.failed_step && <div class="muted">{FAILED_STEP[check.failed_step]}{check.detail ? `（${check.detail}）` : ""}</div>}
    </li>
  );
}

/** 画面のない端末の接続トークン。作った時だけ、その端末で実行するコマンドを1回だけ見せる（できた接続は「つないだAI」に並ぶ）。 */
function Tokens() {
  const [label, setLabel] = useState("");
  const [command, setCommand] = useState<string | null>(null);

  async function create(e: Event) {
    e.preventDefault();
    if (!label.trim()) return;
    try { const r = await api<{ setup_command: string }>("POST", "/tokens", { label: label.trim() }, { idempotent: false }); setCommand(r.setup_command); setLabel(""); bump(); }
    catch (err) { showAlert((err as Error).message); }
  }

  return (
    <details class="tokens">
      <summary><h2>{t("画面のない端末を登録")}</h2></summary>
      <p class="muted">{t("画面のない端末（サーバーなど）は、名前をつけて接続トークンを作り、表示されたコマンドをその端末で実行します。")}</p>
      <form class="row" onSubmit={create}>
        <input value={label} onInput={(e) => setLabel((e.target as HTMLInputElement).value)} placeholder={t("端末名")} aria-label={t("端末名")} maxLength={100} />
        <button class="primary" type="submit" disabled={!label.trim()}>{t("トークンを作る")}</button>
      </form>
      {command && <div class="notice"><p>{t("このトークンは、この1回しか表示されません。コマンドをコピーして、その端末で実行してください。")}</p><CopyLine text={command} /></div>}
    </details>
  );
}

type Guide = { client: string; title: string; steps: { text: string; copy?: string }[] };

/** AIごとの登録手順（S6 4番目）。文面はアプリと同じく、サーバーの GET /onboarding から取る。 */
function Guides() {
  const guides = useResource(() => api<Guide[]>("GET", "/onboarding"));
  const [copied, setCopied] = useState<string | null>(null);
  async function copy(key: string, text: string) {
    try { await navigator.clipboard.writeText(text); setCopied(key); setTimeout(() => setCopied(null), 2000); } catch { prompt(t("コピーしてください"), text); }
  }
  return (
    <div class="panel">
      <h2>{t("AIごとの登録手順")}</h2>
      {guides.data?.map((g) => (
        <div class="guide" key={g.client}>
          <h3>{g.title}</h3>
          {g.steps.map((s, i) => (
            <div key={i}>
              <p>{s.text}</p>
              {s.copy && <button class="ghost small" onClick={() => copy(`${g.client}-${i}`, s.copy!)}>{copied === `${g.client}-${i}` ? t("コピーしました") : t("登録手順をコピー")}</button>}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** S6 接続: AIをつなぐ / つないだAI / 接続テスト / AIごとの登録手順 / 画面のない端末を登録。 */
export function Connections() {
  const me = useResource(loadMe);
  const conns = useResource(() => api<Connection[]>("GET", "/connections"));
  const [code, setCode] = useState("");
  const [testing, setTesting] = useState<string | null>(null);

  async function revoke(c: Connection) {
    const message = c.kind === "client" ? t("「{name}」の許可を外します。{name}はApproval Boxを読めなくなります。", { name: c.label }) : t("「{name}」の接続を外します。この端末のAIはApproval Boxを使えなくなります。", { name: c.label });
    if (!confirm(message)) return;
    try { await api("DELETE", `/connections/${c.id}`); bump(); } catch (e) { showAlert((e as Error).message); }
  }

  const devices = conns.data?.filter((c) => c.kind !== "client") ?? [];
  return (
    <section>
      <h1>{t("接続")}</h1>
      <div class="panel">
        <h2>{t("AIをつなぐ")}</h2>
        <p>{t("PCでコマンドを実行すると、8文字のコードとQRが出ます。そのコードを下の欄に入れるか、QRを読みます。")}</p>
        <CopyLine text={INSTALL} />
        <form class="row" onSubmit={(e) => { e.preventDefault(); if (code.trim()) navigate(`/pair?c=${encodeURIComponent(code.trim())}`); }}>
          <input class="code-input" value={code} onInput={(e) => setCode((e.target as HTMLInputElement).value)} placeholder="ABCD-EFGH" aria-label="ABCD-EFGH" autocomplete="off" autocapitalize="characters" />
          <button class="primary" type="submit">{t("コードを確認")}</button>
        </form>
      </div>

      <div class="panel">
        <h2>{t("つないだAI")}</h2>
        {conns.data && !conns.data.length && <p class="muted">{t("まだつないだAIはありません。")}</p>}
        {conns.data?.map((c) => (
          <div class="row spread conn" key={c.id}>
            <div>
              <strong>{c.label}</strong>
              <div class="muted">{c.os ?? ""} {c.last_seen_at ? `・${ago(c.last_seen_at)}` : ""}</div>
            </div>
            <button class="ghost danger small" onClick={() => revoke(c)}>{t("外す")}</button>
          </div>
        ))}
      </div>

      <div class="panel">
        <h2>{t("接続テスト")}</h2>
        {conns.data && !devices.length && <p class="muted">{t("AIをつなぐと、ここでテストできます。")}</p>}
        {devices.map((c) => {
          const checks = me.data?.setup.checks.filter((x) => x.connection_id === c.id) ?? [];
          return (
            <div class="conn" key={c.id}>
              <div class="row spread">
                <strong>{c.label}</strong>
                <button class="ghost small" onClick={() => setTesting(c.id)}>{t("テストする")}</button>
              </div>
              <ul class="checks">{checks.map(checkLine)}</ul>
              {testing === c.id && (
                <p class="notice">{t("テストしたいAIに次のように伝えてください。")} <strong>{t("Approval Boxのsetup_testを実行して")}</strong>{t("テストの申請に答えると、AIが受け取り、ここが「確認済み」になります。")}</p>
              )}
            </div>
          );
        })}
      </div>

      <Guides />
      <Tokens />
    </section>
  );
}

export function Pair({ code }: { code: string }) {
  const [info, setInfo] = useState<{ pairing_id: string; device_name: string; os?: string; clients: string[]; client?: string; client_name?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    api<typeof info>("GET", `/pairing/lookup?code=${encodeURIComponent(code)}`).then(setInfo).catch((e: Error) => setError(e.message));
  }, [code]);

  async function decide(claim: boolean) {
    try {
      // 登録クライアント（BellTeamなど）の承認は、許す相手を画面に出した上で、その名前を添えて送る。
      await api("POST", `/pairing/${info!.pairing_id}/${claim ? "claim" : "reject"}`, claim ? { confirm_client: info!.client } : undefined);
      const name = info!.client_name ?? "";
      setDone(info!.client
        ? (claim ? t("許可しました。{name}の画面で接続が続きます。", { name }) : t("許可しませんでした。{name}は接続されません。", { name }))
        : (claim ? t("追加しました。PCの画面でセットアップが続きます。") : t("断りました。この端末は追加されません。")));
      bump();
    } catch (e) { setError((e as Error).message); }
  }

  return (
    <section>
      <h1>{info?.client ? t("アプリの接続を許可") : t("AIをつなぐ")}</h1>
      {error && <p class="error">{systemMessage(error)}</p>}
      {done && <><p class="notice">{systemMessage(done)}</p><button class="ghost" onClick={() => navigate("/connections")}>{t("接続へ")}</button></>}
      {info?.client && !done && (
        <div class="panel">
          <p>{t("{name}があなたの決裁箱の申請を読み、あなたが押した答えを送ることを許可しますか？", { name: info.client_name ?? "" })}</p>
          <dl class="pairing"><dt>{t("接続元")}</dt><dd>{info.device_name}</dd></dl>
          <p class="muted">{t("{name}は、あなたの申請をすべて読めます。自分で{name}の接続を始めた覚えがなければ「許可しない」を押してください。", { name: info.client_name ?? "" })}</p>
          <div class="row">
            <button class="primary" onClick={() => decide(true)}>{t("許可する")}</button>
            <button class="ghost danger" onClick={() => decide(false)}>{t("許可しない")}</button>
          </div>
        </div>
      )}
      {info && !info.client && !done && (
        <div class="panel">
          <p>{t("このAIをつなぎますか？")}</p>
          <dl class="pairing">
            <dt>{t("端末名")}</dt><dd>{info.device_name}</dd>
            {info.os && <><dt>OS</dt><dd>{info.os}</dd></>}
            <dt>{t("使うAI")}</dt><dd>{info.clients.map(clientLabel).join("・") || "—"}</dd>
          </dl>
          <p class="muted">{t("自分で approval-box の setup を実行した覚えがなければ「心当たりがない」を押してください。")}</p>
          <div class="row">
            <button class="primary" onClick={() => decide(true)}>{t("つなぐ")}</button>
            <button class="ghost danger" onClick={() => decide(false)}>{t("心当たりがない")}</button>
          </div>
        </div>
      )}
    </section>
  );
}
