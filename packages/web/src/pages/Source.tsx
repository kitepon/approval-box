import { clientLabel } from "../format";
import type { Decision } from "../types";

/**
 * 誰から・何の仕事の申請か。サーバーが組み立てた一行（session_label）をそのまま出し、先頭の申請者の名前だけを目立たせる。
 * 申請者を送らない古いコネクタの申請は、作業名だけになる。
 */
export function Source({ source }: { source: Decision["source"] }) {
  const label = source.session_label;
  const who = source.requester && label.startsWith(source.requester) ? source.requester : undefined;
  return (
    <>
      <span class="chip">{clientLabel(source.client)}</span>
      <span class="session">{who ? <><strong class="requester">{who}</strong>{label.slice(who.length)}</> : label}</span>
    </>
  );
}
