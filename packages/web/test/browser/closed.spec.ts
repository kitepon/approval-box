import { test, expect } from "@playwright/test";

// Owner 2026-11-21: the browser client is closed. Every path except /pair shows a static notice and calls no API.
for (const path of ["/", "/history", "/d/K-1", "/connections", "/settings", "/plan", "/login", "/anything"]) {
  test(`${path} shows the closed notice and makes no /v1 request`, async ({ page }) => {
    const api: string[] = [];
    page.on("request", (request) => { if (/\/(v1|auth\/v1)\//.test(new URL(request.url()).pathname)) api.push(request.url()); });
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "The browser version has ended" })).toBeVisible();
    await expect(page.getByText("Please use Approval Box in the apps for iPhone, iPad, Mac, Android and Linux.", { exact: false })).toBeVisible();
    await expect(page.getByRole("link", { name: "Support (get the app)" })).toHaveAttribute("href", "/support.html");
    await expect(page.getByRole("link", { name: "Terms of Service" })).toHaveAttribute("href", "/terms.html");
    await expect(page.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute("href", "/privacy.html");
    await expect(page.getByRole("navigation")).toHaveCount(0);
    await expect(page.getByRole("button")).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(api).toEqual([]);
  });
}

test("/pair still runs the sign-in then the consent page, without the menu or the event stream", async ({ page }) => {
  const calls: string[] = [];
  let signedIn = false;
  await page.route("**/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname; calls.push(path);
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/v1/auth/config") return json(200, { library_login: true });
    if (!signedIn) return json(401, { error: "pass_invalid" });
    if (path === "/v1/me") return json(200, { plan: "active" });
    if (path === "/v1/pairing/lookup") return json(200, { pairing_id: "p1", device_name: "BellTeam on box", clients: [], client: "bellteam", client_name: "BellTeam" });
    return json(200, {});
  });
  await page.route("**/auth/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname.slice("/auth/v1/".length);
    if (path === "handoff/start") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ slotId: "s".repeat(22), qrPayload: "lbq1:" + "s".repeat(22), shortCode: "ABCD2345", takeSecret: "x", checkNumber: "42", expiresAt: new Date(Date.now() + 300_000).toISOString() }) });
    if (path === "handoff/take") { signedIn = true; return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "ready" }) }); }
    return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });
  await page.goto("/pair?c=ABCD2345");
  await page.getByRole("button", { name: "Sign in with phone approval" }).click();
  await expect(page.getByRole("heading", { name: "Allow an app to connect" })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Allow", exact: true })).toBeVisible();
  await expect(page.getByRole("navigation")).toHaveCount(0);
  expect(calls).not.toContain("/v1/events");
});
