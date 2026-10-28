import { queryIssues, multipleOptions } from "./public/query.js";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  readFile,
  writeFile,
  mkdir,
  rename,
  realpath,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { setMaxListeners } from "node:events";
import {
  PublicError,
  evaluateIssue,
  discoverModels,
  decisionVersion,
} from "./lib/jev.mjs";
import { createSettingsStore } from "./lib/settings.mjs";

const run = promisify(execFile);
const root = path.dirname(fileURLToPath(import.meta.url));
const validRepo = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const evaluationConcurrency = 64;
const recentLimit = 12;
const contextLimit = 100;

function evaluationRateLimit(fetcher) {
  const waiting = [];
  const starts = [];
  let timer;
  function drain() {
    clearTimeout(timer);
    timer = undefined;
    while (waiting.length) {
      const now = Date.now();
      while (starts.length && starts[0] <= now - 1000) starts.shift();
      if (starts.length >= 80) {
        timer = setTimeout(drain, Math.max(1, starts[0] + 1000 - now));
        return;
      }
      const job = waiting.shift();
      job.signal.removeEventListener("abort", job.cancel);
      if (job.signal.aborted) {
        job.reject(job.signal.reason);
        continue;
      }
      starts.push(Date.now());
      try {
        Promise.resolve(fetcher(job.url, job.options)).then(
          job.resolve,
          job.reject,
        );
      } catch (error) {
        job.reject(error);
      }
    }
  }
  return (url, options) =>
    new Promise((resolve, reject) => {
      const signal = options.signal;
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const job = { url, options, signal, resolve, reject };
      job.cancel = () => {
        const index = waiting.indexOf(job);
        if (index !== -1) waiting.splice(index, 1);
        reject(signal.reason);
        if (!waiting.length) {
          clearTimeout(timer);
          timer = undefined;
        }
      };
      signal.addEventListener("abort", job.cancel, { once: true });
      waiting.push(job);
      drain();
    });
}

function evaluationPool(limit) {
  let active = 0;
  const waiting = [];
  function drain() {
    while (active < limit && waiting.length) {
      const job = waiting.shift();
      job.signal.removeEventListener("abort", job.cancel);
      if (job.signal.aborted) {
        job.reject(job.signal.reason);
        continue;
      }
      active++;
      job.resolve();
    }
  }
  return async (operation, signal) => {
    signal.throwIfAborted();
    await new Promise((resolve, reject) => {
      const job = { resolve, reject, signal };
      job.cancel = () => {
        const index = waiting.indexOf(job);
        if (index !== -1) waiting.splice(index, 1);
        reject(signal.reason);
      };
      waiting.push(job);
      signal.addEventListener("abort", job.cancel, { once: true });
      drain();
    });
    try {
      signal.throwIfAborted();
      return await operation();
    } finally {
      active--;
      drain();
    }
  };
}

function streamWriter(res) {
  let pending = Promise.resolve();
  return (event) => {
    const next = pending.then(
      () =>
        new Promise((resolve, reject) => {
          if (res.destroyed || res.writableEnded) {
            reject(new Error("Stream closed"));
            return;
          }
          if (res.write(JSON.stringify(event) + "\n")) {
            resolve();
            return;
          }
          const cleanup = () => {
            res.off("drain", drained);
            res.off("close", closed);
            res.off("error", closed);
          };
          const drained = () => {
            cleanup();
            resolve();
          };
          const closed = () => {
            cleanup();
            reject(new Error("Stream closed"));
          };
          res.once("drain", drained);
          res.once("close", closed);
          res.once("error", closed);
        }),
    );
    pending = next.catch(() => {});
    return next;
  };
}

export async function githubAuthenticated() {
  try {
    await run("gh", ["auth", "status", "--hostname", "github.com"], {
      timeout: 15000,
    });
    return true;
  } catch {
    return false;
  }
}

function metadataCoverage(node) {
  const coverage = (connection) => ({
    available: Array.isArray(connection?.nodes),
    complete:
      Array.isArray(connection?.nodes) &&
      connection.pageInfo?.hasNextPage === false,
  });
  return {
    projects: coverage(node?.projectsV2),
    linked_pull_requests: coverage(node?.closedByPullRequestsReferences),
  };
}

