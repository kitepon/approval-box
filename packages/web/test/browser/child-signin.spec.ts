import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { decision, signIn, stubServer } from "./child.ts";

test("S1: Google or Apple per /auth/config, the first-time steps, legal links and the language picker; nothing starts until pressed", async ({ page }) => {
  const s = await stubServer(page, { config: { google_client_id: "web.apps.googleusercontent.com", apple_services_id: "dev.kitepon.approvalbox.web" } });
  await page.route("https://appleid.cdn-apple.com/**", (route) => route.fulfill({ status: 200, contentType: "text/javascript", body: "" }));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Approval Box", exact: true })).toBeVisible();
  await expect(page.getByText("Answer your AI's questions from your phone or computer.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in with Google" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in with Apple" })).toBeVisible();
  await expect(page.getByText("Scan it with Approval Box on the iPhone of the same account", { exact: false })).toBeVisible();
  await expect(page.getByRole("link", { name: "Terms of Service" })).toHaveAttribute("href", "/terms.html");
  await expect(page.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute("href", "/privacy.html");
  await expect(page.getByRole("combobox", { name: "Language" })).toBeVisible();
  await page.getByText("New here?").click();
  await expect(page.getByText("npx -y approval-box@latest setup")).toBeVisible();
  expect(s.calls).toEqual([]);
});

test("S2: Google in the pop-up, then a QR of 700 px or more with plain guidance; the phone's admission opens the inbox; every /v1 call is signed, never a Bearer", async ({ page }) => {
  const s = await stubServer(page, { open: [decision("K-1")] });
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in with Google" }).click();
  const qr = page.getByRole("img", { name: "QR code" }).locator("svg");
  await expect(qr).toBeVisible();
  expect((await qr.boundingBox())!.width).toBeGreaterThanOrEqual(700);
  await expect(page.getByText("Scan this QR code with Approval Box on the iPhone of the same account", { exact: true })).toBeVisible();
  await expect(page.getByText(/^Valid until \d\d:\d\d$/)).toBeVisible();
  await expect(page.getByRole("navigation")).toHaveCount(0);
  s.admitted = true;
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("title K-1")).toBeVisible();
  expect(s.calls.length).toBeGreaterThan(0);
  for (const call of s.calls) {
    expect(call.key, call.path).toMatch(/^v1 k=[A-Za-z0-9_-]{87} t=\d+ n=[A-Za-z0-9_-]{22} s=[A-Za-z0-9_-]{86}$/);
    expect(call.authorization, call.path).toBeUndefined();
  }
  // A reload keeps the key: straight to the inbox.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
});

test("S2: cancel returns to S1", async ({ page }) => {
  await stubServer(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in with Google" }).click();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("button", { name: "Sign in with Google" })).toBeVisible();
});

test("S1b: a signed-in browser whose key the phone removed (401 not_signed_in) returns to S1 with the reason", async ({ page }) => {
  const s = await stubServer(page);
  await signIn(page, s);
  s.admitted = false;
  await page.getByRole("link", { name: "History" }).click();
  await expect(page.getByRole("status").filter({ hasText: "You were signed out. Please sign in again." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in with Google" })).toBeVisible();
});

test("sign out: keys/leave, the key and the history go, S1", async ({ page }) => {
  const s = await stubServer(page);
  await signIn(page, s);
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("button", { name: "Delete account and all data" })).toHaveCount(0); // a child leaves; it does not delete the account
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("button", { name: "Sign in with Google" })).toBeVisible();
  expect(s.leaves).toBe(1);
  s.admitted = true; // even if the server still knew it, the browser keeps no key now
  await page.reload();
  await expect(page.getByRole("button", { name: "Sign in with Google" })).toBeVisible();
});

test("/pair as a child: says plainly to approve on the iPhone app, offers no Allow; Deny still works", async ({ page }) => {
  const s = await stubServer(page);
  await signIn(page, s, "/pair?c=ABCD2345");
  await expect(page.getByRole("heading", { name: "Allow an app to connect" })).toBeVisible();
  await expect(page.getByText("Approve this connection in the Approval Box app on an iPhone, iPad, Mac or Android device of the same account. It can't be approved in a browser.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Allow", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Don't allow" }).click();
  await expect.poll(() => s.calls.some((c) => c.path === "/v1/pairing/p1/reject")).toBe(true);
  await expect(page.getByText("Not allowed. BellTeam will not be connected.", { exact: false })).toBeVisible();
});

test("history: decided requests are kept in this browser with their files and acked (stored); after the server removed the content and files, the copy here still shows, with the tombstone's delivery", async ({ page }) => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  const image = { id: "img1", name: "screen.png", content_type: "image/png", kind: "image", size: png.length, sha256: createHash("sha256").update(png).digest("hex"), created_at: new Date().toISOString() };
  const answered = decision("K-9", { status: "answered", delivery: "waiting", request_attachments: [image], answer: { option_id: "b", answered_at: new Date().toISOString() } });
  const s = await stubServer(page, { closed: [answered], files: new Map([["img1", png]]) });
  await signIn(page, s, "/history");
  await expect(page.getByText("title K-9")).toBeVisible();
  await expect.poll(() => s.stored).toEqual(["K-9"]);
  // The server purged it: gone from its list, its view a tombstone.
  s.closed = [];
  s.files.clear();
  s.views.set("K-9", { ...answered, title: "", context: "", options: [], request_attachments: [], history: [], answer: undefined, delivery: "delivered", content_removed: true, version: 2 });
  await page.reload();
  await expect(page.getByText("title K-9")).toBeVisible();
  await page.getByText("title K-9").click();
  await expect(page.getByRole("heading", { name: "title K-9" })).toBeVisible();
  await expect(page.getByText("Option B", { exact: false }).first()).toBeVisible();
  await expect(page.getByRole("img", { name: "screen.png" })).toBeVisible(); // the file from the copy here
  await expect(page.getByText("Delivered to AI")).toBeVisible(); // the tombstone's delivery, not the copy's old "waiting"
});
