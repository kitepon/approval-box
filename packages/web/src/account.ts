import { browserDevice, setAccount } from "./device.ts";
import { showAlert } from "./dialog";
import { t } from "./i18n.ts";
import { localHistory } from "./store";

// ログアウトの後に画面をログインへ戻すのは main.tsx。ログアウトはここ1つ（設定・契約の画面から使う）。
let afterSignOut: () => void = () => {};
export const setSignOutHandler = (fn: () => void) => { afterSignOut = fn; };
export const signedOut = () => afterSignOut();

/** keys/leave: the server forgets this browser's key. Then the key and this browser's history go too. A key the server no longer knows leaves anyway. */
export async function logout() {
  try { await browserDevice().leave(); } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== "not_signed_in" && code !== "no_key") { showAlert(t("ログアウトできませんでした。通信を確かめてください。")); return; }
  }
  await browserDevice().deleteKey().catch(() => {});
  await localHistory.clearAll().catch(() => {});
  setAccount(undefined);
  afterSignOut();
}