export async function enrichIssueMetadata(
  repo,
  state,
  issues,
  { runner = run } = {},
) {
  const [owner, name] = repo.split("/");
  const states = state === "all" ? "OPEN,CLOSED" : state.toUpperCase();
  const query = (projects) =>
    `query($owner:String!,$name:String!,$endCursor:String){repository(owner:$owner,name:$name){issues(first:100,after:$endCursor,states:[${states}],orderBy:{field:CREATED_AT,direction:DESC}){nodes{number ${projects ? "projectsV2(first:100){nodes{id title url} pageInfo{hasNextPage}}" : ""} closedByPullRequestsReferences(first:100){nodes{number title url state isDraft merged} pageInfo{hasNextPage}}}pageInfo{hasNextPage endCursor}}}}`;
  let nodes = [];
  for (const projects of [true, false]) {
    try {
      const { stdout } = await runner(
        "gh",
        [
          "api",
          "graphql",
          "--hostname",
          "github.com",
          "--paginate",
          "--slurp",
          "--raw-field",
          `query=${query(projects)}`,
          "--raw-field",
          `owner=${owner}`,
          "--raw-field",
          `name=${name}`,
        ],
        { maxBuffer: 256 * 1024 * 1024, timeout: 600000 },
      );
      const pages = JSON.parse(stdout);
      if (
        !Array.isArray(pages) ||
        pages.some(
          (page) =>
            page.errors?.length ||
            !Array.isArray(page.data?.repository?.issues?.nodes),
        )
      )
        throw new Error();
      nodes = pages.flatMap((page) => page.data.repository.issues.nodes);
      break;
    } catch {
      /* Project access is optional; try linked pull requests alone. */
    }
  }
  const metadata = new Map(nodes.map((node) => [node.number, node]));
  return issues.map((issue) => {
    const node = metadata.get(issue.number);
    return {
      ...issue,
      ...(node?.projectsV2 ? { projectsV2: node.projectsV2 } : {}),
      ...(node?.closedByPullRequestsReferences
        ? {
            closedByPullRequestsReferences: node.closedByPullRequestsReferences,
          }
        : {}),
      metadata_coverage: metadataCoverage(node),
    };
  });
}

export async function downloadIssues(
  repo,
  state,
  { authenticated = githubAuthenticated, fetcher = fetch, runner = run } = {},
) {
  const resource = `/repos/${repo}/issues?state=${state}&per_page=100&sort=created&direction=desc`;
  if (await authenticated()) {
    try {
      const { stdout } = await runner(
        "gh",
        ["api", "--hostname", "github.com", "--paginate", "--slurp", resource],
        { maxBuffer: 256 * 1024 * 1024, timeout: 600000 },
      );
      const pages = JSON.parse(stdout);
      if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page)))
        throw new Error();
      return enrichIssueMetadata(
        repo,
        state,
        pages.flat().filter((issue) => !issue.pull_request),
        { runner },
      );
    } catch {
      throw new PublicError(
        "GitHub could not download this repository. Check your GitHub CLI access, then retry. Your previous download is unchanged.",
        502,
      );
    }
  }
  const issues = [];
  let next = "https://api.github.com" + resource;
  const seen = new Set();
  while (next) {
    if (new URL(next).origin !== "https://api.github.com" || seen.has(next))
      throw new PublicError("GitHub returned an invalid page link.", 502);
    seen.add(next);
    let response;
    try {
      response = await fetcher(next, {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        redirect: "error",
        signal: AbortSignal.timeout(120000),
      });
    } catch {
      throw new PublicError(
        "GitHub could not be reached. Retry the download.",
        502,
      );
    }
    if (!response.ok)
      throw new PublicError(
        response.status === 403 || response.status === 429
          ? "GitHub limited this download. Run gh auth login in your terminal, then retry."
          : "GitHub could not read this repository. Check the repository name and access.",
        502,
      );
    let data;
    try {
      data = await response.json();
    } catch {
      throw new PublicError("GitHub returned an invalid response.", 502);
    }
    if (!Array.isArray(data))
      throw new PublicError("GitHub returned an invalid issue list.", 502);
    issues.push(...data.filter((issue) => !issue.pull_request));
    next =
      response.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ||
      null;
  }
  return issues.map((issue) => ({
    ...issue,
    metadata_coverage: metadataCoverage(),
  }));
}

