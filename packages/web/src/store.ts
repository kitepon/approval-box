import { useEffect, useState } from "preact/hooks";
import { api } from "./api";
import type { Decision, Me } from "./types";

type Listener = () => void;
const listeners = new Set<Listener>();
let version = 0;

/** サーバーからの知らせ（SSE）で画面を取り直す合図。 */
export function bump() {
  version++;
  for (const listener of listeners) listener();
}

export function useBump(): number {
  const [, set] = useState(0);
  useEffect(() => {
    const listener = () => set((n) => n + 1);
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);
  return version;
}

export function useResource<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const tick = useBump();
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  useEffect(() => {
    let alive = true;
    load().then((data) => alive && setState({ data, loading: false })).catch((error: Error) => alive && setState({ error: error.message, loading: false }));
    return () => { alive = false; };
  }, [tick, ...deps]);
  return state;
}

export const loadOpen = () => api<{ items: Decision[] }>("GET", "/decisions?status=pending,held&limit=200").then((r) => r.items);
export const loadClosed = () => api<{ items: Decision[] }>("GET", "/decisions?status=answered,cancelled&limit=200").then((r) => r.items);
export const loadMe = () => api<Me>("GET", "/me");
