#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { createServer } from "./server.mjs";

const usage = `Usage: node cli.mjs <command> [options]

Commands:
  filter <criterion>...   Issues matching every criterion
  recent                  Recent filters: ● fresh, ○ stale
  forget <criterion>...   Remove a recent filter
  issues                  All downloaded issues
  reload                  Download issues again

Options:
  --repo owner/name       Repository (default: BETTER_BACKLOG_REPO)
  --state open|closed     Issue state (default: open)
  --instructions <file>   Standing instructions, such as AGENTS.md
  --json                  Machine-readable output
`;

let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      state: { type: "string", default: "open" },
      instructions: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
} catch (error) {
  console.error(error.message + "\n\n" + usage);
  process.exit(2);
}
const { values: options, positionals } = args;
const [command, ...criteria] = positionals;
if (options.help || !command) {
  console.log(usage);
  process.exit(command || options.help ? 0 : 2);
}

// Prefer the running app so the website and the CLI share one cache and one
// list of recent filters; otherwise run the same server for this command.
async function connect() {
  const base =
    process.env.BETTER_BACKLOG_URL ||
    `http://127.0.0.1:${process.env.PORT || 4317}`;
  try {
    const response = await fetch(base + "/api/status", {
      signal: AbortSignal.timeout(20000),
    });
    const status = await response.json();
    if (response.ok && "githubAuthenticated" in status)
      return { base, status, close() {} };
  } catch {
    /* No app is running; start one below. */
  }
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const local = `http://127.0.0.1:${server.address().port}`;
  const status = await (await fetch(local + "/api/status")).json();
  return {
    base: local,
    status,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

const app = await connect();
const request = (path, body) =>
  fetch(app.base + path, {
    method: body ? "POST" : "GET",
    headers: body
      ? { "Content-Type": "application/json", Origin: app.base }
      : {},
    body: body ? JSON.stringify(body) : undefined,
  });
async function call(path, body) {
  const response = await request(path, body);
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

const repo =
  options.repo || process.env.BETTER_BACKLOG_REPO || app.status.defaultRepo;
const state = options.state;
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const print = (value) =>
  console.log(options.json ? JSON.stringify(value, null, 2) : value);
const brief = (issue) => ({
  number: issue.number,
  title: issue.title,
  url: issue.html_url,
  labels: (issue.labels || []).map((label) => label.name ?? label),
  created_at: issue.created_at,
  comments: issue.comments,
});
const line = (issue) => `#${issue.number}\t${issue.title}\t${issue.html_url}`;

async function filter() {
  const snapshot = await call(
    `/api/issues?${new URLSearchParams({ repo, state })}`,
  );
  const response = await request("/api/evaluate-batch", {
    repo,
    state,
    snapshotVersion: snapshot.updatedAt,
    timeZone,
    guidance,
    criteria,
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${response.status}).`);
  }
  const verdicts = new Map();
  let failure = "",
    buffer = "";
  const decoder = new TextDecoder();
  const progress = () => {
    if (!process.stderr.isTTY) return;
    const matched = [...verdicts.values()].filter((v) => v === "yes").length;
    process.stderr.write(
      `\rChecking ${verdicts.size} of ${snapshot.issues.length} · ${matched} match`,
    );
  };
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const event = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (event.type === "result") verdicts.set(event.number, event.verdict);
      if (event.type === "error") failure ||= event.error;
    }
    progress();
  }
  if (process.stderr.isTTY) process.stderr.write("\r\x1b[K");
  if (failure) throw new Error(failure);
  const matches = snapshot.issues.filter(
    (issue) => verdicts.get(issue.number) === "yes",
  );
  const unclear = snapshot.issues
    .filter((issue) => verdicts.get(issue.number) === "unknown")
    .map((issue) => issue.number);
  if (options.json)
    print({
      repo,
      state,
      criteria,
      total: snapshot.issues.length,
      matches: matches.map(brief),
      unclear,
    });
  else {
    for (const issue of matches) console.log(line(issue));
    console.error(
      `${matches.length.toLocaleString()} of ${snapshot.issues.length.toLocaleString()} issues` +
        (unclear.length ? ` · ${unclear.length.toLocaleString()} unclear` : ""),
    );
  }
}

async function recent(remove) {
  const { filters } = await call("/api/filters", {
    repo,
    state,
    timeZone,
    guidance,
    ...(remove ? { remove } : {}),
  });
  if (options.json) return print(filters);
  for (const item of filters)
    console.log(
      `${item.fresh ? "●" : "○"} ${item.fresh ? String(item.matches).padStart(5) : "     "}  ${item.criteria.join(" · ")}`,
    );
}

let guidance = "";
try {
  if (!repo)
    throw new Error("Choose a repository with --repo owner/name.");
  if (!["open", "closed"].includes(state))
    throw new Error("Choose --state open or --state closed.");
  if (options.instructions)
    guidance = await readFile(options.instructions, "utf8");
  if (command === "filter") {
    if (!criteria.length) throw new Error("Add at least one criterion.");
    await filter();
  } else if (command === "recent") await recent();
  else if (command === "forget") {
    if (!criteria.length) throw new Error("Name the filter to forget.");
    await recent(criteria);
  } else if (command === "issues" || command === "reload") {
    const result =
      command === "reload"
        ? await call("/api/reload", { repo, state })
        : await call(`/api/issues?${new URLSearchParams({ repo, state })}`);
    if (options.json)
      print({
        repo,
        state,
        updatedAt: result.updatedAt,
        issues: result.issues.map(brief),
      });
    else {
      if (command === "issues") for (const issue of result.issues) console.log(line(issue));
      console.error(
        `${result.issues.length.toLocaleString()} ${state} issues · updated ${new Date(result.updatedAt).toLocaleString()}`,
      );
    }
  } else throw new Error(`Unknown command: ${command}\n\n${usage}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  app.close();
}
