import { test, expect, type Page } from "@playwright/test";

// The library is mocked at /auth/v1 (wire v1) and /v1; the Web must use the cookie only (no Authorization header) and the public web entry.
const start = { slotId: "s".repeat(22), qrPayload: "lbq1:" + "s".repeat(22), shortCode: "ABCD2345", takeSecret: "secret", checkNumber: "42", expiresAt: new Date(Date.now() + 300_000).toISOString() };
const json = (route: { fulfill: (o: object) => Promise<void> }, status: number, body: unknown, headers: Record<string, string> = {}) =>
  route.fulfill({ status, contentType: "application/json", headers, body: JSON.stringify(body) });

async function fixture(page: Page, options: { libraryLogin?: boolean; signedIn?: boolean; takes?: ("pending" | "ready" | "gone")[]; decisions402?: boolean; code401?: string } = {}) {
  const seen = { authorization: [] as (string | undefined)[], starts: 0, signouts: 0, exports: 0, labels: [] as string[], signedIn: options.signedIn ?? false };
  const takes = [...(options.takes ?? ["pending", "ready"])];
  // "**/v1/**" also matches /auth/v1/..., and the route registered last wins, so the library mock comes last.
  await page.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    seen.authorization.push(await route.request().headerValue("authorization") ?? undefined);
    if (url.pathname === "/v1/auth/config") return json(route, 200, { library_login: options.libraryLogin ?? true, ...(options.libraryLogin === false ? { apple_services_id: "dev.example.web" } : {}) });
    if (!seen.signedIn) return json(route, 401, { error: options.code401 ?? "pass_invalid" });
    if (url.pathname === "/v1/me") return json(route, 200, { user_id: "k", login: null, billing: "store", plan: options.decisions402 ? "expired" : "active", ...(options.decisions402 ? {} : { store: "app_store", expires_at: "2026-12-21T00:00:00Z" }), setup: { verified: true, checks: [] }, purchase_mark: "k" });
    if (url.pathname === "/v1/me/settings") return json(route, 200, { retention_days: 30 });
    if (url.pathname === "/v1/me/export") { seen.exports++; return route.fulfill({ status: 200, contentType: "application/json", headers: { "content-disposition": 'attachment; filename="approval-box-export-20261120.json"' }, body: '{"account":{}}' }); }
    if (url.pathname === "/v1/decisions" && options.decisions402) return json(route, 402, { error: { code: "subscription_expired", message: "Approval Boxの契約がありません。" } });
    if (url.pathname === "/v1/decisions") return json(route, 200, { items: [] });
    if (url.pathname === "/v1/events") return route.fulfill({ status: 200, contentType: "text/event-stream", body: "" });
    return json(route, 200, {});
  });
  await page.route("**/auth/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname.slice("/auth/v1/".length);
    if (path === "handoff/start") { seen.starts++; seen.labels.push(route.request().postDataJSON().deviceLabel); return json(route, 200, { ...start, shortCode: seen.starts > 1 ? "WXYZ6789" : start.shortCode }); }
    if (path === "handoff/take") {
      const next = takes.shift() ?? "pending";
      if (next === "gone") return json(route, 410, { error: "slot_gone" });
      if (next === "ready") seen.signedIn = true;
      return json(route, 200, { status: next });
    }
    if (path === "signout") { seen.signouts++; seen.signedIn = false; return json(route, 200, { ok: true }); }
    return json(route, 404, { error: "bad_request" });
  });
  return seen;
}

const startLogin = (page: Page) => page.getByRole("button", { name: "Sign in with phone approval" }).click();

