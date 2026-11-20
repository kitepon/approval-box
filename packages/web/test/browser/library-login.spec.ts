import { test, expect, type Page } from "@playwright/test";

// The library is mocked at /auth/v1 (wire v1) and /v1; the Web must use the cookie only (no Authorization header) and the public web entry.
const start = { slotId: "s".repeat(22), qrPayload: "lbq1:" + "s".repeat(22), shortCode: "ABCD2345", takeSecret: "secret", checkNumber: "42", expiresAt: new Date(Date.now() + 300_000).toISOString() };
const json = (route: { fulfill: (o: object) => Promise<void> }, status: number, body: unknown, headers: Record<string, string> = {}) =>
  route.fulfill({ status, contentType: "application/json", headers, body: JSON.stringify(body) });

async function fixture(page: Page, options: { libraryLogin?: boolean; signedIn?: boolean; takes?: ("pending" | "ready" | "gone")[]; decisions402?: boolean } = {}) {
  const seen = { authorization: [] as (string | undefined)[], starts: 0, signouts: 0, exports: 0, labels: [] as string[], signedIn: options.signedIn ?? false };
  const takes = [...(options.takes ?? ["pending", "ready"])];
  // "**/v1/**" also matches /auth/v1/..., and the route registered last wins, so the library mock comes last.
  await page.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    seen.authorization.push(await route.request().headerValue("authorization") ?? undefined);
    if (url.pathname === "/v1/auth/config") return json(route, 200, { library_login: options.libraryLogin ?? true, ...(options.libraryLogin === false ? { apple_services_id: "dev.example.web" } : {}) });
    if (!seen.signedIn) return json(route, 401, { error: "pass_invalid" });
    if (url.pathname === "/v1/me") return json(route, 200, { user_id: "k", login: null, billing: "store", plan: options.decisions402 ? "expired" : "active", setup: { verified: true, checks: [] }, purchase_mark: "k" });
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

test("library login: QR, short code and check number, then the app opens with the cookie only", async ({ page }) => {
  const seen = await fixture(page);
  await page.goto("/");
  await expect(page.getByText("Check that the number it shows is 42.", { exact: false })).toBeVisible();
  await expect(page.getByText("ABCD-2345", { exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: "QR code" }).locator("svg")).toBeVisible();
  await expect(page.getByText("subscribe on your phone first", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in with Apple" })).toHaveCount(0);
  expect(seen.labels).toEqual(["Chrome on Linux"]);
  await expect(page.getByRole("link", { name: "Inbox" })).toBeVisible({ timeout: 10_000 });
  expect(seen.authorization.every((value) => value === undefined)).toBe(true);
});

test("library login: an expired code offers a new one", async ({ page }) => {
  const seen = await fixture(page, { takes: ["gone"] });
  await page.goto("/");
  await expect(page.getByText("The code has expired.")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Get a new code" }).click();
  await expect(page.getByText("WXYZ-6789", { exact: true })).toBeVisible();
  expect(seen.starts).toBe(2);
});

test("an already signed-in browser skips the login; settings export downloads the file and sign out goes through the library", async ({ page }) => {
  const seen = await fixture(page, { signedIn: true });
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Account" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete account and all data" })).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Get a copy of the information we keep" }).click();
  expect((await download).suggestedFilename()).toBe("approval-box-export-20261120.json");
  expect(seen.exports).toBe(1);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("img", { name: "QR code" })).toBeVisible();
  expect(seen.signouts).toBe(1);
  expect(seen.authorization.every((value) => value === undefined)).toBe(true);
});

test("a 402 shows the subscribe-in-the-app notice where the inbox would be", async ({ page }) => {
  await fixture(page, { signedIn: true, decisions402: true });
  await page.goto("/");
  await expect(page.getByText("Subscribe in the iPhone, Mac or Android app", { exact: false })).toBeVisible();
});

test("without library_login the Apple button stays and no library login starts", async ({ page }) => {
  const seen = await fixture(page, { libraryLogin: false });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Sign in with Apple" })).toBeVisible();
  expect(seen.starts).toBe(0);
});
