import { libraryLogin, api, setSession } from "./api";
import { libraryClient } from "./librarylogin";
import { showAlert } from "./dialog";
import { t } from "./i18n.ts";

// ログアウトの後に画面をログインへ戻すのは main.tsx。ログアウトはここ1つ（設定・契約の画面から使う）。
let afterSignOut: () => void = () => {};
export const setSignOutHandler = (fn: () => void) => { afterSignOut = fn; };
export const signedOut = () => afterSignOut();

export async function logout() {
  if (libraryLogin()) {
    try { await libraryClient().signOut(); } catch { showAlert(t("ログアウトできませんでした。通信を確かめてください。")); return; }
    afterSignOut();
    return;
  }
  try { await api("POST", "/auth/logout"); } catch { /* 期限切れでも続ける */ }
  setSession(null);
  afterSignOut();
}
