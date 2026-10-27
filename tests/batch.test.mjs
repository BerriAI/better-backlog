import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "../server.mjs";

const sampleIssues = (count) =>
  Array.from({ length: count }, (_, index) => ({
    number: index + 1,
    title: `Fictional issue ${index + 1}`,
    body: "Reproduction steps and an observed failure. ".repeat(100),
    html_url: `https://github.com/acme/widgets/issues/${index + 1}`,
    state: "open",
    created_at: "2026-10-01T12:00:00Z",
    updated_at: "2026-10-27T12:00:00Z",
    user: { login: "example-user", type: "User" },
    reactions: { "+1": 7, total_count: 7 },
    labels: [{ name: "bug", description: "An observed failure" }],
    projectsV2: { nodes: [{ title: "Roadmap" }] },
    closedByPullRequestsReferences: { nodes: [{ number: 99, state: "OPEN" }] },
    metadata_coverage: { projects: { available: true, complete: false } },
    custom_metadata: { nested: ["preserve", "these", "fields"] },
  }));

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await delay(5);
  }
}

function controlledProvider() {
  const calls = [];
  let active = 0, maximum = 0, automatic = false;
  const finish = (call, status = 200) => {
    if (call.finished) return;
    call.finished = true;
    call.signal.removeEventListener("abort", call.abort);
    active--;
    call.gate.resolve(
      status === 200
        ? Response.json({
            answers: Object.fromEntries(
              Object.keys(call.body.questions).map((name) => [name, { choice: "yes" }]),
            ),
          })
        : new Response("private-upstream-diagnostic fake-test-key", { status }),
    );
  };
  return {
    calls,
    get active() { return active; },
    get maximum() { return maximum; },
    async fetcher(url, options) {
      const body = JSON.parse(options.body);
      const call = {
        startedAt: performance.now(),
        url,
        body,
        options,
        number: JSON.parse(body.state).issue.number,
        signal: options.signal,
        gate: deferred(),
        finished: false,
      };
      call.abort = () => {
        if (call.finished) return;
        call.finished = true;
        call.aborted = true;
        active--;
        call.gate.reject(new DOMException("Aborted", "AbortError"));
      };
      calls.push(call);
      active++;
      maximum = Math.max(maximum, active);
      call.signal.addEventListener("abort", call.abort, { once: true });
      if (call.signal.aborted) call.abort();
      else if (automatic) finish(call);
      return call.gate.promise;
    },
    resolve(number, status = 200) {
      const call = calls.find((item) => item.number === number && !item.finished);
      assert.ok(call, `Issue ${number} must be active before resolving it`);
      finish(call, status);
    },
    releaseAll() {
      automatic = true;
      for (const call of calls) finish(call);
    },
  };
}

async function fixture(t, count = 160) {
  const folder = await mkdtemp(path.join(tmpdir(), "better-backlog-batch-test-"));
  const settingsPath = path.join(folder, ".env");
  await writeFile(settingsPath, "BACKLOG_API_KEY='fake-test-key'\n", { mode: 0o600 });
  const provider = controlledProvider();
  const issues = sampleIssues(count);
  const server = createServer({
    cacheDir: path.join(folder, "cache"),
    settingsPath,
    environment: {},
    githubLoader: async () => issues,
    authCheck: async () => true,
    defaultRepo: "",
    modelFetcher: provider.fetcher,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(folder, { recursive: true, force: true });
  });
  const snapshot = await (await fetch(base + "/api/issues?repo=acme/widgets")).json();
  const post = (route, body, signal) => fetch(base + route, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base },
    body: JSON.stringify(body),
    signal,
  });
  const payload = (numbers, overrides = {}) => ({
    repo: "acme/widgets",
    state: "open",
    snapshotVersion: snapshot.updatedAt,
    timeZone: "America/Los_Angeles",
    guidance: "Treat a runnable reproduction as concrete evidence.",
    criteria: ["Describes a bug"],
    numbers,
    ...overrides,
  });
  return { server, provider, issues, snapshot, post, payload, folder, settingsPath };
}

async function* events(response) {
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /ndjson/);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      let end;
      while ((end = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, end).trim();
        pending = pending.slice(end + 1);
        if (line) yield JSON.parse(line);
      }
      if (done) break;
    }
    if (pending.trim()) yield JSON.parse(pending);
  } finally {
    reader.releaseLock();
  }
}