function source(input) {
  const repo = String(input.repo || "").trim();
  const state = input.state || "open";
  if (!validRepo.test(repo) || !["open", "closed", "all"].includes(state))
    throw new PublicError(
      "Enter a repository as owner/name and choose open, closed, or all.",
    );
  return { repo, state };
}

function criteriaFrom(value) {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.some((rule) => typeof rule !== "string" || !rule.trim())
  )
    throw new PublicError("Add at least one text criterion.");
  const criteria = value.map((rule) => rule.trim());
  if (new Set(criteria).size !== criteria.length)
    throw new PublicError("Each criterion can appear only once.");
  return criteria;
}

function preferences(data) {
  if (data.guidance !== undefined && typeof data.guidance !== "string")
    throw new PublicError("Standing instructions must be text.");
  if (data.timeZone !== undefined) {
    try {
      if (typeof data.timeZone !== "string") throw new Error();
      new Intl.DateTimeFormat("en-US", { timeZone: data.timeZone });
    } catch {
      throw new PublicError("Choose a valid time zone.");
    }
  }
  return { guidance: data.guidance || "", timeZone: data.timeZone };
}

const filterId = (criteria) => JSON.stringify([...criteria].sort());
const combined = (verdicts) =>
  verdicts.includes("no")
    ? "no"
    : verdicts.includes("unknown")
      ? "unknown"
      : "yes";

async function readJSON(req) {
  if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json")
    throw new PublicError("Send JSON for this request.", 415);
  let length = 0;
  const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 1024 * 1024)
      throw new PublicError("This request is too large.", 413);
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || Array.isArray(value) || typeof value !== "object")
      throw new Error();
    return value;
  } catch {
    throw new PublicError("Send a valid JSON object.");
  }
}

