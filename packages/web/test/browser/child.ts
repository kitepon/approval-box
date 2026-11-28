import type { Page, Route } from "@playwright/test";

// A stubbed server for the browser as a child device (login-billing 0.28.1 browser part). The library is real: the key is made in
// IndexedDB and every /v1 request is signed with it. Only the server and Google's pop-up are stubbed.
export type Decision = Record<string, unknown>;
export const decision = (id: string, o: Decision = {}): Decision => ({
  id, title: `title ${id}`, context: "context", options: [{ id: "a", label: "Option A" }, { id: "b", label: "Option B" }], urgency: "normal",
  source: { client: "codex", session_label: "Nayuta / work", via: "connector" }, status: "pending", resume_phrase: "r", history: [],
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(), version: 1, ...o,
});

export type Server = {
  admitted: boolean; open: Decision[]; files: Map<string, Buffer>; closed: Decision[]; views: Map<string, Decision>; stored: string[]; leaves: number;
  /** Every /v1 request but /auth/config and /keys/*: its path and its two auth headers. */
  calls: { path: string; key?: string; authorization?: string }[];
  config: Record<string, unknown>; lookup: Record<string, unknown>;
};

const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const b64u = (s: string) => Buffer.from(s).toString("base64url");

export async function stubServer(page: Page, o: Partial<Server> = {}): Promise<Server> {
  const s: Server = { admitted: false, open: [], files: new Map(), closed: [], views: new Map(), stored: [], leaves: 0, calls: [], config: { google_client_id: "web.apps.googleusercontent.com" }, lookup: { pairing_id: "p1", device_name: "BellTeam on box", clients: [], client: "bellteam", client_name: "BellTeam" }, ...o };
  const context = page.context();
  // Google's pop-up: answers at once with an id token for the nonce it was asked (the phone checks a real token; the browser only reads it).
  await context.route("https://accounts.google.com/**", (route) => {
    const q = new URL(route.request().url()).searchParams;
    const token = [b64u('{"alg":"none"}'), b64u(JSON.stringify({ sub: "google-sub-1", nonce: q.get("nonce") })), "sig"].join(".");
    return route.fulfill({ status: 302, headers: { location: `${q.get("redirect_uri")}#state=${q.get("state")}&id_token=${token}` } });
  });
  await context.route("**/v1/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    if (path === "/v1/auth/config") return json(route, 200, s.config);
    if (path === "/v1/keys/me") return s.admitted ? json(route, 200, { entry: "E1", role: "child" }) : json(route, 401, { error: "not_signed_in" });
    if (path === "/v1/keys/leave") { s.leaves++; s.admitted = false; return json(route, 200, {}); }
    s.calls.push({ path: path + url.search, key: (await req.headerValue("login-billing-key")) ?? undefined, authorization: (await req.headerValue("authorization")) ?? undefined });
    if (!s.admitted) return json(route, 401, { error: "not_signed_in" });
    if (path === "/v1/events") return route.fulfill({ status: 200, contentType: "text/event-stream", body: "" });
    if (path === "/v1/decisions" && req.method() === "GET") return json(route, 200, { items: url.searchParams.get("status")?.includes("answered") ? s.closed : s.open });
    if (path === "/v1/decisions" && req.method() === "DELETE") { const n = s.closed.length; s.closed = []; return json(route, 200, { deleted: n }); }
    const file = /^\/v1\/decisions\/[^/]+\/attachments\/([^/]+)$/.exec(path);
    if (file) { const bytes = s.files.get(file[1]!); return bytes ? route.fulfill({ status: 200, contentType: "image/png", body: bytes }) : json(route, 404, { error: { code: "not_found", message: "その添付は見つかりません。" } }); }
    const stored = /^\/v1\/decisions\/([^/]+)\/stored$/.exec(path);
    if (stored) { s.stored.push(stored[1]!); return json(route, 200, { decision_id: stored[1], stored: true }); }
    const one = /^\/v1\/decisions\/([^/]+)$/.exec(path);
    if (one) { const d = s.views.get(one[1]!); return d ? json(route, 200, d) : json(route, 404, { error: { code: "not_found", message: "その申請は見つかりません。" } }); }
    if (path === "/v1/me") return json(route, 200, { user_id: "E1", login: null, setup: { verified: true, checks: [] } });
    if (path === "/v1/me/settings") return json(route, 200, { retention_days: 30 });
    if (path === "/v1/pairing/lookup") return json(route, 200, s.lookup);
    if (path === "/v1/connections" || path === "/v1/onboarding") return json(route, 200, []);
    return json(route, 200, {});
  });
  return s;
}

/** S1 -> Google -> S2 (QR) -> the phone admits (stubbed keys/me) -> signed in. */
export async function signIn(page: Page, s: Server, path = "/") {
  await page.goto(path);
  await page.getByRole("button", { name: "Sign in with Google" }).click();
  await page.getByRole("img", { name: "QR code" }).locator("svg").waitFor();
  s.admitted = true;
  await page.getByRole("navigation").waitFor({ timeout: 10_000 });
}