async function collect(response) {
  const result = [];
  for await (const event of events(response)) result.push(event);
  return result;
}

test("batch evaluation exceeds browser connection limits and shares a global 64-call cap", { timeout: 10000 }, async (t) => {
  const app = await fixture(t);
  const first = app.post("/api/evaluate-batch", app.payload(Array.from({ length: 80 }, (_, i) => i + 1)));
  const second = app.post("/api/evaluate-batch", app.payload(Array.from({ length: 80 }, (_, i) => i + 81)));
  await waitFor(() => app.provider.active >= 64, "The server never started 64 simultaneous model calls");
  // Hold all upstream responses while both local requests reach the worker pool.
  await delay(50);
  assert.equal(app.provider.active, 64);
  assert.equal(app.provider.maximum, 64);
  app.provider.releaseAll();
  const results = await Promise.all([first.then(collect), second.then(collect)]);
  assert.equal(app.provider.calls.length, 160);
  assert.equal(app.provider.maximum, 64);
  for (const result of results) {
    assert.equal(result.filter((event) => event.type === "result").length, 80);
    assert.deepEqual(result.at(-1), { type: "done" });
    assert.equal(result.filter((event) => event.type === "done").length, 1);
  }
});

test("results stream in completion order before slower issues finish", { timeout: 10000 }, async (t) => {
  const app = await fixture(t, 3);
  const response = app.post("/api/evaluate-batch", app.payload([1, 2, 3]));
  await waitFor(() => app.provider.active === 3, "All three model calls should overlap");
  app.provider.resolve(3);
  const stream = events(await response);
  const first = (await stream.next()).value;
  assert.equal(first.type, "result");
  assert.equal(first.number, 3);
  assert.equal(first.verdict, "yes");
  assert.deepEqual(first.decisions.map((decision) => decision.verdict), ["yes"]);
  assert.equal(app.provider.active, 2);
  app.provider.resolve(1);
  assert.equal((await stream.next()).value.number, 1);
  app.provider.resolve(2);
  assert.equal((await stream.next()).value.number, 2);
  assert.deepEqual((await stream.next()).value, { type: "done" });
  assert.equal((await stream.next()).done, true);
});

test("simultaneous batches share an 80-start rolling one-second rate limit", { timeout: 10000 }, async (t) => {
  const app = await fixture(t, 100);
  app.provider.releaseAll();
  const first = app.post("/api/evaluate-batch", app.payload(Array.from({ length: 50 }, (_, i) => i + 1)));
  const second = app.post("/api/evaluate-batch", app.payload(Array.from({ length: 50 }, (_, i) => i + 51)));
  const results = await Promise.all([first.then(collect), second.then(collect)]);
  assert.equal(results.flat().filter((event) => event.type === "result").length, 100);
  assert.equal(app.provider.calls.length, 100);
  const starts = app.provider.calls.map((call) => call.startedAt).sort((a, b) => a - b);
  // Allow two milliseconds for the scheduler's wall-clock rounding.
  for (let index = 80; index < starts.length; index++)
    assert.ok(starts[index] - starts[index - 80] >= 998, "More than 80 provider calls started in a rolling second");
});

test("disconnecting aborts active provider calls without starting queued issues", { timeout: 10000 }, async (t) => {
  const app = await fixture(t, 128);
  const controller = new AbortController();
  const response = app.post("/api/evaluate-batch", app.payload(app.issues.map((issue) => issue.number)), controller.signal);
  const settled = response.then((res) => res.text()).catch(() => {});
  await waitFor(() => app.provider.active === 64, "Expected a full active batch before cancellation");
  controller.abort();
  await settled;
  await waitFor(() => app.provider.active === 0, "Client cancellation did not abort the provider calls");
  await delay(25);
  assert.equal(app.provider.calls.length, 64);
  assert.ok(app.provider.calls.every((call) => call.aborted));
});

