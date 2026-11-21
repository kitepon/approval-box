import { test, expect, type Page } from "@playwright/test";
// The browser client is closed except /pair, so only the sign-in screen of /pair and the closed notice follow the language.
async function fixture(page: Page) {
  await page.route("**/v1/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
}

test("pair sign-in auto-detects English; selection persists, HTML lang and OS changes follow", async ({ page }) => {
  await fixture(page); await page.goto("/pair?c=ABCD2345");
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
  await page.goto("/pair?c=ABCD2345"); await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  await page.getByRole("combobox").selectOption("en"); await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByText("Answer your AI's questions from your phone or computer.", { exact: false })).toBeVisible(); await ctx.close();
});

for (const [tag, heading] of [["ja-JP", "ブラウザ版は終わりました"], ["en-US", "The browser version has ended"], ["ko-KR", "브라우저 버전은 종료되었습니다"], ["zh-CN", "浏览器版已经结束"], ["zh-TW", "瀏覽器版已經結束"]] as const) {
  test(`closed notice follows the browser language (${tag})`, async ({ browser }) => {
    const ctx = await browser.newContext({ locale: tag }); const page = await ctx.newPage(); await fixture(page);
    await page.goto("/"); await expect(page.getByRole("heading", { name: heading })).toBeVisible(); await ctx.close();
  });
}
