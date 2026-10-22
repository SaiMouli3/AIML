import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";

export const PASSWORD = "e2e password 1234";

export async function signupViaUi(page: Page, company = "Lumen Candle Co") {
  const email = `e2e-${randomUUID().slice(0, 8)}@example.test`;
  await page.goto("/signup");
  await page.getByLabel("Your name").fill("Riya Sharma");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByLabel("Company / workspace name").fill(company);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await page.waitForURL("**/brain?onboarding=1");
  return email;
}

/** JSON API call from the signed-in browser context (sends the session cookie and CSRF header). */
export async function apiCall<T = unknown>(
  page: Page,
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
): Promise<T> {
  const res = await page.request.fetch(`/api/v1${path}`, {
    method,
    headers: { "x-ssa-csrf": "1", "content-type": "application/json" },
    data: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  expect(res.ok(), `${method} ${path} → ${res.status()} ${JSON.stringify(json)}`).toBeTruthy();
  return json as T;
}

export const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(512, 7)]);

/** Reload until `check` passes (background worker processes jobs asynchronously). */
export async function eventually(page: Page, check: () => Promise<void>, tries = 20) {
  for (let i = 0; i < tries; i++) {
    try {
      await check();
      return;
    } catch (e) {
      if (i === tries - 1) throw e;
      await page.waitForTimeout(1500);
      await page.reload();
    }
  }
}
