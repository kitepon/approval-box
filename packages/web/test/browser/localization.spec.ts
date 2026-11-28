import { test, expect, type Page } from "@playwright/test";
// The sign-in screen (S1, no key in this browser) follows the browser language and the picker.
async function fixture(page: Page) {
  await page.route("**/v1/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(new URL(route.request().url()).pathname === "/v1/auth/config" ? { google_client_id: "web.apps.googleusercontent.com" } : {}) }));
}

test("sign-in auto-detects English; selection persists, HTML lang and OS changes follow", async ({ page }) => {
  await fixture(page); await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByText("Answer your AI's questions from your phone or computer.", { exact: false })).toBeVisible();
  await page.getByRole("combobox").selectOption("ja"); await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  await page.reload(); await expect(page.getByText("AIの相談に、スマホやPCから答えます。", { exact: false })).toBeVisible();
  await page.getByRole("combobox").selectOption("system"); await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.evaluate(() => { Object.defineProperty(navigator, "languages", { value: ["ja-JP"], configurable: true }); window.dispatchEvent(new Event("languagechange")); });
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
});

test("unsupported browser language falls back to Japanese and storage failure allows English choice", async ({ browser }) => {
  const ctx = await browser.newContext({ locale: "fr-FR" }); const page = await ctx.newPage(); await fixture(page);
  await page.addInitScript(() => { Storage.prototype.setItem = () => { throw new Error("storage blocked"); }; });
  await page.goto("/"); await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  await page.getByRole("combobox").selectOption("en"); await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByText("Answer your AI's questions from your phone or computer.", { exact: false })).toBeVisible(); await ctx.close();
});

for (const [tag, button] of [["ja-JP", "Googleでログイン"], ["en-US", "Sign in with Google"], ["ko-KR", "Google로 로그인"], ["zh-CN", "使用 Google 登录"], ["zh-TW", "使用 Google 登入"]] as const) {
  test(`the sign-in button follows the browser language (${tag})`, async ({ browser }) => {
    const ctx = await browser.newContext({ locale: tag }); const page = await ctx.newPage(); await fixture(page);
    await page.goto("/"); await expect(page.getByRole("button", { name: button })).toBeVisible(); await ctx.close();
  });
}
