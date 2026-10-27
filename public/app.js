const $ = (selector) => document.querySelector(selector);
const defaults = {
  repo: "",
  provider: "jev",
  baseUrl: "",
  hasKey: false,
  model: "",
  guidance: "",
  fetchHours: 24,
};
let settings = { ...defaults },
  connectionReady = false,
  connectionError = "";
try {
  const stored = JSON.parse(
    localStorage.getItem("better-backlog:settings") || "{}",
  );
  settings.repo = stored.repo || "";
  settings.guidance =
    typeof stored.guidance === "string" ? stored.guidance : "";
  settings.fetchHours = stored.fetchHours ?? defaults.fetchHours;
} catch {
  /* A corrupt preference must not prevent loading issues. */
}
function savePreferences(value = settings) {
  localStorage.setItem(
    "better-backlog:settings",
    JSON.stringify({
      repo: value.repo,
      guidance: value.guidance,
      fetchHours: value.fetchHours,
    }),
  );
}
function acceptConnection(value) {
  settings.provider = value.provider === "gateway" ? "gateway" : "jev";
  settings.baseUrl = typeof value.baseUrl === "string" ? value.baseUrl : "";
  settings.model = typeof value.model === "string" ? value.model : "";
  settings.hasKey = value.hasKey === true;
  connectionReady = true;
  connectionError = "";
}
async function readConnection() {
  try {
    acceptConnection(await api("/api/connection"));
  } catch (error) {
    connectionReady = false;
    connectionError =
      error.message ||
      "Could not read the saved connection. Retry saving in Settings.";
  }
}
if (
  typeof settings.repo !== "string" ||
  !/^[\w.-]+\/[\w.-]+$/.test(settings.repo)
)
  settings.repo = "";
if (
  !Number.isFinite(settings.fetchHours * 3600000) ||
  settings.fetchHours < 0.25
)
  settings.fetchHours = defaults.fetchHours;
let issues = [],
  snapshotVersion = "",
  state = "open",
  criteria = [],
  records = new Map(),
  recent = [],
  confirming = "",
  shown = new Set(),
  page = 1,
  showAll = false;
let runVersion = 0,
  loadVersion = 0,
  recentVersion = 0,
  controller,
  loadController,
  editIndex = -1,
  schedule,
  loading = false,
  retryReloadAt = 0;
const counts = {};
const pageSize = 50;
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const filterId = (list) => JSON.stringify([...list].sort());
const svg = (path, className = "", viewBox = "0 0 16 16") => {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", viewBox);
  icon.setAttribute("width", "16");
  icon.setAttribute("height", "16");
  icon.setAttribute("fill", "currentColor");
  icon.setAttribute("aria-hidden", "true");
  if (className) icon.setAttribute("class", className);
  const child = document.createElementNS("http://www.w3.org/2000/svg", "path");
  child.setAttribute("d", path);
  icon.append(child);
  return icon;
};
const openPath =
  "M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm9-3.5v4a1 1 0 0 1-2 0v-4a1 1 0 0 1 2 0ZM8 12a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z";
const closedPath =
  "M11.28 5.22a.75.75 0 0 1 0 1.06l-3.5 3.5a.75.75 0 0 1-1.06 0l-2-2a.75.75 0 0 1 1.06-1.06L7.25 8.19l2.97-2.97a.75.75 0 0 1 1.06 0ZM8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Z";
const commentPath =
  "M1.75 1A1.75 1.75 0 0 0 0 2.75v8.5C0 12.216.784 13 1.75 13H4v2.25a.75.75 0 0 0 1.28.53L8.06 13h6.19A1.75 1.75 0 0 0 16 11.25v-8.5A1.75 1.75 0 0 0 14.25 1H1.75ZM1.5 2.75a.25.25 0 0 1 .25-.25h12.5a.25.25 0 0 1 .25.25v8.5a.25.25 0 0 1-.25.25H7.75a.75.75 0 0 0-.53.22L5.5 13.44v-1.19a.75.75 0 0 0-.75-.75h-3a.25.25 0 0 1-.25-.25v-8.5Z";
