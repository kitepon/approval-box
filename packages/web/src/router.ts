import { useEffect, useState } from "preact/hooks";

export function navigate(path: string) {
  history.pushState(null, "", path);
  dispatchEvent(new PopStateEvent("popstate"));
}

export function useLocation() {
  const [location, setLocation] = useState(() => ({ path: window.location.pathname, query: new URLSearchParams(window.location.search) }));
  useEffect(() => {
    const update = () => setLocation({ path: window.location.pathname, query: new URLSearchParams(window.location.search) });
    addEventListener("popstate", update);
    return () => removeEventListener("popstate", update);
  }, []);
  return location;
}

/** リンク。修飾キー付きのクリックはブラウザに任せる。 */
export function linkProps(href: string) {
  return {
    href,
    onClick: (event: MouseEvent) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
      event.preventDefault();
      navigate(href);
    },
  };
}
