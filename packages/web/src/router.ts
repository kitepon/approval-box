import { useEffect, useState } from "preact/hooks";

/** state.from は、相談を開いた元の一覧（履歴から開いたら "history"）。メニューの強調と「戻る」が使う。 */
export type NavState = { from?: "history" } | null;
export function navigate(path: string, state: NavState = null) {
  history.pushState(state, "", path);
  dispatchEvent(new PopStateEvent("popstate"));
}
export const listPath = () => ((history.state as NavState)?.from === "history" ? "/history" : "/");

export function useLocation() {
  const read = () => ({ path: window.location.pathname, query: new URLSearchParams(window.location.search), state: history.state as NavState });
  const [location, setLocation] = useState(read);
  useEffect(() => {
    const update = () => setLocation(read);
    addEventListener("popstate", update);
    return () => removeEventListener("popstate", update);
  }, []);
  return location;
}

/** リンク。修飾キー付きのクリックはブラウザに任せる。 */
export function linkProps(href: string, state: NavState = null) {
  return {
    href,
    onClick: (event: MouseEvent) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
      event.preventDefault();
      navigate(href, state);
    },
  };
}
