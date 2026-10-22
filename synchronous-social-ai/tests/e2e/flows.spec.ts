import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { apiCall, eventually, jpeg, signupViaUi } from "./helpers";

test("unauthenticated users are sent to sign in", async ({ page }) => {
  await page.goto("/overview");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});

test("onboarding → draft → approval → mock publish → comment-to-DM", async ({ page }) => {
  await signupViaUi(page);
  // Company Brain: profile + product with approved link.
  await page.getByLabel("Description").fill("Hand-poured soy candles made in small batches.");
  await page.getByLabel("Markets (one per line)").fill("India");
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByText("Company profile saved")).toBeVisible();
  await page.getByRole("tab", { name: /Products & links/ }).click();
  await page.getByRole("button", { name: "Add product" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Aurora Candle");
  await page.getByLabel("Approved product URL").fill("https://shop.example.com/aurora");
  await page.getByLabel(/^Price/).fill("25.00");
  await page.getByLabel("Keywords for matching comments").fill("candle, aurora");
  await page.getByLabel("Stock status").selectOption("in_stock");
  await page.getByRole("button", { name: "Save product" }).click();
  await expect(page.getByText("Product saved")).toBeVisible();
  await expect(page.getByText("shop.example.com", { exact: true })).toBeVisible();

  // Integrations: mock Instagram (clearly labelled).
  await page.goto("/integrations");
  await page.getByRole("button", { name: "Connect mock Instagram" }).click();
  await expect(page.getByText("Mock Instagram connected (development only)")).toBeVisible();
  await expect(page.getByText("Mock", { exact: true }).first()).toBeVisible();

  // Media upload.
  await page.goto("/media");
  await page
    .getByLabel("Upload media")
    .setInputFiles({ name: "aurora.jpg", mimeType: "image/jpeg", buffer: jpeg() });
  await expect(page.getByText("Uploaded", { exact: true }).first()).toBeVisible();

  // Content Studio: create, attach media, prepare for approval.
  await page.goto("/content?new=1");
  await page.getByLabel("Title (internal)").fill("Aurora launch");
  await page.getByLabel("Channel", { exact: true }).selectOption({ index: 1 });
  await page.getByLabel("Featured product").selectOption({ label: "Aurora Candle" });
  await page.getByLabel("Caption (optional)").fill("Meet the Aurora Candle. https://shop.example.com/aurora");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("dialog").getByText(/version 1/)).toBeVisible();
  await page.getByRole("button", { name: "Choose media" }).click();
  await page
    .getByRole("button", { name: /Media|aurora/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByLabel("Alt text (accessibility)").fill("A lit soy candle on a wooden table");
  await page.getByRole("button", { name: "Save as new version" }).click();
  await expect(page.getByText("New version saved")).toBeVisible();
  await page.getByRole("button", { name: "Prepare for approval" }).click();
  await expect(page.getByText("Sent to the Approval Center")).toBeVisible();

  // Approval Center: exact version, then approve.
  await page.goto("/approvals");
  await expect(page.getByText("Post: Aurora launch").first()).toBeVisible();
  await expect(page.getByText(/MOCK account: nothing will be posted/)).toBeVisible();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText(/Approved — execution queued/)).toBeVisible();

  // Worker publishes to the mock adapter; UI labels it as mock.
  await page.goto("/content");
  await eventually(page, async () => {
    await expect(page.getByRole("row", { name: /Aurora launch/ }).getByText("Published")).toBeVisible({
      timeout: 2000,
    });
  });

  // Comment-to-DM: simulate an official-webhook-shaped comment on the published post.
  const accounts = await apiCall<{ accounts: Array<{ id: string; provider: string }> }>(
    page,
    "/integrations",
  );
  const ig = accounts.accounts.find((a) => a.provider === "instagram")!;
  const content = await apiCall<Array<{ title: string; publishedMediaId: string | null }>>(page, "/content");
  const mediaId = content.find((c) => c.title === "Aurora launch")!.publishedMediaId!;
  await apiCall(page, "/inbox/simulate", {
    accountId: ig.id,
    kind: "comment",
    text: "Please send me the link",
    mediaId,
    username: "meera",
  });
  await page.goto("/inbox?tab=comments");
  await eventually(page, async () => {
    await expect(page.getByText("@meera").first()).toBeVisible({ timeout: 2000 });
    await expect(page.getByText("Private reply (DM)").first()).toBeVisible({ timeout: 2000 });
  });
  await expect(page.getByText("https://shop.example.com/aurora").first()).toBeVisible();
  await expect(page.getByText("Product link").first()).toBeVisible();

  // Separate approval for the private reply.
  await page.goto("/approvals");
  await page.getByRole("link", { name: /Private reply \(DM\) to @meera/ }).click();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Approve" }).click();
  await page.goto("/inbox?tab=comments");
  await eventually(page, async () => {
    await expect(page.getByText(/Private reply \(DM\) · MOCK \(not sent\)/)).toBeVisible({ timeout: 2000 });
  });
});

test("rejection returns to draft; permanent provider failure is visible and recoverable", async ({
  page,
}) => {
  await signupViaUi(page, "Failure Co");
  const acct = await apiCall<{ id: string }>(page, "/integrations/mock", { provider: "instagram" });
  const upload = await page.request.post("/api/v1/media", {
    headers: { "x-ssa-csrf": "1" },
    multipart: { file: { name: "a.jpg", mimeType: "image/jpeg", buffer: jpeg() } },
  });
  const asset = (await upload.json()) as { id: string };
  const make = (title: string, caption: string) =>
    apiCall<{ id: string }>(page, "/content", {
      title,
      format: "post",
      connectedAccountId: acct.id,
      version: { caption, altText: "alt", mediaAssetIds: [asset.id] },
    });
  const a = await make("To reject", "Hello world");
  const ap = await apiCall<{ id: string; payloadHash: string }>(
    page,
    `/content/${a.id}/request-approval`,
    {},
  );
  await page.goto(`/approvals?id=${ap.id}`);
  await page.getByRole("button", { name: "Reject" }).click();
  await page.getByLabel("Reason").fill("Off-brand tone");
  await page.getByRole("dialog").getByRole("button", { name: "Reject" }).click();
  await expect(page.getByText("Decision recorded")).toBeVisible();
  await page.goto(`/content?id=${a.id}`);
  await expect(page.getByRole("dialog").getByText("Draft", { exact: true })).toBeVisible();

  const b = await make("Will fail", "Hello [mock:denied]");
  const ap2 = await apiCall<{ id: string; payloadHash: string }>(
    page,
    `/content/${b.id}/request-approval`,
    {},
  );
  await apiCall(page, `/approvals/${ap2.id}/decision`, { decision: "approve", payloadHash: ap2.payloadHash });
  await page.goto(`/content?id=${b.id}`);
  await eventually(page, async () => {
    await expect(page.getByText("Last publish attempt failed")).toBeVisible({ timeout: 2000 });
  });
  await page.getByRole("button", { name: "Return to draft" }).click();
  await expect(page.getByText("Returned to draft")).toBeVisible();
});

test("media generation job completes with the labelled mock provider", async ({ page }) => {
  await signupViaUi(page, "Media Co");
  await page.goto("/media");
  await page.getByRole("button", { name: "Generate" }).click();
  await page.getByLabel(/Prompt/).fill("Editorial photo of a soy candle in soft daylight");
  await page.getByRole("button", { name: "Queue generation" }).click();
  await expect(page.getByText("Generation queued")).toBeVisible();
  await eventually(page, async () => {
    await expect(page.getByText("MOCK generated").first()).toBeVisible({ timeout: 2000 });
  });
});

test("multi-channel: connect X and Facebook, write for X within its limit, copy to Facebook", async ({
  page,
}) => {
  await signupViaUi(page, "Channels Co");
  await page.goto("/integrations");
  for (const ch of ["X", "Facebook"]) {
    await page.getByRole("button", { name: `Connect mock ${ch}` }).click();
    await expect(page.getByText(`Mock ${ch} connected (development only)`)).toBeVisible();
  }
  await expect(page.getByTestId("channel-x").getByText("1 connected")).toBeVisible();
  await expect(page.getByTestId("channel-facebook").getByText("1 connected")).toBeVisible();

  await page.goto("/content?new=1");
  await page.getByLabel("Title (internal)").fill("Weekend drop");
  await page
    .getByLabel("Channel", { exact: true })
    .selectOption({ label: "X · @mock_brand (MOCK — nothing is posted)" });
  // TikTok-only/IG-only formats disappear; X offers post, multi-image and video.
  await expect(page.getByLabel("Format", { exact: true }).locator("option")).toHaveText([
    "Post",
    "Multi-image",
    "Video",
  ]);
  await page.getByLabel("Caption (optional)").fill("x".repeat(290));
  await page.getByRole("button", { name: "Create", exact: true }).click();
  const drawer = page.getByRole("dialog");
  await expect(drawer.getByText("X allows 280 characters; this has 290.")).toBeVisible();
  await expect(drawer.getByText("290/280", { exact: true })).toBeVisible();
  await drawer.getByLabel(/^Caption/).fill("Weekend drop is live.");
  await drawer.getByRole("button", { name: "Save as new version" }).click();
  await expect(page.getByText("New version saved")).toBeVisible();
  await expect(drawer.getByText("X rules")).toHaveCount(0);

  await drawer.getByRole("button", { name: "Copy to channel" }).click();
  await page
    .getByRole("dialog", { name: "Copy to another channel" })
    .getByLabel("Channel", { exact: true })
    .selectOption({ index: 1 });
  await page.getByRole("button", { name: "Create copy" }).click();
  await expect(page.getByText("Draft created for the new channel")).toBeVisible();
  await expect(page.getByRole("dialog").getByText(/Facebook Post · version 1/)).toBeVisible();
  await page.goto("/content");
  await expect(page.getByRole("row", { name: /Weekend drop · Facebook/ })).toBeVisible();
});

test("owner manages AI models, keys and prices in Settings; the key is never shown again", async ({
  page,
}) => {
  await signupViaUi(page, "Keys Co");
  await page.goto("/settings");
  await page.getByRole("tab", { name: "AI models & keys" }).click();
  await page.getByLabel("Default model").fill("claude-haiku-5.5");
  await page.getByLabel("API key", { exact: true }).fill("sk-e2e-secret-value-WXYZ");
  await page.getByLabel(/Gateway image model/).check();
  await page.getByRole("button", { name: "Save AI settings" }).click();
  await expect(page.getByText(/AI settings saved/)).toBeVisible();
  await page.reload();
  await page.getByRole("tab", { name: "AI models & keys" }).click();
  await expect(page.getByLabel("Default model")).toHaveValue("claude-haiku-5.5");
  await expect(page.getByText(/Saved ••••WXYZ/)).toBeVisible();
  await expect(page.getByText("Workspace key")).toBeVisible();
  expect(await page.content()).not.toContain("sk-e2e-secret-value-WXYZ");
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(
    r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id),
  ).toEqual([]);
});

test("primary pages have no serious accessibility violations", async ({ page }) => {
  await signupViaUi(page, "A11y Co");
  for (const path of [
    "/overview",
    "/brain",
    "/content",
    "/inbox",
    "/approvals",
    "/campaigns",
    "/integrations",
    "/settings",
  ]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    const serious = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(serious.map((v) => `${path}: ${v.id} (${v.nodes.length})`)).toEqual([]);
  }
});
