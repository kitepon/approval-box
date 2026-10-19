import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./test/browser",
  fullyParallel: true,
  use: {
    baseURL: "http://127.0.0.1:4179",
    locale: "en-US",
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH },
  },
  webServer: {
    command: "npm run dev -w packages/web -- --host 127.0.0.1 --port 4179 --strictPort",
    cwd: "../..",
    url: "http://127.0.0.1:4179",
    reuseExistingServer: false,
  },
});
