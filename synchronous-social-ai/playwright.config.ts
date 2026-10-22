import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;
const env = {
  APP_ENV: "test",
  APP_URL: `http://localhost:${PORT}`,
  DATABASE_URL: process.env.E2E_DATABASE_URL ?? "postgres://sync:sync@localhost:5432/sync_e2e",
  LLM_API_KEY: "",
  HIGGSFIELD_API_KEY_ID: "",
  HIGGSFIELD_API_KEY_SECRET: "",
  META_ADS_TEST_MODE: "true",
  STORAGE_LOCAL_DIR: ".data/e2e-storage",
  LOG_LEVEL: "warn",
  PORT: String(PORT),
};

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
      : undefined,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: `npx next start -p ${PORT}`,
      url: `http://localhost:${PORT}/api/health`,
      env,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    { command: "npx tsx src/worker/index.ts", env, timeout: 120_000 },
  ],
});
