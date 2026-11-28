import { useEffect, useState } from "preact/hooks";
import { api, fetchAttachment, isNoContract } from "./api";
import { account } from "./device.ts";
import { createHistory, IndexedDbHistoryStore } from "./history.ts";
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
  const [state, setState] = useState<{ data?: T; error?: string; noContract?: boolean; loading: boolean }>({ loading: true });
  useEffect(() => {
    let alive = true;
    load().then((data) => alive && setState({ data, loading: false })).catch((error: Error) => alive && setState({ error: error.message, noContract: isNoContract(error), loading: false }));
    return () => { alive = false; };
  }, [tick, ...deps]);
  return state;
}

export const loadOpen = () => api<{ items: Decision[] }>("GET", "/decisions?status=pending,held&limit=200").then((r) => r.items);
/** This browser's history (history.ts): decided requests stay here after the server deletes their content. */
export const localHistory = createHistory({ store: new IndexedDbHistoryStore(), call: (method, path) => api(method, path), fetchFile: fetchAttachment, entry: () => account()?.entry, onChange: () => bump() });
/** A file of a request: this browser's history copy first (the server removes the files at its purge), else the server. */
export const attachmentBlob = async (decisionId: string, attachmentId: string) => (await localHistory.file(decisionId, attachmentId)) ?? fetchAttachment(decisionId, attachmentId);
export const loadClosed = () => localHistory.list();
export const loadMe = () => api<Me>("GET", "/me");
