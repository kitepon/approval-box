import { t } from "../i18n.ts";
import type { Decision } from "../types";

/** S3/S4 共通: 絞り込みのチップと検索欄。検索は件名と「申請者 / 作業名」を端末の中で絞る。 */
export function ListFilters<V extends string>({ chips, value, onValue, query, onQuery }: { chips: [V, string][]; value: V; onValue: (v: V) => void; query: string; onQuery: (q: string) => void }) {
  return (
    <div class="filters">
      <div class="chips" role="group">
        {chips.map(([v, label]) => <button key={v} class={`filter ${v === value ? "active" : ""}`} aria-pressed={v === value} onClick={() => onValue(v)}>{label}</button>)}
      </div>
      <input type="search" value={query} placeholder={t("相談を検索")} aria-label={t("相談を検索")} onInput={(e) => onQuery((e.target as HTMLInputElement).value)} />
    </div>
  );
}

export const matches = (d: Decision, query: string) => {
  const q = query.trim().toLowerCase();
  return !q || d.title.toLowerCase().includes(q) || d.source.session_label.toLowerCase().includes(q);
};