test("S1: the phone-approval button starts nothing until pressed; purpose, first-time steps, legal links and language picker are on it", async ({ page }) => {
  const seen = await fixture(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Approval Box", exact: true })).toBeVisible();
  await expect(page.getByText("Answer your AI's questions from your phone or computer.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Terms of Service" })).toHaveAttribute("href", "/terms.html");
  await expect(page.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute("href", "/privacy.html");
  await expect(page.getByRole("link", { name: "Support" })).toHaveAttribute("href", "/support.html");
  await expect(page.getByRole("combobox", { name: "Language" })).toBeVisible();
  await page.getByText("New here?").click();
  await expect(page.getByText("npx -y approval-box@latest setup")).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy command" })).toBeVisible();
  await expect(page.getByText("press “Sign in with phone approval” on this screen", { exact: false })).toBeVisible();
  expect(seen.starts).toBe(0);
});

test("S2: QR, login code, check number, validity and the guidance; cancel returns to S1; then the app opens with the cookie only", async ({ page }) => {
  const seen = await fixture(page, { takes: ["pending", "pending", "ready"] });
  await page.goto("/");
  await startLogin(page);
  await expect(page.getByText("Scan the QR", { exact: false })).toHaveCount(0);
  await expect(page.getByText("On the subscribed phone, open Approval Box, go to Settings → Sign in other devices, then scan this QR code or enter the code. If the check number matches, press “Allow”.")).toBeVisible();
  await expect(page.getByText("Check number", { exact: true })).toBeVisible();
  await expect(page.getByText("42", { exact: true })).toBeVisible();
  await expect(page.getByText("Login code", { exact: true })).toBeVisible();
  await expect(page.getByText("ABCD-2345", { exact: true })).toBeVisible();
  await expect(page.getByText(/^Valid until \d\d:\d\d$/)).toBeVisible();
  await expect(page.getByRole("img", { name: "QR code" }).locator("svg")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in with Apple" })).toHaveCount(0);
  expect(seen.labels).toEqual(["Chrome on Linux"]);
  await expect(page.getByRole("link", { name: "Inbox" })).toBeVisible({ timeout: 10_000 });
  expect(seen.authorization.every((value) => value === undefined)).toBe(true);
});

test("S2: cancel (やめる) goes back to S1", async ({ page }) => {
  await fixture(page);
  await page.goto("/");
  await startLogin(page);
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("button", { name: "Sign in with phone approval" })).toBeVisible();
});

test("S2: an expired code stays on S2 and offers a new one", async ({ page }) => {
  const seen = await fixture(page, { takes: ["gone"] });
  await page.goto("/");
  await startLogin(page);
  await expect(page.getByText("The code has expired.")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
  await expect(page.getByText(/On the subscribed phone/)).toHaveCount(0);
  await page.getByRole("button", { name: "Get a new code" }).click();
  await expect(page.getByText("WXYZ-6789", { exact: true })).toBeVisible();
  expect(seen.starts).toBe(2);
});

for (const [code, text] of [
  ["pass_refused", "This device was signed out from the phone that approved it. Please sign in again."],
  ["pass_expired", "You were signed out because this device was not used for a while. Please sign in again."],
  ["pass_invalid", "You were signed out. Please sign in again."],
] as const) test(`S1b: a signed-in browser that gets 401 ${code} returns to S1 with its reason`, async ({ page }) => {
  const seen = await fixture(page, { signedIn: true, code401: code });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Inbox", exact: true })).toBeVisible();
  seen.signedIn = false;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByRole("status").filter({ hasText: text })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in with phone approval" })).toBeVisible();
});

test("S1: a first visit that is simply signed out shows no banner", async ({ page }) => {
  await fixture(page);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Sign in with phone approval" })).toBeVisible();
  await expect(page.getByRole("status")).toHaveCount(0);
});

test("an already signed-in browser skips the login; settings sections, export and sign out go through the library", async ({ page }) => {
  const seen = await fixture(page, { signedIn: true });
  await page.goto("/settings");
  await expect(page.getByText("Subscribed (App Store)")).toBeVisible();
  const headings = await page.getByRole("heading", { level: 2 }).allTextContents();
  expect(headings).toEqual(["Account", "Subscription", "Other devices", "Notifications", "Language", "History storage", "Help", "Account management"]);
  await expect(page.getByText("The browser version has no notifications. You can receive notifications in the phone and PC apps.", { exact: true })).toBeVisible();
  await expect(page.getByText("Expires: 12/21/2026")).toBeVisible();
  await expect(page.getByText("Signed in with phone approval", { exact: true })).toBeVisible();
  await expect(page.getByText("Subscribed (App Store)")).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete account and all data" })).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Get a copy of the information we keep" }).click();
  expect((await download).suggestedFilename()).toBe("approval-box-export-20261120.json");
  expect(seen.exports).toBe(1);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("button", { name: "Sign in with phone approval" })).toBeVisible();
  expect(seen.signouts).toBe(1);
  expect(seen.authorization.every((value) => value === undefined)).toBe(true);
});

test("S7: Settings → About your subscription shows the status, the cannot-buy text and the legal links", async ({ page }) => {
  await fixture(page, { signedIn: true });
  await page.goto("/settings");
  await page.getByRole("link", { name: "About your subscription" }).click();
  await expect(page).toHaveURL(/\/plan$/);
  await expect(page.getByRole("heading", { name: "Subscription", exact: true })).toBeVisible();
  await expect(page.getByText("Subscribed (App Store)")).toBeVisible();
  await expect(page.getByText("Expires:", { exact: false })).toBeVisible();
  await expect(page.getByText("You can't subscribe on this device.", { exact: false })).toBeVisible();
  await expect(page.getByText("This device is signed in through the approval of the subscribed phone.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Notation based on the Specified Commercial Transactions Act" })).toBeVisible();
});

test("a 402 shows S7 (cannot-buy text, status, Sign out) in place of the inbox and history, and Sign out leaves", async ({ page }) => {
  const seen = await fixture(page, { signedIn: true, decisions402: true });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Subscription", exact: true })).toBeVisible();
  await expect(page.getByText("Not subscribed", { exact: true })).toBeVisible();
  await expect(page.getByText("You can't subscribe on this device. Subscribe in the Approval Box app on iPhone, iPad, Mac or Android, from Settings → Subscription.")).toBeVisible();
  await page.getByRole("link", { name: "History" }).click();
  await expect(page.getByRole("heading", { name: "Subscription", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("button", { name: "Sign in with phone approval" })).toBeVisible();
  expect(seen.signouts).toBe(1);
});

test("the event stream stops on 402 instead of retrying forever", async ({ page }) => {
  await fixture(page, { signedIn: true, decisions402: true });
  let events = 0;
  await page.route("**/v1/events", (route) => { events++; return json(route, 402, { error: "no_entitlement" }); });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Subscription", exact: true })).toBeVisible();
  await page.waitForTimeout(3500);
  expect(events).toBe(1);
});

test("without library_login the Apple button stays and no library login starts", async ({ page }) => {
  const seen = await fixture(page, { libraryLogin: false });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Sign in with Apple" })).toBeVisible();
  expect(seen.starts).toBe(0);
});
