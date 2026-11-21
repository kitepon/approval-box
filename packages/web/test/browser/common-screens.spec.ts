import { test, expect, type Page } from "@playwright/test";

// S3-S5 and S9 of docs/architecture/screens.md (ID-login mode, API stubbed).
const base = { version: 1, urgency: "normal", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), options: [{ id: "go", label: "Go ahead" }, { id: "no", label: "Not now" }], history: [{ kind: "created", by: "ai", at: new Date().toISOString() }], resume_phrase: "resume", request_attachments: [] };
const src = (label: string) => ({ via: "local", client: "codex", requester: label, session_label: `${label} / work` });
const pend = { ...base, id: "K-P1", title: "Deploy the release", context: "ctx", status: "pending", source: src("Alpha") };
const held = { ...base, id: "K-H1", title: "Change the invoice", context: "ctx", status: "held", source: src("Beta") };
const done = { ...base, id: "K-D1", title: "Old question", context: "ctx", status: "answered", delivery: "delivered", answer: { option_id: "go", answered_at: new Date().toISOString() }, source: src("Gamma") };
const cancelled = { ...base, id: "K-C1", title: "Dropped request", context: "ctx", status: "cancelled", source: src("Delta") };

async function fixture(page: Page, onSettings?: (route: import("@playwright/test").Route) => Promise<void>) {
  await page.addInitScript(() => localStorage.setItem("approval-box.session", "fixture-only"));
  const state = { answered: false };
  await page.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url()), p = url.pathname, m = route.request().method();
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (p === "/v1/me") return json({ login: "google", billing: "store", plan: "active", store: "app_store", setup: { verified: true, checks: [] } });
    if (p === "/v1/me/settings") return onSettings && m === "PATCH" ? onSettings(route) : json({ retention_days: 30 });
    if (p === "/v1/events") return route.fulfill({ status: 200, contentType: "text/event-stream", body: "" });
    if (p === "/v1/decisions") return json({ items: url.search.includes("answered") ? [done, cancelled] : [pend, held] });
    if (p === "/v1/decisions/K-P1/answer" && m === "POST") { state.answered = true; return json({ ...pend, status: "answered", delivery: "waiting", answer: { option_id: "go", answered_at: new Date().toISOString() }, version: 2 }); }
    const d = /^\/v1\/decisions\/([^/]+)$/.exec(p);
    if (d) return json([pend, held, done, cancelled].find((x) => x.id === d[1]));
    if (p.endsWith("/attachments")) return json({ items: [] });
    if (p === "/v1/connections") return json([]);
    return json({});
  });
}

test("S3: heading, chips and search filter the inbox; held shows under the 保留 chip", async ({ page }) => {
  await fixture(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Inbox", exact: true })).toBeVisible();
  await expect(page.getByText("Deploy the release")).toBeVisible();
  await expect(page.getByText("Change the invoice")).toBeVisible();
  await page.getByRole("button", { name: "On hold", exact: true }).click();
  await expect(page.getByText("Deploy the release")).toHaveCount(0);
  await expect(page.getByText("Change the invoice")).toBeVisible();
  await page.getByRole("button", { name: "All", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search requests" }).fill("beta / work");
  await expect(page.getByText("Deploy the release")).toHaveCount(0);
  await expect(page.getByText("Change the invoice")).toBeVisible();
  await page.getByRole("searchbox", { name: "Search requests" }).fill("zzz");
  await expect(page.getByText("No matching requests.")).toBeVisible();
});

test("S4: chips filter the history, there is no delete button, and a request opened from History keeps History highlighted and Back returns there", async ({ page }) => {
  await fixture(page);
  await page.goto("/history");
  await expect(page.getByRole("heading", { name: "History", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete history" })).toHaveCount(0);
  await page.getByRole("button", { name: "Answered", exact: true }).click();
  await expect(page.getByText("Dropped request")).toHaveCount(0);
  await page.getByRole("button", { name: "All", exact: true }).click();
  await page.getByText("Old question").click();
  await expect(page).toHaveURL(/\/d\/K-D1$/);
  await expect(page.getByRole("link", { name: "History", exact: true })).toHaveClass(/active/);
  await expect(page.getByRole("link", { name: "Inbox" })).not.toHaveClass(/active/);
  await expect(page.getByText("Your answer")).toBeVisible();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page).toHaveURL(/\/history$/);
});

test("S5: sections in order, the answer is chosen then sent, and the app stays on the answered request", async ({ page }) => {
  await fixture(page);
  await page.goto("/");
  await page.getByText("Deploy the release").click();
  await expect(page.getByRole("link", { name: "Inbox" })).toHaveClass(/active/);
  const headings = await page.getByRole("heading").allTextContents();
  expect(headings.slice(0, 3)).toEqual(["Deploy the release", "Context", "How should we proceed?"]);
  const send = page.getByRole("button", { name: "Send answer", exact: true });
  await expect(send).toBeDisabled();
  await page.getByRole("radio", { name: "Go ahead" }).click();
  await expect(send).toBeEnabled();
  await expect(page.getByRole("button", { name: "Put on hold" })).toBeVisible();
  await send.click();
  await expect(page.getByText("Your answer")).toBeVisible();
  await expect(page).toHaveURL(/\/d\/K-P1$/);
});

test("S9: a failed operation opens an alert titled 確認してください (Please check)", async ({ page }) => {
  await fixture(page, (route) => route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: { code: "bad", message: "Could not save." } }) }));
  await page.goto("/settings");
  await page.locator("select").last().selectOption("90");
  const alert = page.getByRole("alertdialog");
  await expect(alert.getByRole("heading", { name: "Please check" })).toBeVisible();
  await expect(alert.getByText("Could not save.")).toBeVisible();
});