test("a fatal provider rate limit cancels its batch and never leaks upstream diagnostics", { timeout: 10000 }, async (t) => {
  const app = await fixture(t, 128);
  const response = app.post("/api/evaluate-batch", app.payload(app.issues.map((issue) => issue.number)));
  await waitFor(() => app.provider.active === 64, "Expected a full active batch before the rate limit");
  const failedNumber = app.provider.calls[0].number;
  app.provider.resolve(failedNumber, 429);
  const result = await collect(await response);
  await waitFor(() => app.provider.active === 0, "Fatal error left provider calls running");
  assert.equal(app.provider.calls.length, 64);
  const error = result.find((event) => event.type === "error");
  assert.ok(error);
  assert.equal(error.number, failedNumber);
  assert.equal(error.status, 429);
  assert.match(error.error, /rate limit/i);
  assert.ok(!JSON.stringify(result).includes("private-upstream-diagnostic"));
  assert.ok(!JSON.stringify(result).includes("fake-test-key"));
  assert.equal(result.filter((event) => event.type === "result").length, 0);
  assert.deepEqual(result.at(-1), { type: "done" });
});

test("snapshot conflicts and malformed batch items reject the entire request before spend", { timeout: 10000 }, async (t) => {
  const app = await fixture(t, 2);
  const invalid = [
    { criteria: [] },
    { criteria: "not an array" },
    { criteria: [null] },
    { criteria: ["Valid", " "] },
    { criteria: ["Same", "Same"] },
    { numbers: [] },
    { numbers: ["1"] },
    { numbers: [1, 1] },
    { numbers: [1, 999] },
    { timeZone: "not/a-time-zone" },
    { guidance: { instructions: "not text" } },
    { snapshotVersion: undefined },
  ];
  for (const overrides of invalid) {
    const response = await app.post("/api/evaluate-batch", app.payload([1], overrides));
    assert.ok([400, 404, 409].includes(response.status), `Malformed batch returned ${response.status}`);
    assert.match(response.headers.get("content-type"), /application\/json/);
    assert.equal(typeof (await response.json()).error, "string");
    assert.equal(app.provider.calls.length, 0);
  }
  await app.post("/api/reload", { repo: "acme/widgets", state: "open" });
  const stale = await app.post("/api/evaluate-batch", app.payload([1]));
  assert.equal(stale.status, 409);
  assert.match((await stale.json()).error, /reload/i);
  assert.equal(app.provider.calls.length, 0);
});