export function createServer({
  cacheDir = path.join(root, ".local", "issues"),
  publicDir = path.join(root, "public"),
  githubLoader = downloadIssues,
  authCheck = githubAuthenticated,
  modelFetcher = fetch,
  defaultRepo = process.env.BETTER_BACKLOG_REPO || "",
  settingsPath = path.join(root, ".env"),
  environment = process.env,
} = {}) {
  const initialRepo = defaultRepo ? source({ repo: defaultRepo }).repo : "";
  const connection = createSettingsStore({ settingsPath, environment });
  const withEvaluationSlot = evaluationPool(evaluationConcurrency);
  const evaluationFetcher = evaluationRateLimit(modelFetcher);
  const snapshots = new Map();
  const downloads = new Map();
  const memories = new Map();
  const cacheFile = (repo, state) =>
    path.join(
      cacheDir,
      createHash("sha256")
        .update(JSON.stringify([repo.toLowerCase(), state]))
        .digest("hex") + ".json",
    );
  const filterFile = (repo) =>
    path.join(
      cacheDir,
      createHash("sha256")
        .update(JSON.stringify([repo.toLowerCase()]))
        .digest("hex") + ".filters.json",
    );
  async function writeAtomic(dest, text) {
    await mkdir(cacheDir, { recursive: true, mode: 0o700 });
    const temp = dest + "." + randomUUID() + ".tmp";
    try {
      await writeFile(temp, text, { mode: 0o600, flag: "wx" });
      await rename(temp, dest);
    } catch (error) {
      await unlink(temp).catch(() => {});
      throw error;
    }
  }
  // Decisions are cached per repository for the current download only; a
  // reload starts a new snapshot and every saved filter becomes stale.
  function filterMemory(repo) {
    const id = repo.toLowerCase();
    if (!memories.has(id))
      memories.set(
        id,
        (async () => {
          const file = filterFile(repo);
          let data;
          try {
            data = JSON.parse(await readFile(file, "utf8"));
            if (
              data.repo?.toLowerCase() !== id ||
              !Array.isArray(data.recent) ||
              !data.results ||
              typeof data.results !== "object"
            )
              throw new Error();
            data.recent = data.recent.filter(({ criteria } = {}) => {
              try {
                criteriaFrom(criteria);
                return true;
              } catch {
                return false;
              }
            });
          } catch {
            data = { repo, recent: [], results: {} };
          }
          let writing = null,
            dirty = false;
          const save = () => {
            dirty = true;
            writing ||= (async () => {
              while (dirty) {
                dirty = false;
                await writeAtomic(file, JSON.stringify(data)).catch(() => {});
              }
              writing = null;
            })();
            return writing;
          };
          return { data, save };
        })(),
      );
    return memories.get(id);
  }
  function stateResults(memory, state, snapshot) {
    const current = memory.data.results[state];
    if (
      current?.snapshot === snapshot.updatedAt &&
      current.decisions &&
      typeof current.decisions === "object"
    )
      return current;
    return (memory.data.results[state] = {
      snapshot: snapshot.updatedAt,
      decisions: {},
    });
  }
  const contextKey = (criterion, prefs, settings) =>
    createHash("sha256")
      .update(
        JSON.stringify([
          decisionVersion,
          criterion,
          prefs.guidance,
          prefs.timeZone || "",
          settings.provider,
          settings.baseUrl,
          settings.model,
        ]),
      )
      .digest("hex")
      .slice(0, 32);
  function recentFilters(memory, state, snapshot, prefs, settings) {
    const current = memory.data.results[state];
    const decisions =
      snapshot && current?.snapshot === snapshot.updatedAt
        ? current.decisions
        : null;
    return memory.data.recent.map(({ criteria }) => {
      const columns = decisions
        ? criteria.map(
            (criterion) => decisions[contextKey(criterion, prefs, settings)],
          )
        : [];
      const fresh =
        Boolean(decisions) &&
        columns.every(
          (column) =>
            column && snapshot.issues.every((issue) => column[issue.number]),
        );
      return {
        criteria,
        fresh,
        matches: fresh
          ? snapshot.issues.filter((issue) =>
              columns.every((column) => column[issue.number] === "yes"),
            ).length
          : null,
      };
    });
  }
  async function cached(repo, state) {
    const id = `${repo.toLowerCase()}:${state}`;
    if (snapshots.has(id)) return snapshots.get(id);
    try {
      const data = JSON.parse(await readFile(cacheFile(repo, state), "utf8"));
      if (
        data.repo?.toLowerCase() === repo.toLowerCase() &&
        data.state === state &&
        Array.isArray(data.issues) &&
        Number.isFinite(Date.parse(data.updatedAt))
      ) {
        snapshots.set(id, data);
        return data;
      }
    } catch {
      /* An absent or incomplete local snapshot needs a download. */
    }
    return null;
  }
  async function refresh(repo, state) {
    const id = `${repo.toLowerCase()}:${state}`;
    if (downloads.has(id)) return downloads.get(id);
    const pending = (async () => {
      const issues = await githubLoader(repo, state);
      if (
        !Array.isArray(issues) ||
        issues.some(
          (issue) =>
            !Number.isInteger(issue.number) ||
            typeof issue.title !== "string" ||
            !(issue.body == null || typeof issue.body === "string"),
        )
      )
        throw new PublicError("GitHub returned an invalid issue record.", 502);
      const previous = await cached(repo, state);
      const timestamp = Math.max(
        Date.now(),
        previous ? Date.parse(previous.updatedAt) + 1 : 0,
      );
      const data = {
        repo,
        state,
        issues,
        updatedAt: new Date(timestamp).toISOString(),
      };
      try {
        await writeAtomic(cacheFile(repo, state), JSON.stringify(data));
      } catch {
        throw new PublicError(
          "The issue download could not be saved. Check local disk access.",
          500,
        );
      }
      snapshots.set(id, data);
      return data;
    })();
    downloads.set(id, pending);
    try {
      return await pending;
    } finally {
      downloads.delete(id);
    }
  }
  function json(res, status, data) {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(data));
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    try {
      let address;
      try {
        address = new URL("http://" + req.headers.host);
      } catch {
        throw new PublicError("Invalid local host.", 403);
      }
      const port = server.address()?.port;
      if (
        !["localhost", "127.0.0.1", "[::1]"].includes(address.hostname) ||
        Number(address.port || 80) !== port ||
        address.username ||
        address.password
      )
        throw new PublicError("This server only accepts local requests.", 403);
      if (
        (req.headers.origin && req.headers.origin !== address.origin) ||
        req.headers["sec-fetch-site"] === "cross-site"
      )
        throw new PublicError(
          "Open Better Backlog locally to make this request.",
          403,
        );
      const url = new URL(req.url, address);
      if (url.pathname === "/api/connection") {
        if (req.method === "GET") {
          json(res, 200, await connection.public());
          return;
        }
        if (req.method === "POST") {
          json(res, 200, await connection.save(await readJSON(req)));
          return;
        }
        if (req.method === "DELETE") {
          json(res, 200, await connection.save({ forget: true }));
          return;
        }
      }
      if (req.method === "GET" && url.pathname === "/api/status") {
        json(res, 200, {
          githubAuthenticated: await authCheck(),
          defaultRepo: initialRepo,
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/issues") {
        const { repo, state } = source(Object.fromEntries(url.searchParams));
        const query = Object.fromEntries(url.searchParams);
        for (const key of multipleOptions) query[key] = url.searchParams.getAll(key);
        try { queryIssues([], query); } catch (error) { throw new PublicError(error.message); }
        const existing = await cached(repo, state);
        const snapshot = existing || await refresh(repo, state);
        json(res, 200, {
          ...snapshot,
          ...queryIssues(snapshot.issues, query),
          cached: Boolean(existing),
        });
        return;
      }
      if (req.method === "POST" && url.pathname.startsWith("/api/")) {
        const data = await readJSON(req);
        if (url.pathname === "/api/models") {
          json(
            res,
            200,
            await discoverModels({
              ...(await connection.discovery(data)),
              signal: controller.signal,
              fetcher: evaluationFetcher,
            }),
          );
          return;
        }
        const { repo, state } = source(data);
        if (url.pathname === "/api/reload") {
          json(res, 200, { ...(await refresh(repo, state)), cached: false });
          return;
        }
        if (url.pathname === "/api/filters") {
          const prefs = preferences(data);
          const memory = await filterMemory(repo);
          if (data.remove !== undefined) {
            const id = filterId(criteriaFrom(data.remove));
            memory.data.recent = memory.data.recent.filter(
              (filter) => filterId(filter.criteria) !== id,
            );
            await memory.save();
          }
          json(res, 200, {
            filters: recentFilters(
              memory,
              state,
              await cached(repo, state),
              prefs,
              await connection.read(),
            ),
          });
          return;
        }
        if (url.pathname === "/api/evaluate-batch") {
          const snapshot = await cached(repo, state);
          if (!snapshot)
            throw new PublicError(
              "Download this repository before filtering its issues.",
              404,
            );
          if (data.snapshotVersion !== snapshot.updatedAt)
            throw new PublicError(
              "The issue download changed. Reload the repository before filtering again.",
              409,
            );
          const criteria = criteriaFrom(data.criteria);
          let selected = snapshot.issues;
          if (data.numbers !== undefined) {
            if (
              !Array.isArray(data.numbers) ||
              !data.numbers.length ||
              data.numbers.some((number) => !Number.isInteger(number)) ||
              new Set(data.numbers).size !== data.numbers.length
            )
              throw new PublicError("Choose each issue to check once.");
            const issueIndex = new Map(
              snapshot.issues.map((issue) => [issue.number, issue]),
            );
            selected = data.numbers.map((number) => issueIndex.get(number));
            if (selected.some((issue) => !issue))
              throw new PublicError(
                "One of these issues is not in the downloaded repository. Reload it before filtering.",
                404,
              );
          }
          const prefs = preferences(data);
          const settings = await connection.read();
          if (settings.provider === "jev" && !settings.key)
            throw new PublicError("Enter your TypeSafe API key in Settings.");
          if (!settings.model)
            throw new PublicError("Choose a decision model in Settings.");
          controller.signal.throwIfAborted();
          const memory = await filterMemory(repo);
          const results = stateResults(memory, state, snapshot);
          const keys = criteria.map((criterion) =>
            contextKey(criterion, prefs, settings),
          );
          const columns = keys.map((key) => (results.decisions[key] ||= {}));
          const saved = Object.keys(results.decisions);
          for (const key of saved.slice(0, Math.max(0, saved.length - contextLimit)))
            if (!keys.includes(key)) delete results.decisions[key];
          memory.data.recent = [
            { criteria },
            ...memory.data.recent.filter(
              (filter) => filterId(filter.criteria) !== filterId(criteria),
            ),
          ].slice(0, recentLimit);
          memory.save();
          const batch = new AbortController();
          const signal = AbortSignal.any([controller.signal, batch.signal]);
          setMaxListeners(0, signal);
          res.writeHead(200, {
            "Content-Type": "application/x-ndjson; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no",
          });
          res.flushHeaders();
          const send = streamWriter(res);
          const result = (number) => {
            const verdicts = columns.map((column) => column[number]);
            return {
              type: "result",
              number,
              decisions: verdicts.map((verdict) => ({ verdict })),
              verdict: combined(verdicts),
            };
          };
          const jobs = [];
          for (const issue of selected) {
            const missing = columns.flatMap((column, index) =>
              column[issue.number] ? [] : [index],
            );
            if (missing.length) jobs.push({ issue, missing });
            else await send(result(issue.number));
          }
          let cursor = 0;
          let fatal = false;
          const worker = async () => {
            while (cursor < jobs.length && !signal.aborted) {
              const job = jobs[cursor++];
              try {
                const evaluation = await withEvaluationSlot(
                  () =>
                    evaluateIssue({
                      ...settings,
                      repo,
                      issue: job.issue,
                      criteria: job.missing.map((index) => criteria[index]),
                      timeZone: prefs.timeZone,
                      guidance: prefs.guidance,
                      signal,
                      fetcher: evaluationFetcher,
                    }),
                  signal,
                );
                job.missing.forEach((index, position) => {
                  columns[index][job.issue.number] =
                    evaluation.decisions[position].verdict;
                });
                memory.save();
                if (!signal.aborted) await send(result(job.issue.number));
              } catch (error) {
                if (signal.aborted) return;
                const status =
                  error instanceof PublicError ? error.status : 500;
                const message =
                  error instanceof PublicError
                    ? error.message
                    : "This issue could not be evaluated. Retry the filters.";
                if (
                  [401, 403, 404, 409, 429].includes(status) ||
                  status >= 500
                ) {
                  fatal = true;
                  batch.abort();
                }
                await send({
                  type: "error",
                  number: job.issue.number,
                  status,
                  error: message,
                });
                if (fatal) return;
              }
            }
          };
          await Promise.all(
            Array.from(
              { length: Math.min(evaluationConcurrency, jobs.length) },
              worker,
            ),
          );
          await memory.save();
          if (!controller.signal.aborted && !res.destroyed) {
            await send({ type: "done" });
            res.end();
          }
          return;
        }
      }
      if (url.pathname.startsWith("/api/"))
        throw new PublicError("This API route does not exist.", 404);
      if (req.method !== "GET" && req.method !== "HEAD")
        throw new PublicError("Method not allowed.", 405);
      let file;
      try {
        const publicRoot = await realpath(publicDir);
        file = await realpath(
          path.join(
            publicRoot,
            decodeURIComponent(
              url.pathname === "/" ? "/index.html" : url.pathname,
            ),
          ),
        );
        if (!file.startsWith(publicRoot + path.sep)) throw new Error();
      } catch {
        throw new PublicError("Page not found.", 404);
      }
      const content = await readFile(file);
      const types = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".woff2": "font/woff2",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".ico": "image/x-icon",
      };
      res.writeHead(200, {
        "Content-Type": types[path.extname(file)] || "application/octet-stream",
        "Cache-Control": "no-cache",
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      });
      res.end(req.method === "HEAD" ? undefined : content);
    } catch (error) {
      if (!res.destroyed) {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        json(res, error instanceof PublicError ? error.status : 500, {
          error:
            error instanceof PublicError
              ? error.message
              : "This request could not be completed. Retry or reload the page.",
        });
      }
    }
  });
  return server;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const port = Number(process.env.PORT || 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error("Choose a valid PORT.");
    process.exitCode = 1;
  } else {
    const server = createServer();
    server.on("error", () => {
      console.error(
        "Better Backlog could not start. Check whether its port is already in use.",
      );
      process.exitCode = 1;
    });
    server.listen(port, "127.0.0.1", () =>
      console.log(`Better Backlog is running at http://127.0.0.1:${port}`),
    );
  }
}
