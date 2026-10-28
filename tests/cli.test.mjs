import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "../server.mjs";

const run = promisify(execFile);
const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.mjs");

test("the CLI filters, lists recent filters and forgets them through the running app", { timeout: 20000 }, async (t) => {
  const folder = await mkdtemp(path.join(tmpdir(), "better-backlog-cli-test-"));
  const settingsPath = path.join(folder, ".env");
  await writeFile(settingsPath, "BACKLOG_API_KEY='fake-test-key'\n", { mode: 0o600 });
  let calls = 0;
  const server = createServer({
    cacheDir: path.join(folder, "cache"),
    settingsPath,
    environment: {},
    defaultRepo: "acme/widgets",
    authCheck: async () => true,
    githubLoader: async () =>
      [1, 2, 3].map((number) => ({
        number,
        title: `Fictional issue ${number}`,
        body: "Body",
        html_url: `https://github.com/acme/widgets/issues/${number}`,
        state: "open",
        created_at: "2026-10-01T00:00:00Z",
        updated_at: "2026-10-01T00:00:00Z",
        labels: [{ name: "bug" }],
      })),
    modelFetcher: async (_url, options) => {
      calls++;
      const body = JSON.parse(options.body);
      const { number } = JSON.parse(body.state).issue;
      return Response.json({
        answers: { rule_0: { choice: number === 2 ? "yes" : number === 3 ? "unknown" : "no" } },
      });
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(folder, { recursive: true, force: true });
  });
  const env = { ...process.env, BETTER_BACKLOG_URL: `http://127.0.0.1:${server.address().port}` };
  delete env.BETTER_BACKLOG_REPO;
  const backlog = (...args) => run(process.execPath, [cli, ...args], { env });

  const filtered = JSON.parse((await backlog("filter", "Describes a bug", "--json")).stdout);
  assert.deepEqual(filtered.matches.map((issue) => issue.number), [2]);
  assert.deepEqual(filtered.matches[0].labels, ["bug"]);
  assert.deepEqual(filtered.unclear, [3]);
  assert.equal(filtered.total, 3);
  const text = await backlog("filter", "Describes a bug");
  assert.equal(text.stdout, "#2\tFictional issue 2\thttps://github.com/acme/widgets/issues/2\n");
  assert.match(text.stderr, /1 of 3 issues · 1 unclear/);
  assert.equal(calls, 3);

  const exact = JSON.parse((await backlog("issues", "--label", "bug", "--created-after", "2026-10-01", "--sort", "reactions", "--limit", "2", "--json")).stdout);
  assert.deepEqual(exact.issues.map(i => i.number), [3, 2]);
  assert.equal(exact.matched, 3);
  assert.equal(calls, 3, "exact queries never call the model");
  const apiExact = await fetch(`${env.BETTER_BACKLOG_URL}/api/issues?repo=acme/widgets&label=bug&sort=comments&limit=1`);
  assert.deepEqual((await apiExact.json()).issues.map(i => i.number), [3]);
  const invalid = await fetch(`${env.BETTER_BACKLOG_URL}/api/issues?repo=acme/widgets&created-after=invalid`);
  assert.equal(invalid.status, 400);

  assert.match((await backlog("recent")).stdout, /● +1 {2}Describes a bug/);
  assert.deepEqual(JSON.parse((await backlog("forget", "Describes a bug", "--json")).stdout), []);
  await assert.rejects(backlog("filter"), (error) => /Add at least one criterion/.test(error.stderr));
});