test("batch requests preserve full metadata, clock and guidance while ignoring client credentials", { timeout: 10000 }, async (t) => {
  const app = await fixture(t, 1);
  app.provider.releaseAll();
  const before = Date.now();
  const result = await collect(await app.post("/api/evaluate-batch", app.payload([1], {
    key: "fake-ignored-client-key",
    provider: "gateway",
    baseUrl: "https://untrusted.example",
    model: "ignored-client-model",
    criteria: ["Created after October 1", "Has a reproduction"],
  })));
  assert.equal(result[0].verdict, "yes");
  const call = app.provider.calls[0];
  assert.equal(call.url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(call.options.headers.Authorization, "Bearer fake-test-key");
  assert.equal(call.body.model, "jev-latest");
  const context = JSON.parse(call.body.state);
  const { html_url, ...withoutLinks } = app.issues[0];
  assert.equal(html_url.startsWith("https://github.com/"), true);
  assert.deepEqual(context.issue, withoutLinks);
  assert.equal(context.evaluation.issue_age_days.since_created >= 26, true);
  assert.match(call.body.questions.rule_0.instructions, /What you are seeing/);
  assert.equal(context.repository, "acme/widgets");
  assert.equal(context.evaluation.time_zone, "America/Los_Angeles");
  assert.match(context.evaluation.local_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(context.evaluation.weekday, /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/);
  assert.ok(Date.parse(context.evaluation.evaluated_at) >= before);
  assert.ok(Date.parse(context.evaluation.evaluated_at) <= Date.now());
  assert.match(call.body.questions.rule_0.instructions, /Created after October 1/);
  assert.match(call.body.questions.rule_1.instructions, /Has a reproduction/);
  for (const question of Object.values(call.body.questions))
    assert.match(question.instructions, /Treat a runnable reproduction as concrete evidence/);
  assert.equal(call.body.max_tokens, undefined);
  assert.equal(call.body.max_output_tokens, undefined);
  assert.ok(!JSON.stringify(result).includes("fake-test-key"));
});

test("a repeated filter answers from cache, reuses shared criteria, and goes stale on reload or new guidance", { timeout: 10000 }, async (t) => {
  const app = await fixture(t, 5);
  app.provider.releaseAll();
  const all = app.issues.map((issue) => issue.number);
  const guidance = app.payload([]).guidance;
  const filters = async (overrides = {}) =>
    (await (await app.post("/api/filters", { repo: "acme/widgets", state: "open", timeZone: "America/Los_Angeles", guidance, ...overrides })).json()).filters;
  await collect(await app.post("/api/evaluate-batch", app.payload(undefined, { criteria: ["A"] })));
  assert.equal(app.provider.calls.length, 5);
  assert.deepEqual(await filters(), [{ criteria: ["A"], fresh: true, matches: 5 }]);
  const repeat = await collect(await app.post("/api/evaluate-batch", app.payload(undefined, { criteria: ["A"] })));
  assert.equal(repeat.filter((event) => event.type === "result").length, 5);
  assert.equal(app.provider.calls.length, 5);
  await collect(await app.post("/api/evaluate-batch", app.payload(undefined, { criteria: ["A", "B"] })));
  assert.equal(app.provider.calls.length, 10);
  for (const call of app.provider.calls.slice(5)) {
    assert.deepEqual(Object.keys(call.body.questions), ["rule_0"]);
    assert.match(call.body.questions.rule_0.instructions, /filter: B$/);
  }
  assert.deepEqual((await filters()).map((filter) => [filter.criteria, filter.fresh]), [[["A", "B"], true], [["A"], true]]);
  assert.ok((await filters({ guidance: "Different instructions" })).every((filter) => !filter.fresh));
  const reloaded = await (await app.post("/api/reload", { repo: "acme/widgets", state: "open" })).json();
  assert.ok((await filters()).every((filter) => !filter.fresh && filter.matches === null));
  await collect(await app.post("/api/evaluate-batch", app.payload(all, { criteria: ["A"], snapshotVersion: reloaded.updatedAt })));
  assert.equal(app.provider.calls.length, 15);
  const cache = path.join(app.folder, "cache");
  const saved = await readFile(path.join(cache, (await readdir(cache)).find((name) => name.endsWith(".filters.json"))), "utf8");
  assert.ok(!saved.includes("fake-test-key"));
});

test("recent filters dedupe by set, survive a restart with cached results, cap at twelve, and can be removed", { timeout: 10000 }, async (t) => {
  const app = await fixture(t, 3);
  app.provider.releaseAll();
  await collect(await app.post("/api/evaluate-batch", app.payload(undefined, { criteria: ["A", "B"] })));
  await collect(await app.post("/api/evaluate-batch", app.payload(undefined, { criteria: ["B", "A"] })));
  const calls = app.provider.calls.length;
  for (let index = 0; index < 11; index++)
    await collect(await app.post("/api/evaluate-batch", app.payload([1], { criteria: [`Filter ${index}`] })));
  const restarted = createServer({
    cacheDir: path.join(app.folder, "cache"),
    settingsPath: app.settingsPath,
    environment: {},
    githubLoader: async () => { throw new Error("Download must not run"); },
    modelFetcher: app.provider.fetcher,
  });
  await new Promise((resolve) => restarted.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    restarted.closeAllConnections();
    await new Promise((resolve) => restarted.close(resolve));
  });
  const base = `http://127.0.0.1:${restarted.address().port}`;
  const list = async (body = {}) =>
    (await (await fetch(base + "/api/filters", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ repo: "acme/widgets", timeZone: "America/Los_Angeles", guidance: app.payload([]).guidance, ...body }),
    })).json()).filters;
  const recent = await list();
  assert.equal(recent.length, 12);
  assert.deepEqual(recent[0], { criteria: ["Filter 10"], fresh: false, matches: null });
  assert.deepEqual(recent[11], { criteria: ["B", "A"], fresh: true, matches: 3 });
  assert.equal(app.provider.calls.length, calls + 11);
  const remaining = await list({ remove: ["A", "B"] });
  assert.equal(remaining.length, 11);
  assert.ok(remaining.every((filter) => filter.criteria.join() !== "B,A"));
});
