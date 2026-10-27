import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import {
  createServer,
  downloadIssues,
  enrichIssueMetadata,
} from "../server.mjs";
import { evaluateIssue, discoverModels, normalizeBase } from "../lib/jev.mjs";

const issue = {
  number: 42,
  title: "Cannot open a document",
  body: "Steps to reproduce. ".repeat(1000),
  html_url: "https://github.com/acme/widgets/issues/42",
  state: "open",
  created_at: "2026-10-27T03:00:00Z",
  updated_at: "2026-10-27T04:00:00Z",
  user: { login: "reporter" },
  labels: [{ name: "bug" }],
  assignees: [],
  comments: 12,
  reactions: { "+1": 9 },
  comments_url: "https://api.github.com/comments",
};

async function fixture(t, options = {}) {
  const folder = await mkdtemp(path.join(os.tmpdir(), "better-backlog-test-"));
  const publicDir = path.join(folder, "public");
  const cacheDir = path.join(folder, "cache");
  const settingsPath = path.join(folder, ".env");
  await writeFile(settingsPath, "BACKLOG_API_KEY='fake-test-key'\n", {
    mode: 0o600,
  });
  await mkdir(publicDir);
  await writeFile(
    path.join(publicDir, "index.html"),
    "<h1>Better Backlog</h1>",
  );
  const server = createServer({
    publicDir,
    cacheDir,
    githubLoader: async () => [issue],
    authCheck: async () => true,
    defaultRepo: "",
    settingsPath,
    environment: {},
    ...options,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(folder, { recursive: true, force: true });
  });
  const post = (route, data, headers = {}) =>
    fetch(base + route, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base, ...headers },
      body: JSON.stringify(data),
    });
  return { server, base, post, cacheDir, publicDir, settingsPath };
}

test("a complete download is cached and a failed reload preserves its timestamp and bodies", async (t) => {
  let calls = 0;
  const app = await fixture(t, {
    githubLoader: async () => {
      calls++;
      if (calls > 1) throw new Error("private upstream diagnostic");
      return [issue];
    },
  });
  const first = await (
    await fetch(app.base + "/api/issues?repo=acme/widgets")
  ).json();
  assert.equal(first.cached, false);
  assert.equal(first.issues[0].body, issue.body);
  const repeat = await (
    await fetch(app.base + "/api/issues?repo=acme/widgets")
  ).json();
  assert.equal(repeat.cached, true);
  assert.equal(calls, 1);
  const failed = await app.post("/api/reload", {
    repo: "acme/widgets",
    state: "open",
  });
  assert.equal(failed.status, 500);
  assert.ok(!(await failed.text()).includes("private upstream"));
  const retained = await (
    await fetch(app.base + "/api/issues?repo=acme/widgets")
  ).json();
  assert.equal(retained.updatedAt, first.updatedAt);
  assert.deepEqual(retained.issues, first.issues);
  const files = await readdir(app.cacheDir);
  assert.equal(files.length, 1);
  assert.ok(!files[0].endsWith(".tmp"));
});