function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
}
function safeIssueUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === "https://github.com" &&
      /^\/[\w.-]+\/[\w.-]+\/issues\/\d+$/.test(url.pathname)
      ? url.href
      : null;
  } catch {
    return null;
  }
}
function relativeDate(value) {
  const seconds = (Date.now() - Date.parse(value)) / 1000;
  if (!Number.isFinite(seconds)) return "at an unknown date";
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const units = [
    [31536000, "year"],
    [2592000, "month"],
    [86400, "day"],
    [3600, "hour"],
    [60, "minute"],
  ];
  for (const [size, unit] of units)
    if (Math.abs(seconds) >= size)
      return formatter.format(-Math.floor(seconds / size), unit);
  return "just now";
}
function setError(message = "") {
  $("#error").textContent = message;
  $("#error").hidden = !message;
}
function setStatus(message = "", busy = false) {
  $("#status").textContent = message;
  $("#feedback").hidden = !message;
  $("#stop").hidden = !busy;
}
function settingsStatus(message = "") {
  $("#settings-status").textContent = message;
  $("#settings-status").hidden = !message;
}
async function api(path, body, signal) {
  const response = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("The local server returned an unreadable response. Retry.");
  }
  if (!response.ok) {
    const error = new Error(result.error || "The request failed. Retry.");
    error.status = response.status;
    throw error;
  }
  return result;
}
function updateRepository() {
  $("#repository-link").hidden = !settings.repo;
  $("#repository-divider").hidden = !settings.repo;
  if (!settings.repo) {
    document.title = "Better Backlog";
    return;
  }
  const [owner, repo] = settings.repo.split("/");
  $("#repository-link").replaceChildren(
    document.createTextNode(owner || settings.repo),
    node("span", "slash", "/"),
    node("strong", "", repo || ""),
  );
  $("#repository-link").href =
    `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  document.title = `${settings.repo} issues · Better Backlog`;
}
function updateCountdown() {
  const label = $("#reload-countdown");
  if (!settings.repo) {
    label.textContent = "";
    return;
  }
  if (loading) {
    label.textContent = "Reloading…";
    return;
  }
  const target =
    retryReloadAt ||
    Date.parse(snapshotVersion) + settings.fetchHours * 3600000;
  if (!Number.isFinite(target)) {
    label.textContent = "";
    return;
  }
  const seconds = Math.max(0, Math.ceil((target - Date.now()) / 1000));
  if (!seconds && controller) {
    label.textContent = "Reloading after filters finish";
    return;
  }
  const hours = Math.floor(seconds / 3600),
    minutes = Math.floor((seconds % 3600) / 60),
    remaining = seconds % 60;
  label.textContent = `Reloading in ${hours}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`;
  if (!seconds) load(state, true);
}
function render() {
  const filtered = issues.filter(
    (issue) =>
      showAll ||
      !criteria.length ||
      records.get(issue.number)?.verdict === "yes",
  );
  const previous = shown;
  shown = new Set();
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  page = Math.min(page, pages);
  const fragment = document.createDocumentFragment();
  for (const issue of filtered.slice((page - 1) * pageSize, page * pageSize)) {
    const url = safeIssueUrl(issue.html_url);
    if (!url) continue;
    const row = node(
      "article",
      "issue" + (controller && !previous.has(issue.number) ? " arrive" : ""),
    );
    shown.add(issue.number);
    row.dataset.number = String(issue.number);
    row.append(
      svg(
        issue.state === "closed" ? closedPath : openPath,
        "issue-icon" + (issue.state === "closed" ? " closed" : ""),
      ),
    );
    const body = node("div", "issue-body"),
      head = node("div", "issue-head");
    const title = node("a", "issue-title", issue.title);
    title.href = url;
    title.target = "_blank";
    title.rel = "noreferrer";
    head.append(title);
    const labels = node("span", "labels");
    for (const value of issue.labels || []) {
      const label = typeof value === "string" ? { name: value } : value;
      const badge = node("span", "label", label.name);
      if (/^[a-fA-F0-9]{6}$/.test(label.color || "")) {
        badge.style.background = `#${label.color}20`;
        badge.style.borderColor = `#${label.color}70`;
      }
      labels.append(badge);
    }
    head.append(labels);
    const meta = node(
      "div",
      "issue-meta",
      `#${issue.number} opened ${relativeDate(issue.created_at)} by `,
    );
    const author = node(
      "span",
      "",
      issue.user?.login || issue.author || "a deleted user",
    );
    meta.append(author);
    const assignees = (issue.assignees || [])
      .map((assignee) => assignee.login)
      .filter(Boolean);
    if (assignees.length)
      meta.append(
        document.createTextNode(` · Assigned to ${assignees.join(", ")}`),
      );
    if (issue.milestone?.title)
      meta.append(document.createTextNode(` · ${issue.milestone.title}`));
    const linkedPullRequests =
      issue.closedByPullRequestsReferences?.nodes ||
      issue.closedByPullRequestsReferences ||
      [];
    if (Array.isArray(linkedPullRequests) && linkedPullRequests.length)
      meta.append(
        document.createTextNode(
          ` · ${linkedPullRequests.length}${issue.closedByPullRequestsReferences?.pageInfo?.hasNextPage ? "+" : ""} linked ${linkedPullRequests.length === 1 ? "pull request" : "pull requests"}`,
        ),
      );
    body.append(head, meta);
    row.append(body);
    if (issue.comments) {
      const comments = node("a", "comments");
      comments.href = url;
      comments.target = "_blank";
      comments.rel = "noreferrer";
      comments.setAttribute("aria-label", `${issue.comments} comments`);
      comments.append(
        svg(commentPath),
        document.createTextNode(String(issue.comments)),
      );
      row.append(comments);
    }
    fragment.append(row);
  }
  if (!filtered.length && (controller || schedule))
    fragment.append(node("div", "empty waiting"));
  else if (!filtered.length) {
    const empty = node("div", "empty");
    empty.append(
      node(
        "strong",
        "",
        criteria.length
          ? "No issues match these filters."
          : `No ${state} issues.`,
      ),
    );
    if (criteria.length)
      empty.append(
        document.createTextNode("Edit or remove a filter to see more issues."),
      );
    fragment.append(empty);
  }
  $("#issues").replaceChildren(fragment);
  $("#pagination").hidden = pages <= 1;
  $("#page-status").textContent = `${page} of ${pages}`;
  $("#previous").disabled = page === 1;
  $("#next").disabled = page === pages;
  $("#show-all").hidden = !criteria.length || !issues.length;
  $("#show-all").textContent = showAll ? "Apply filters" : "Show all";
  for (const value of ["open", "closed"]) {
    const tab = $(`#${value}-tab`);
    tab.classList.toggle("selected", value === state);
    tab.setAttribute("aria-pressed", String(value === state));
    $(`#${value}-count`).textContent =
      counts[value] == null ? "" : counts[value].toLocaleString();
  }
}
function setProgress(fraction) {
  $("#progress").hidden = fraction == null;
  $("#progress span").style.width = `${(fraction || 0) * 100}%`;
}
function stopRun() {
  runVersion++;
  controller?.abort();
  controller = null;
  clearTimeout(schedule);
  schedule = undefined;
  setProgress(null);
  $("#stop").hidden = true;
}
async function load(nextState = state, reload = false) {
  if (!settings.repo) {
    openSettings();
    return;
  }
  const version = ++loadVersion;
  loadController?.abort();
  loadController = new AbortController();
  loading = true;
  updateCountdown();
  stopRun();
  setError("");
  setStatus(reload ? "Reloading issues…" : "Loading issues…");
  $("#reload").disabled = true;
  try {
    const result = await api(
      reload
        ? "/api/reload"
        : `/api/issues?${new URLSearchParams({ repo: settings.repo, state: nextState })}`,
      reload ? { repo: settings.repo, state: nextState } : undefined,
      loadController.signal,
    );
    if (version !== loadVersion) return;
    if (!Array.isArray(result.issues))
      throw new Error("The server returned an invalid issue list.");
    issues = result.issues;
    snapshotVersion = result.updatedAt;
    retryReloadAt = 0;
    state = nextState;
    counts[state] = issues.length;
    page = 1;
    records.clear();
    const updated = new Date(result.updatedAt);
    $("#updated-at").textContent = Number.isNaN(updated.getTime())
      ? ""
      : `Updated ${updated.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
    $("#updated-at").title = Number.isNaN(updated.getTime())
      ? ""
      : updated.toLocaleString();
    updateRepository();
    render();
    setStatus("");
    refreshRecent();
    if (criteria.length) run();
  } catch (error) {
    if (version !== loadVersion || error.name === "AbortError") return;
    retryReloadAt = Date.now() + 60000;
    setStatus(
      issues.length
        ? "Showing the last loaded issues."
        : "Could not load issues.",
    );
    setError(error.message || "Could not reach the local server. Retry.");
    if (!issues.length)
      $("#issues").replaceChildren(
        node("div", "empty", "Reload to try again."),
      );
  } finally {
    if (version === loadVersion) {
      loading = false;
      $("#reload").disabled = false;
      updateCountdown();
    }
  }
}
function renderCriteria(newIndex = -1) {
  $("#criteria").replaceChildren(
    ...criteria.map((criterion, index) => {
      const chip = node("span", "chip");
      if (index !== newIndex) chip.style.animation = "none";
      const label = node("button", "chip-label", criterion);
      label.setAttribute("aria-label", `Edit filter: ${criterion}`);
      label.onclick = () => {
        editIndex = index;
        $("#criterion").value = criterion;
        $("#criterion").focus();
        $("#criterion").select();
      };
      const remove = node("button", "chip-remove", "×");
      remove.setAttribute("aria-label", `Remove filter: ${criterion}`);
      remove.onclick = () => {
        criteria.splice(index, 1);
        editIndex = -1;
        $("#criterion").value = "";
        criteriaChanged();
        $("#criterion").focus();
      };
      chip.append(label, remove);
      return chip;
    }),
  );
  $("#criterion").placeholder = criteria.length
    ? "Add another filter…"
    : "Filter these issues…";
}
function criteriaChanged(newIndex = -1, delay = 180) {
  stopRun();
  records.clear();
  page = 1;
  showAll = false;
  if (criteria.length) schedule = setTimeout(run, delay);
  renderCriteria(newIndex);
  renderRecent();
  render();
  setError("");
  $("#retry").hidden = true;
  setStatus(criteria.length ? "Ready to check issues." : "");
}
async function refreshRecent(remove) {
  if (!settings.repo) return;
  const version = ++recentVersion;
  try {
    const result = await api("/api/filters", {
      repo: settings.repo,
      state,
      guidance: settings.guidance,
      timeZone,
      ...(remove ? { remove } : {}),
    });
    if (version !== recentVersion || !Array.isArray(result.filters)) return;
    recent = result.filters;
  } catch {
    /* Filtering works without the recent list; the next run refreshes it. */
    return;
  }
  renderRecent();
}
function renderRecent() {
  const active = criteria.length ? filterId(criteria) : "";
  const before = new Set(
    [...$("#recent-list").children].map((item) => item.dataset.id),
  );
  $("#recent").hidden = !recent.length;
  $("#recent-list").replaceChildren(
    ...recent.map((filter) => {
      const id = filterId(filter.criteria);
      const current = id === active;
      const item = node(
        "li",
        "recent-item" +
          (current ? " active" : "") +
          (before.has(id) ? "" : " arrive"),
      );
      item.dataset.id = id;
      const apply = node("button", "recent-apply" + (filter.fresh ? " fresh" : ""));
      const dot = node(
        "span",
        "freshness" +
          (current && controller ? " running" : filter.fresh ? " fresh" : ""),
      );
      dot.title = filter.fresh ? "Fresh" : "Stale";
      apply.append(dot, node("span", "recent-text", filter.criteria.join(" · ")));
      if (filter.fresh)
        apply.append(node("span", "counter", filter.matches.toLocaleString()));
      apply.setAttribute(
        "aria-label",
        `${filter.criteria.join(", ")} · ${filter.fresh ? `fresh, ${filter.matches} matching` : "stale"}`,
      );
      if (current) apply.setAttribute("aria-current", "true");
      apply.onclick = () => {
        criteria = [...filter.criteria];
        editIndex = -1;
        $("#criterion").value = "";
        criteriaChanged(-1, 0);
      };
      const sure = confirming === id;
      const remove = node(
        "button",
        "recent-remove" + (sure ? " confirm" : ""),
        sure ? "Remove" : "×",
      );
      remove.setAttribute(
        "aria-label",
        `${sure ? "Confirm removing" : "Remove"} ${filter.criteria.join(", ")}`,
      );
      remove.onclick = () => {
        if (!sure) {
          confirming = id;
          renderRecent();
          $("#recent-list .recent-remove.confirm")?.focus();
          return;
        }
        confirming = "";
        recent = recent.filter((other) => filterId(other.criteria) !== id);
        if (filterId(criteria) === id) {
          criteria = [];
          editIndex = -1;
          $("#criterion").value = "";
          criteriaChanged();
        } else renderRecent();
        refreshRecent(filter.criteria);
      };
      item.append(apply, remove);
      return item;
    }),
  );
}
const configured = () =>
  connectionReady &&
  (settings.provider === "jev"
    ? settings.hasKey
    : Boolean(settings.baseUrl && settings.model));
async function run(numbers) {
  stopRun();
  if (!criteria.length) return;
  if (!configured()) {
    openSettings();
    setStatus(connectionError || "Add your connection to apply these filters.");
    return;
  }
  if (!issues.length) {
    setStatus("No issues to check.");
    return;
  }
  const version = runVersion,
    runCriteria = [...criteria],
    runIssues = [...issues],
    total = runIssues.length.toLocaleString();
  const runController = new AbortController();
  controller = runController;
  const { signal } = runController;
  if (!numbers) records.clear();
  const requested = new Set(
    numbers || runIssues.map((issue) => issue.number),
  );
  const completed = new Set();
  let checked = runIssues.length - requested.size,
    failureMessage = "",
    renderTimer,
    reader;
  const combined = (decisions) =>
    decisions.some((decision) => decision.verdict === "no")
      ? "no"
      : decisions.some((decision) => decision.verdict === "unknown")
        ? "unknown"
        : "yes";
  const matching = () =>
    [...records.values()].filter((record) => record.verdict === "yes").length;
  const progress = () => {
    renderTimer = undefined;
    if (version !== runVersion) return;
    setStatus(
      `Checking ${checked.toLocaleString()} of ${total} issues · ${matching().toLocaleString()} match`,
      true,
    );
    setProgress(checked / runIssues.length);
    render();
  };
  const queueRender = () => {
    if (!renderTimer) renderTimer = setTimeout(progress, 100);
  };
  $("#retry").hidden = true;
  setError("");
  renderRecent();
  progress();
  try {
    const response = await fetch("/api/evaluate-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        repo: settings.repo,
        state,
        snapshotVersion,
        timeZone,
        guidance: settings.guidance,
        criteria: runCriteria,
        ...(numbers ? { numbers } : {}),
      }),
    });
    if (version !== runVersion) return;
    if (!response.ok) {
      let body;
      try {
        body = await response.json();
      } catch {
        /* Never display raw server response bodies. */
      }
      throw new Error(
        typeof body?.error === "string"
          ? body.error
          : "Could not start filtering. Retry.",
      );
    }
    if (!response.body)
      throw new Error("The server returned no results stream. Retry.");
    refreshRecent();
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "",
      sawDone = false;
    const acceptLine = (line) => {
      if (!line.trim()) return;
      if (sawDone)
        throw new Error("The results stream continued after completion. Retry.");
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        throw new Error("The results stream was unreadable. Retry.");
      }
      if (!event || typeof event !== "object")
        throw new Error("The results stream was unreadable. Retry.");
      if (event.type === "done") {
        if (completed.size !== requested.size)
          throw new Error(
            "Some issue results were not returned. Retry to finish checking them.",
          );
        sawDone = true;
        return;
      }
      if (!["result", "error"].includes(event.type))
        throw new Error(
          "The results stream contained an unexpected event. Retry.",
        );
      if (event.type === "error" && event.number == null)
        throw new Error(
          typeof event.error === "string"
            ? event.error
            : "Filtering stopped before completion. Retry.",
        );
      if (!requested.has(event.number) || completed.has(event.number))
        throw new Error(
          "The results stream contained an unexpected or duplicate issue. Retry.",
        );
      completed.add(event.number);
      if (event.type === "error") {
        failureMessage ||=
          typeof event.error === "string"
            ? event.error
            : "An issue could not be checked. Retry.";
        queueRender();
        if (
          !Number.isInteger(event.status) ||
          event.status >= 500 ||
          [401, 403, 404, 409, 429].includes(event.status)
        )
          throw new Error(failureMessage);
        return;
      }
      if (
        !Array.isArray(event.decisions) ||
        event.decisions.length !== runCriteria.length ||
        event.decisions.some(
          (decision) =>
            !decision || !["yes", "no", "unknown"].includes(decision.verdict),
        ) ||
        !["yes", "no", "unknown"].includes(event.verdict) ||
        combined(event.decisions) !== event.verdict
      )
        throw new Error(
          "The model returned an incomplete or inconsistent decision. Retry.",
        );
      records.set(event.number, {
        decisions: event.decisions,
        verdict: event.verdict,
      });
      checked++;
      queueRender();
    };
    while (true) {
      const chunk = await reader.read();
      if (version !== runVersion || signal.aborted) return;
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        acceptLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
      if (chunk.done) {
        if (buffer.trim()) acceptLine(buffer);
        break;
      }
    }
    if (!sawDone)
      throw new Error(
        "The results stream ended early. Retry to finish checking the remaining issues.",
      );
  } catch (error) {
    if (version !== runVersion) return;
    failureMessage =
      error.message || "Could not reach the local server. Retry.";
    runController.abort();
  } finally {
    clearTimeout(renderTimer);
    if (reader) {
      try {
        await reader.cancel();
      } catch {
        /* The fetch may already be aborted. */
      }
      reader.releaseLock();
    }
    if (version === runVersion) {
      controller = null;
      setProgress(null);
    }
  }
  if (version !== runVersion) return;
  const unchecked = runIssues.filter(
    (issue) => !records.has(issue.number),
  ).length;
  const unclear = runIssues.filter(
    (issue) => records.get(issue.number)?.verdict === "unknown",
  ).length;
  setStatus(
    `${matching().toLocaleString()} of ${total} issues${unchecked ? ` · ${unchecked.toLocaleString()} pending` : ""}${unclear ? ` · ${unclear.toLocaleString()} unclear` : ""}`,
  );
  setError(failureMessage);
  $("#retry").hidden = !unchecked;
  render();
  renderRecent();
  refreshRecent();
}
function providerVisibility() {
  const direct = $("#provider").value === "jev";
  $("#gateway-url").hidden = direct;
  $("#gateway-model").hidden = direct;
  $("#api-key-label").textContent = direct
    ? "API key"
    : "Virtual key / API key";
}
function openSettings() {
  $("#repository").value = settings.repo;
  $("#provider").value = settings.provider;
  $("#base-url").value = settings.baseUrl;
  $("#api-key").value = "";
  $("#api-key").placeholder = settings.hasKey
    ? "Saved · leave blank to keep"
    : "Paste your key";
  $("#model").replaceChildren(new Option("Choose a decision model", ""));
  if (settings.model)
    $("#model").add(new Option(settings.model, settings.model));
  $("#model").value = settings.model;
  $("#guidance").value = settings.guidance;
  $("#fetch-hours").value = settings.fetchHours;
  settingsStatus(connectionError);
  providerVisibility();
  if (!$("#settings").open) $("#settings").showModal();
  if (!settings.hasKey) $("#api-key").focus();
}
$("#criterion-form").onsubmit = (event) => {
  event.preventDefault();
  const value = $("#criterion").value.trim();
  if (!value) return;
  if (criteria.includes(value) && criteria[editIndex] !== value) {
    editIndex = -1;
    $("#criterion").value = "";
    return;
  }
  const index = editIndex < 0 ? criteria.length : editIndex;
  if (editIndex < 0) criteria.push(value);
  else criteria[editIndex] = value;
  editIndex = -1;
  $("#criterion").value = "";
  criteriaChanged(index);
};
$("#criterion").onkeydown = (event) => {
  if (
    event.key === "Backspace" &&
    !event.currentTarget.value &&
    criteria.length
  ) {
    event.preventDefault();
    editIndex = criteria.length - 1;
    event.currentTarget.value = criteria[editIndex];
    event.currentTarget.select();
  } else if (event.key === "Escape") {
    editIndex = -1;
    event.currentTarget.value = "";
  }
};
function cancelRemoval(event) {
  if (
    !confirming ||
    (event.type === "keydown" && event.key !== "Escape") ||
    (event.type === "pointerdown" && event.target.closest?.(".confirm"))
  )
    return;
  confirming = "";
  renderRecent();
}
document.addEventListener("keydown", cancelRemoval);
document.addEventListener("pointerdown", cancelRemoval);
$("#settings-toggle").onclick = openSettings;
$("#settings-close").onclick = () => $("#settings").close();
$("#provider").onchange = () => {
  providerVisibility();
  $("#api-key").value = "";
  $("#api-key").placeholder =
    $("#provider").value === settings.provider && settings.hasKey
      ? "Saved · leave blank to keep"
      : "Paste your key";
  $("#base-url").value =
    $("#provider").value === settings.provider ? settings.baseUrl : "";
  $("#model").replaceChildren(new Option("Choose a decision model", ""));
  if ($("#provider").value === settings.provider && settings.model) {
    $("#model").add(new Option(settings.model, settings.model));
    $("#model").value = settings.model;
  }
  settingsStatus("");
};
$("#load-models").onclick = async () => {
  const button = $("#load-models");
  button.disabled = true;
  settingsStatus("Loading models…");
  try {
    const baseUrl = $("#base-url").value.trim();
    const key = $("#api-key").value.trim();
    const result = await api("/api/models", {
      baseUrl,
      key,
    });
    if (
      !$("#settings").open ||
      $("#provider").value !== "gateway" ||
      $("#base-url").value.trim() !== baseUrl
    )
      return;
    const available = result.models.filter((model) => model.decision !== false);
    $("#model").replaceChildren(new Option("Choose a decision model", ""));
    for (const model of available)
      $("#model").add(new Option(model.label || model.id, model.id));
    const confirmed = available.filter((model) => model.decision === true);
    if (confirmed.length === 1) $("#model").value = confirmed[0].id;
    else if (available.some((model) => model.id === settings.model))
      $("#model").value = settings.model;
    settingsStatus(
      available.length
        ? confirmed.length
          ? ""
          : "Choose a model that supports decisions."
        : "No decision models found on this gateway.",
    );
  } catch (error) {
    settingsStatus(error.message);
  } finally {
    button.disabled = false;
  }
};
$("#settings-form").onsubmit = async (event) => {
  event.preventDefault();
  const form = Object.fromEntries(new FormData(event.currentTarget));
  const repo = form.repo
    .trim()
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/\/$/, "");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    settingsStatus("Enter a repository as owner/name.");
    return;
  }
  const next = {
    ...settings,
    repo,
    provider: form.provider,
    baseUrl: form.baseUrl.trim(),
    model: form.model,
    guidance: form.guidance,
    fetchHours: Number(form.fetchHours),
  };
  if (!Number.isFinite(next.fetchHours * 3600000) || next.fetchHours < 0.25) {
    settingsStatus("Enter a reload interval of at least 0.25 hours.");
    return;
  }
  if (next.provider === "jev") {
    next.baseUrl = "https://api.typesafe.ai";
    next.model = "jev-latest";
  }
  if (next.provider === "gateway" && (!next.baseUrl || !next.model)) {
    settingsStatus("Enter your gateway URL and load its decision models.");
    return;
  }
  const key = form.key.trim();
  const changedRepo = settings.repo !== next.repo;
  const changedConnection =
    !connectionReady ||
    Boolean(key) ||
    ["provider", "baseUrl", "model"].some(
      (name) => settings[name] !== next[name],
    );
  const changedGuidance = settings.guidance !== next.guidance;
  const saveButton = event.currentTarget.querySelector('[type="submit"]');
  saveButton.disabled = true;
  try {
    if (changedRepo || changedConnection || changedGuidance) stopRun();
    if (changedConnection) {
      const saved = await api("/api/connection", {
        provider: next.provider,
        baseUrl: next.baseUrl,
        model: next.model,
        ...(key ? { key } : {}),
      });
      acceptConnection(saved);
      next.provider = settings.provider;
      next.baseUrl = settings.baseUrl;
      next.model = settings.model;
      next.hasKey = settings.hasKey;
    }
    savePreferences(next);
    settings = next;
    $("#api-key").value = "";
    $("#settings").close();
    if (changedRepo) {
      snapshotVersion = "";
      retryReloadAt = 0;
      issues = [];
      records.clear();
      delete counts.open;
      delete counts.closed;
      criteria = [];
      renderCriteria();
      updateRepository();
      render();
      load("open");
    } else if (changedConnection || changedGuidance) {
      if (criteria.length) run();
      else refreshRecent();
    }
    updateCountdown();
  } catch (error) {
    settingsStatus(error.message || "Could not save settings. Retry.");
  } finally {
    saveButton.disabled = false;
  }
};
$("#guidance-file").onchange = async () => {
  const file = $("#guidance-file").files[0];
  if (file) $("#guidance").value = await file.text();
};
$("#forget").onclick = async () => {
  stopRun();
  const button = $("#forget");
  button.disabled = true;
  try {
    acceptConnection(await api("/api/connection", { forget: true }));
    records.clear();
    criteria = [];
    renderCriteria();
    render();
    setStatus("");
    setError("");
    $("#retry").hidden = true;
    $("#api-key").value = "";
    openSettings();
    settingsStatus("Saved connection removed.");
  } catch (error) {
    settingsStatus(
      error.message || "Could not remove the saved connection. Retry.",
    );
  } finally {
    button.disabled = false;
  }
};
$("#reload").onclick = () => load(state, true);
for (const tab of document.querySelectorAll("[data-state]"))
  tab.onclick = () => {
    if (tab.dataset.state !== state) load(tab.dataset.state);
  };
$("#stop").onclick = () => {
  stopRun();
  setStatus(
    `Stopped · ${records.size.toLocaleString()} of ${issues.length.toLocaleString()} issues checked`,
  );
  $("#retry").hidden = false;
  renderRecent();
  render();
};
$("#retry").onclick = () => {
  const unchecked = issues
    .filter((issue) => !records.has(issue.number))
    .map((issue) => issue.number);
  run(records.size && unchecked.length ? unchecked : undefined);
};
$("#show-all").onclick = () => {
  showAll = !showAll;
  page = 1;
  render();
};
$("#previous").onclick = () => {
  page--;
  render();
  $(".issue-list").scrollIntoView({ block: "start" });
};
$("#next").onclick = () => {
  page++;
  render();
  $(".issue-list").scrollIntoView({ block: "start" });
};
window.addEventListener("pagehide", () => {
  stopRun();
  loadController?.abort();
  clearInterval(reloadTimer);
});
const reloadTimer = setInterval(updateCountdown, 1000);
async function start() {
  const connectionLoad = readConnection();
  if (!settings.repo) {
    try {
      const status = await api("/api/status");
      if (
        typeof status.defaultRepo === "string" &&
        /^[\w.-]+\/[\w.-]+$/.test(status.defaultRepo)
      )
        settings.repo = status.defaultRepo;
    } catch (error) {
      setError(error.message);
    }
  }
  await connectionLoad;
  updateRepository();
  if (settings.repo) load();
  else {
    const empty = node("div", "empty");
    const choose = node("button", "text-button", "Choose a repository");
    choose.onclick = openSettings;
    empty.append(choose);
    $("#issues").replaceChildren(empty);
    $("#criterion").placeholder = "Choose a repository to begin";
  }
}
start();
