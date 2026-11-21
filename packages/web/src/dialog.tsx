import { useEffect, useRef, useState } from "preact/hooks";
import { systemMessage, t } from "./i18n.ts";

// S9: 失敗はこの1つの警告で出す（題は「確認してください」）。ブラウザ標準のalertは題を付けられない。
let show: (message: string) => void = () => {};
export const showAlert = (message: string) => show(message);

export function AlertHost() {
  const [message, setMessage] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { show = setMessage; return () => { show = () => {}; }; }, []);
  useEffect(() => { if (message !== null && !dialog.current?.open) dialog.current?.showModal(); }, [message]);
  if (message === null) return null;
  return (
    <dialog ref={dialog} class="alert" role="alertdialog" aria-labelledby="alert-title" onClose={() => setMessage(null)}>
      <h2 id="alert-title">{t("確認してください")}</h2>
      <p>{systemMessage(message)}</p>
      <form method="dialog"><button class="primary" autoFocus>{t("閉じる")}</button></form>
    </dialog>
  );
}
