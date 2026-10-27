import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import { parseEnv } from "node:util";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { PublicError, normalizeBase } from "./jev.mjs";

const names = [
  "BACKLOG_PROVIDER",
  "BACKLOG_BASE_URL",
  "BACKLOG_MODEL",
  "BACKLOG_API_KEY",
];
const defaults = {
  provider: "jev",
  baseUrl: "https://api.typesafe.ai",
  model: "jev-latest",
  key: "",
};

function normalize(connection) {
  const provider =
    connection.provider === "typesafe" ? "jev" : connection.provider || "jev";
  if (!["jev", "gateway"].includes(provider))
    throw new PublicError("Choose TypeSafe or a gateway in Settings.");
  const key = String(connection.key || "").trim();
  if (/[\r\n\0]/.test(key))
    throw new PublicError("Enter an API key on one line.");
  if (provider === "jev") return { ...defaults, key };
  const baseUrl = normalizeBase(connection.baseUrl);
  const model = String(connection.model || "").trim();
  if (/[\r\n\0]/.test(model))
    throw new PublicError("Enter a model name on one line.");
  return { provider, baseUrl, model, key };
}

const sameDestination = (a, b) =>
  a.provider === b.provider &&
  a.baseUrl.replace(/\/v1$/, "") === b.baseUrl.replace(/\/v1$/, "");
const localGateway = (config) =>
  config.provider === "gateway" &&
  ["localhost", "127.0.0.1", "[::1]"].includes(
    new URL(config.baseUrl).hostname,
  );
const safe = ({ provider, baseUrl, model, key }) => ({
  provider,
  baseUrl,
  model,
  hasKey: Boolean(key),
});

function withoutConnection(text) {
  const lines = text.split(/\r?\n/);
  const kept = [];
  for (let index = 0; index < lines.length; index++) {
    const first = index;
    const assignment = lines[index].match(
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/,
    );
    if (assignment && ["'", '"', "`"].includes(assignment[2][0])) {
      const quote = assignment[2][0];
      if (!assignment[2].slice(1).includes(quote)) {
        do {
          index++;
        } while (index < lines.length && !lines[index].includes(quote));
        if (index === lines.length)
          throw new PublicError(
            "The local .env has an unfinished quoted value. Fix it before saving.",
          );
      }
    }
    if (!assignment || !names.includes(assignment[1]))
      kept.push(...lines.slice(first, index + 1));
  }
  return kept.join("\n").replace(/\n*$/, "");
}

function quote(value) {
  for (const mark of ["'", "`", '"']) {
    if (!value.includes(mark) && (mark !== '"' || !value.includes("\\")))
      return mark + value + mark;
  }
  throw new PublicError(
    "This connection value contains unsupported quoting characters.",
  );
}

export function createSettingsStore({
  settingsPath,
  environment = process.env,
}) {
  let queue = Promise.resolve();
  async function load() {
    let text = "";
    try {
      text = await readFile(settingsPath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT")
        throw new PublicError(
          "The local connection settings could not be read.",
          500,
        );
    }
    let values;
    try {
      values = parseEnv(text);
    } catch {
      throw new PublicError(
        "The local .env could not be read. Check its format.",
        500,
      );
    }
    const managed = names.some((name) => Object.hasOwn(environment, name));
    for (const name of names)
      if (Object.hasOwn(environment, name)) values[name] = environment[name];
    const config = normalize({
      provider: values.BACKLOG_PROVIDER,
      baseUrl: values.BACKLOG_BASE_URL,
      model: values.BACKLOG_MODEL,
      key: values.BACKLOG_API_KEY,
    });
    return { text, config, managed };
  }
  async function write(text) {
    const temp = settingsPath + "." + randomUUID() + ".tmp";
    try {
      await mkdir(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
      await writeFile(temp, text, { flag: "wx", mode: 0o600 });
      await rename(temp, settingsPath);
    } catch {
      await unlink(temp).catch(() => {});
      throw new PublicError(
        "The local connection settings could not be saved. Check file access.",
        500,
      );
    }
  }
  function serial(action) {
    const result = queue.then(action);
    queue = result.catch(() => {});
    return result;
  }
  async function save(input) {
    return serial(async () => {
      const current = await load();
      if (input.forget === true) {
        if (current.managed)
          throw new PublicError(
            "This connection is managed by environment variables. Remove those variables and restart to forget it.",
            409,
          );
        const remaining = withoutConnection(current.text);
        await write(remaining ? remaining + "\n" : "");
        return safe(defaults);
      }
      const next = normalize({ ...current.config, ...input, key: "" });
      const enteredKey = typeof input.key === "string" ? input.key.trim() : "";
      next.key =
        enteredKey ||
        (sameDestination(current.config, next) ? current.config.key : "");
      if (/[\r\n\0]/.test(next.key))
        throw new PublicError("Enter an API key on one line.");
      if (
        current.managed &&
        JSON.stringify(next) !== JSON.stringify(current.config)
      )
        throw new PublicError(
          "This connection is managed by environment variables. Update those variables and restart to change it.",
          409,
        );
      if (!next.key && !localGateway(next))
        throw new PublicError("Enter an API key for this connection.");
      if (next.provider === "gateway" && !next.model)
        throw new PublicError("Choose a decision model.");
      if (current.managed) {
        return safe(current.config);
      }
      const values = {
        BACKLOG_PROVIDER: next.provider,
        BACKLOG_BASE_URL: next.baseUrl,
        BACKLOG_MODEL: next.model,
        BACKLOG_API_KEY: next.key,
      };
      const remaining = withoutConnection(current.text);
      await write(
        (remaining ? remaining + "\n" : "") +
          names.map((name) => `${name}=${quote(values[name])}`).join("\n") +
          "\n",
      );
      return safe(next);
    });
  }
  return {
    read: async () => (await load()).config,
    public: async () => safe((await load()).config),
    save,
    discovery: async (input) => {
      const current = (await load()).config;
      const next = normalize({
        ...current,
        ...input,
        provider: "gateway",
        key: "",
      });
      next.key =
        typeof input.key === "string" && input.key.trim()
          ? input.key.trim()
          : sameDestination(current, next)
            ? current.key
            : "";
      if (!next.key && !localGateway(next))
        throw new PublicError("Enter an API key for this connection.");
      return next;
    },
  };
}