test("requests reject cross-origin writes, DNS rebinding hosts and wrong content type", async (t) => {
  const app = await fixture(t);
  assert.equal(
    (
      await app.post(
        "/api/reload",
        { repo: "acme/widgets" },
        { Origin: "https://evil.example" },
      )
    ).status,
    403,
  );
  const badHostStatus = await new Promise((resolve, reject) => {
    const req = http.get(
      app.base + "/api/status",
      { headers: { Host: "evil.example" } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
  });
  assert.equal(badHostStatus, 403);
  assert.equal(
    (
      await app.post(
        "/api/reload",
        { repo: "acme/widgets" },
        { "Content-Type": "text/plain" },
      )
    ).status,
    415,
  );
  const page = await fetch(app.base);
  assert.equal(page.status, 200);
  assert.ok(
    page.headers
      .get("content-security-policy")
      .includes("frame-ancestors 'none'"),
  );
  assert.equal(
    (await fetch(app.base + "/.local/issues/private.json")).status,
    404,
  );
});

test("provider failures and malformed verdicts do not become false decisions or leak diagnostics", async () => {
  const args = { issue, criteria: ["A bug"], key: "fake-test-key" };
  await assert.rejects(
    evaluateIssue({
      ...args,
      fetcher: async () => new Response("secret diagnostic", { status: 401 }),
    }),
    (error) =>
      error.message.includes("API key") &&
      !error.message.includes("secret diagnostic"),
  );
  await assert.rejects(
    evaluateIssue({
      ...args,
      fetcher: async () => Response.json({ answers: {} }),
    }),
    /each criterion/,
  );
});

test("gateway discovery reports verified decision modes and leaves unknown models unclassified", async () => {
  const calls = [];
  const result = await discoverModels({
    baseUrl: "https://gateway.example.com/v1",
    key: "fake-test-key",
    fetcher: async (url) => {
      calls.push(url);
      return Response.json(
        url.endsWith("/models")
          ? { data: [{ id: "judge" }, { id: "chat" }, { id: "unknown" }] }
          : {
              data: [
                { model_name: "judge", model_info: { mode: "decisions" } },
                { model_name: "chat", model_info: { mode: "chat" } },
              ],
            },
      );
    },
  });
  assert.deepEqual(result.models, [
    { id: "judge", decision: true },
    { id: "chat", decision: false },
    { id: "unknown", decision: null },
  ]);
  assert.deepEqual(calls, [
    "https://gateway.example.com/v1/models",
    "https://gateway.example.com/model/info",
  ]);
  for (const url of [
    "https://user:pass@example.com",
    "https://example.com?key=fake",
    "http://example.com",
  ])
    assert.throws(() => normalizeBase(url));
  assert.equal(normalizeBase("http://127.0.0.1:4000"), "http://127.0.0.1:4000");
});

test("unauthenticated fallback reads every issue page and excludes pull requests", async () => {
  const urls = [];
  const result = await downloadIssues("acme/widgets", "open", {
    authenticated: async () => false,
    fetcher: async (url) => {
      urls.push(url);
      return urls.length === 1
        ? Response.json([issue, { ...issue, pull_request: {} }], {
            headers: {
              link: '<https://api.github.com/repos/acme/widgets/issues?page=2>; rel="next"',
            },
          })
        : Response.json([{ ...issue, number: 43 }]);
    },
  });
  assert.equal(result.length, 2);
  assert.equal(urls.length, 2);
  await assert.rejects(
    downloadIssues("acme/widgets", "open", {
      authenticated: async () => false,
      fetcher: async () => new Response("sensitive", { status: 403 }),
    }),
    /gh auth login/,
  );
});

test("a server restart reuses the downloaded snapshot without GitHub access", async (t) => {
  const app = await fixture(t);
  const first = await (
    await fetch(app.base + "/api/issues?repo=acme/widgets")
  ).json();
  const restarted = createServer({
    cacheDir: app.cacheDir,
    publicDir: app.publicDir,
    settingsPath: app.settingsPath,
    environment: {},
    githubLoader: async () => {
      throw new Error("Download must not run");
    },
  });
  await new Promise((resolve) => restarted.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    restarted.closeAllConnections();
    await new Promise((resolve) => restarted.close(resolve));
  });
  const response = await fetch(
    `http://127.0.0.1:${restarted.address().port}/api/issues?repo=acme/widgets`,
  );
  assert.equal(response.status, 200);
  const second = await response.json();
  assert.equal(second.cached, true);
  assert.equal(second.updatedAt, first.updatedAt);
  assert.deepEqual(second.issues, first.issues);
});

test("similarly named repositories get independent disk snapshots", async (t) => {
  const app = await fixture(t, {
    githubLoader: async (repo) => [{ ...issue, title: repo }],
  });
  await fetch(app.base + "/api/issues?repo=a--b/c");
  await fetch(app.base + "/api/issues?repo=a/b--c");
  const files = await readdir(app.cacheDir);
  assert.equal(files.length, 2);
  assert.ok(files.every((name) => /^[a-f0-9]{64}\.json$/.test(name)));
  const saved = await Promise.all(
    files.map(async (name) =>
      JSON.parse(await readFile(path.join(app.cacheDir, name), "utf8")),
    ),
  );
  assert.deepEqual(
    new Set(saved.map((data) => data.repo)),
    new Set(["a--b/c", "a/b--c"]),
  );
  for (const data of saved) assert.equal(data.issues[0].title, data.repo);
});

test("authentication and rate limits preserve statuses without upstream diagnostics", async () => {
  for (const status of [401, 403, 404, 429]) {
    await assert.rejects(
      evaluateIssue({
        issue,
        criteria: ["A bug"],
        key: "fake-test-key",
        fetcher: async () => new Response("private diagnostic", { status }),
      }),
      (error) =>
        error.status === status &&
        !error.message.includes("private diagnostic"),
    );
  }
});

test("the default repository comes from runtime configuration and is validated", async (t) => {
  const blank = await fixture(t);
  assert.equal(
    (await (await fetch(blank.base + "/api/status")).json()).defaultRepo,
    "",
  );
  const configured = await fixture(t, { defaultRepo: "acme/widgets" });
  assert.deepEqual(
    await (await fetch(configured.base + "/api/status")).json(),
    {
      githubAuthenticated: true,
      defaultRepo: "acme/widgets",
    },
  );
  assert.throws(
    () => createServer({ defaultRepo: "../../outside" }),
    /owner\/name/,
  );
});

test("metadata enrichment joins every GraphQL page and marks nested truncation", async () => {
  let args;
  const connection = (nodes, hasNextPage = false) => ({
    nodes,
    pageInfo: { hasNextPage },
  });
  const nodes = [
    {
      number: 42,
      projectsV2: connection(
        [
          {
            id: "project-1",
            title: "Roadmap",
            url: "https://github.com/orgs/acme/projects/1",
          },
        ],
        true,
      ),
      closedByPullRequestsReferences: connection([
        {
          number: 8,
          title: "Fix",
          url: "https://github.com/acme/widgets/pull/8",
          state: "OPEN",
          isDraft: false,
          merged: false,
        },
      ]),
    },
    {
      number: 43,
      projectsV2: connection([]),
      closedByPullRequestsReferences: connection([]),
    },
  ];
  const result = await enrichIssueMetadata(
    "acme/widgets",
    "all",
    [issue, { ...issue, number: 43 }],
    {
      runner: async (_command, argv) => {
        args = argv;
        return {
          stdout: JSON.stringify(
            nodes.map((node) => ({
              data: { repository: { issues: { nodes: [node] } } },
            })),
          ),
        };
      },
    },
  );
  assert.ok(args.includes("--paginate"));
  assert.ok(args.includes("--slurp"));
  assert.ok(args.some((arg) => arg.includes("after:$endCursor")));
  assert.ok(args.some((arg) => arg.includes("states:[OPEN,CLOSED]")));
  assert.equal(result[0].closedByPullRequestsReferences.nodes[0].number, 8);
  assert.deepEqual(result[0].metadata_coverage.projects, {
    available: true,
    complete: false,
  });
  assert.deepEqual(result[1].metadata_coverage.projects, {
    available: true,
    complete: true,
  });
  assert.equal(result[0].body, issue.body);
});

test("missing project permission falls back to linked pull requests and marks unavailable metadata", async () => {
  let calls = 0;
  const result = await enrichIssueMetadata("acme/widgets", "open", [issue], {
    runner: async (_command, args) => {
      calls++;
      if (calls === 1) throw new Error("private permissions diagnostic");
      assert.ok(!args.some((arg) => arg.includes("projectsV2")));
      return {
        stdout: JSON.stringify([
          {
            data: {
              repository: {
                issues: {
                  nodes: [
                    {
                      number: 42,
                      closedByPullRequestsReferences: {
                        nodes: [],
                        pageInfo: { hasNextPage: false },
                      },
                    },
                  ],
                },
              },
            },
          },
        ]),
      };
    },
  });
  assert.equal(calls, 2);
  assert.deepEqual(result[0].metadata_coverage.projects, {
    available: false,
    complete: false,
  });
  assert.deepEqual(result[0].metadata_coverage.linked_pull_requests, {
    available: true,
    complete: true,
  });
  const unavailable = await enrichIssueMetadata(
    "acme/widgets",
    "open",
    [issue],
    {
      runner: async () => {
        throw new Error("unavailable");
      },
    },
  );
  assert.equal(unavailable[0].body, issue.body);
  assert.equal(
    unavailable[0].metadata_coverage.linked_pull_requests.available,
    false,
  );
});

test("connection endpoints save locally without returning keys, and forget removes the key", async (t) => {
  const app = await fixture(t);
  const initial = await (await fetch(app.base + "/api/connection")).json();
  assert.equal(initial.hasKey, true);
  assert.equal(initial.key, undefined);
  const saved = await app.post("/api/connection", {
    provider: "jev",
    key: "fake-replacement-key",
  });
  assert.equal(saved.status, 200);
  assert.ok(!(await saved.text()).includes("fake-replacement-key"));
  const file = await readFile(app.settingsPath, "utf8");
  assert.ok(file.includes("fake-replacement-key"));
  const forgot = await fetch(app.base + "/api/connection", {
    method: "DELETE",
    headers: { Origin: app.base },
  });
  assert.equal((await forgot.json()).hasKey, false);
  assert.ok(
    !(await readFile(app.settingsPath, "utf8")).includes(
      "fake-replacement-key",
    ),
  );
});

test("gateway discovery from a saved TypeSafe connection cannot reuse or redirect its key", async (t) => {
  const requests = [];
  const app = await fixture(t, {
    modelFetcher: async (url, options) => {
      requests.push({ url, authorization: options.headers.Authorization });
      return Response.json({ data: [] });
    },
  });
  const refused = await app.post("/api/models", {
    baseUrl: "https://gateway.example",
    key: "",
  });
  assert.equal(refused.status, 400);
  assert.equal(requests.length, 0);
  const result = await app.post("/api/models", {
    baseUrl: "https://gateway.example",
    key: "fake-gateway-key",
    provider: "jev",
  });
  assert.equal(result.status, 200);
  assert.ok(requests.length > 0);
  assert.ok(
    requests.every((request) =>
      request.url.startsWith("https://gateway.example/"),
    ),
  );
  assert.ok(
    requests.every(
      (request) => request.authorization === "Bearer fake-gateway-key",
    ),
  );
});
