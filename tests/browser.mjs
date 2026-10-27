import { createRequire } from "node:module";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { createServer } from "../server.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const cacheDir = await mkdtemp(join(tmpdir(), "better-backlog-web-"));
let fails = false,
  delay = 0,
  aborted = 0;
const calls = [];
const discoveryUrls = [];
const issues = Array.from({ length: 6 }, (_, i) => ({
  id: i + 1,
  number: i + 1,
  title: [
    "Streaming hangs after connection drops",
    "Add a separate upload timeout",
    "Retry count resets after rate limiting",
    "Document environment variables",
    "Gateway returns duplicate responses",
    "<img src=x onerror=alert(1)>",
  ][i],
  body: "Fictional issue body for browser verification.",
  html_url: `https://github.com/acme/widgets/issues/${i + 1}`,
  user: { login: "example-user" },
  state: "open",
  created_at: "2026-10-24T12:00:00Z",
  updated_at: "2026-10-27T12:00:00Z",
  comments: i,
  reactions: { "+1": i },
  labels: [{ name: "bug", color: "d73a4a" }],
  assignees: [],
}));
const server = createServer({
  defaultRepo: "acme/widgets",
  cacheDir,
  settingsPath: join(cacheDir, ".env"),
  environment: {},
  githubLoader: async (repo, state) => {
    if (fails) throw Error("private diagnostic");
    return issues.map((i) => ({ ...i, state }));
  },
  authCheck: async () => true,
  modelFetcher: async (url, options) => {
    if (url.endsWith("/models") || url.endsWith("/model/info"))
      discoveryUrls.push(url);
    if (url.endsWith("/models"))
      return Response.json({
        data: [{ id: "jev-gateway" }, { id: "chat-only" }],
      });
    if (url.endsWith("/model/info"))
      return Response.json({
        data: [
          { model_name: "jev-gateway", model_info: { mode: "decisions" } },
          { model_name: "chat-only", model_info: { mode: "chat" } },
        ],
      });
    const body = JSON.parse(options.body);
    calls.push({ url, body });
    if (delay)
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, delay);
        options.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            aborted++;
            reject(new DOMException("Stopped", "AbortError"));
          },
          { once: true },
        );
      });
    const issue = JSON.parse(body.state).issue;
    return Response.json({
      answers: Object.fromEntries(
        Object.keys(body.questions).map((k) => [
          k,
          {
            choice:
              issue.number === 1
                ? "yes"
                : issue.number === 2
                  ? "unknown"
                  : "no",
          },
        ]),
      ),
    });
  },
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : {}),
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  colorScheme: "light",
});
const errors = [];
const evaluationRequests = [];
page.on("request", (request) => {
  if (request.url().endsWith("/api/evaluate-batch"))
    evaluationRequests.push(request.postDataJSON());
});
page.on("pageerror", (e) => errors.push(e.message));
await mkdir("test-results", { recursive: true });
try {
  await page.clock.install({ time: Date.now() });
  await page.goto(url);
  await page.locator("#issues .issue").first().waitFor();
  assert.equal(await page.locator("#issues .issue").count(), 6);
  assert.ok(
    (await page.locator("#updated-at").textContent()).includes("Updated"),
  );
  assert.equal(await page.locator("#issues img").count(), 0);
  await page.locator("#settings-toggle").click();
  assert.equal(await page.locator("#provider").inputValue(), "jev");
  assert.equal(await page.locator("#gateway-url").isVisible(), false);
  await page.locator("#api-key").fill("FAKE_TEST_KEY");
  await page.locator("#repository").fill("acme/widgets");
  await page.locator("#settings summary").click();
  await page
    .locator("#guidance")
    .fill("Use the supplied date for relative dates.");
  await page.locator("#settings button[type=submit]").click();
  await page.locator("#settings").waitFor({ state: "hidden" });
  await page.locator("#criterion").fill("Created this week");
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/evaluate-batch")),
    page.locator("#criterion").press("Enter"),
  ]);
  await page.waitForFunction(
    () =>
      !document.querySelector("#stop").offsetParent &&
      document.querySelector("#show-all").offsetParent,
  );
  assert.ok(calls.length >= 6);
  assert.equal(await page.locator("#criteria .chip").count(), 1);
  assert.equal(await page.locator("#issues .issue").count(), 1);
  assert.equal(await page.locator("#error").isVisible(), false);
  assert.equal(JSON.parse(calls[0].body.state).coverage.comments, false);
  assert.ok(JSON.parse(calls[0].body.state).evaluation.weekday);
  assert.ok(
    calls[0].body.questions.rule_0.instructions.includes(
      "Use the supplied date",
    ),
  );
  assert.ok(!JSON.stringify(calls).includes("FAKE_TEST_KEY"));
  await page.locator("#recent .freshness.fresh").waitFor();
  assert.equal(await page.locator("#recent .counter").textContent(), "1");
  await page.locator("#show-all").click();
  assert.equal(await page.locator("#issues .issue").count(), 6);
  await page.screenshot({
    path: "test-results/website-light.png",
    fullPage: true,
  });
  await page.locator(".chip-label").click();
  assert.equal(
    await page.locator("#criterion").inputValue(),
    "Created this week",
  );
  await page.locator("#criterion").press("Escape");
  await page.locator(".chip").hover();
  await page.locator(".chip-remove").click();
  assert.equal(await page.locator("#criteria .chip").count(), 0);
  const beforeRecent = calls.length;
  await page.locator(".recent-apply", { hasText: "Created this week" }).click();
  await page.waitForFunction(() =>
    document.querySelector("#status").textContent.startsWith("1 of 6"),
  );
  assert.equal(calls.length, beforeRecent);
  assert.equal(await page.locator("#criteria .chip").count(), 1);
  const active = page.locator(".recent-item.active");
  await active.hover();
  await active.locator(".recent-remove").click();
  assert.equal(await page.locator(".recent-remove.confirm").textContent(), "Remove");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".recent-remove.confirm").count(), 0);
  await active.hover();
  await active.locator(".recent-remove").click();
  await page.locator(".recent-remove.confirm").click();
  assert.equal(await page.locator("#criteria .chip").count(), 0);
  assert.equal(await page.locator("#issues .issue").count(), 6);
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".recent-text")].every(
      (text) => text.textContent !== "Created this week",
    ),
  );
  await page.locator("#settings-toggle").click();
  await page.locator("#provider").selectOption("gateway");
  await page.locator("#base-url").fill("https://gateway.example.com");
  await page.locator("#api-key").fill("FAKE_GATEWAY_KEY");
  await page.locator("#load-models").click();
  await page.waitForFunction(() =>
    document.querySelector('#model option[value="jev-gateway"]'),
  );
  await page.locator("#model").selectOption("jev-gateway");
  await page.locator("#settings button[type=submit]").click();
  await page.locator("#settings").waitFor({ state: "hidden" });
  await page.locator("#criterion").fill("There is a reproducible problem");
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/evaluate-batch")),
    page.locator("#criterion").press("Enter"),
  ]);
  await page.waitForFunction(
    () =>
      !document.querySelector("#stop").offsetParent &&
      document.querySelector("#show-all").offsetParent,
  );
  assert.ok(
    calls.some(
      (c) =>
        c.url === "https://gateway.example.com/v1/systemone" &&
        c.body.model === "jev-gateway",
    ),
  );
  await page.locator(".chip").hover();
  await page.locator(".chip-remove").click();
  await page.route("**/api/evaluate-batch", async (route) => {
    await route.fulfill({
      contentType: "application/x-ndjson",
      body:
        JSON.stringify({
          type: "result",
          number: 1,
          verdict: "yes",
          decisions: [{ verdict: "yes" }],
        }) + "\n",
    });
  });
  await page
    .locator("#criterion")
    .fill("Keep progress after a connection drops");
  await page.locator("#criterion").press("Enter");
  await page.waitForFunction(() =>
    document.querySelector("#error").textContent.includes("ended early"),
  );
  assert.equal(
    await page.locator("#status").textContent(),
    "1 of 6 issues · 5 pending",
  );
  await page.unroute("**/api/evaluate-batch");
  const retryRequest = page.waitForRequest((request) =>
    request.url().endsWith("/api/evaluate-batch"),
  );
  await page.locator("#retry").click();
  const retryPayload = (await retryRequest).postDataJSON();
  assert.equal(retryPayload.numbers.length, 5);
  assert.ok(retryPayload.numbers.every((number) => number !== 1));
  await page.waitForFunction(
    () =>
      document.querySelector("#status").textContent ===
      "1 of 6 issues · 1 unclear",
  );
  await page.locator(".chip").hover();
  await page.locator(".chip-remove").click();
  fails = true;
  await page.locator("#reload").click();
  await page.locator("#error").waitFor({ state: "visible" });
  assert.equal(await page.locator("#issues .issue").count(), 6);
  assert.ok(
    !(await page.locator("body").textContent()).includes("private diagnostic"),
  );
  fails = false;
  await page.locator("#reload").click();
  await page.locator("#error").waitFor({ state: "hidden" });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.screenshot({
    path: "test-results/website-mobile.png",
    fullPage: true,
  });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: "test-results/website-dark.png",
    fullPage: true,
  });
  await page.reload();
  await page.locator("#issues .issue").first().waitFor();
  await page.locator("#settings-toggle").click();
  assert.equal(await page.locator("#provider").inputValue(), "gateway");
  await page.locator("#settings-close").click();
  delay = 5000;
  const previousCalls = calls.length;
  await page
    .locator("#criterion")
    .fill("A different criterion for cancellation");
  await page.locator("#criterion").press("Enter");
  await page.locator("#stop").waitFor({ state: "visible" });
  await page.locator("#progress").waitFor({ state: "visible" });
  assert.equal(await page.locator("#issues .issue").count(), 0);
  for (
    let attempt = 0;
    calls.length === previousCalls && attempt < 100;
    attempt++
  )
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(calls.length > previousCalls);
  await page.locator("#stop").click();
  await page.locator("#retry").waitFor({ state: "visible" });
  for (let attempt = 0; aborted === 0 && attempt < 100; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(aborted > 0, "Stop must abort upstream model requests");
  delay = 0;
  await page.locator(".chip").hover();
  await page.locator(".chip-remove").click();
  await page.locator("#settings-toggle").click();
  if (!(await page.locator("#fetch-hours").isVisible()))
    await page.locator("#settings summary").click();
  assert.equal(await page.locator("#fetch-hours").inputValue(), "24");
  await page.locator("#fetch-hours").fill("0.25");
  await page.locator("#settings button[type=submit]").click();
  assert.match(
    await page.locator("#reload-countdown").textContent(),
    /Reloading in/,
  );
  const fakeNow = Date.now();
  let automaticReloads = 0;
  await page.route("**/api/reload", async (route) => {
    automaticReloads++;
    await route.fulfill({
      json: {
        issues,
        repo: "acme/widgets",
        state: "open",
        updatedAt: new Date(fakeNow + 901000).toISOString(),
        cached: false,
      },
    });
  });
  const refreshed = page.waitForResponse((response) =>
    response.url().endsWith("/api/reload"),
  );
  await page.clock.fastForward(901000);
  await refreshed;
  await page.waitForFunction(() =>
    document
      .querySelector("#reload-countdown")
      .textContent.match(/Reloading in 0:1[45]:/),
  );
  assert.equal(automaticReloads, 1);
  assert.deepEqual(errors, []);
  assert.ok(evaluationRequests.length);
  assert.deepEqual(discoveryUrls, [
    "https://gateway.example.com/v1/models",
    "https://gateway.example.com/model/info",
  ]);
  assert.ok(
    evaluationRequests.every(
      (request) => !("key" in request) && !("baseUrl" in request),
    ),
  );
  assert.ok(
    !(
      await page.evaluate(() => localStorage.getItem("better-backlog:settings"))
    ).includes("FAKE_"),
  );
  console.log(
    "Browser checks passed: issue loading, TypeSafe setup, criterion chips, cached recent filters, full model context, unknown visibility, edit/delete, gateway discovery/evaluation, reload recovery, persisted settings, stop, desktop/mobile/light/dark, configurable automatic reload countdown.",
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(cacheDir, { recursive: true, force: true });
}
