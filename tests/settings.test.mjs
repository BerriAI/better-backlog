import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, stat, rm } from "node:fs/promises";
import { parseEnv } from "node:util";
import os from "node:os";
import path from "node:path";
import { createSettingsStore } from "../lib/settings.mjs";

async function store(t, environment = {}) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "backlog-settings-test-"),
  );
  const settingsPath = path.join(directory, ".env");
  t.after(() => rm(directory, { recursive: true, force: true }));
  return {
    settingsPath,
    settings: createSettingsStore({ settingsPath, environment }),
  };
}

test("connection keys stay in an owner-only local file and never enter public settings", async (t) => {
  const { settingsPath, settings } = await store(t);
  assert.equal((await settings.public()).hasKey, false);
  const saved = await settings.save({ provider: "jev", key: "fake-local-key" });
  assert.deepEqual(saved, {
    provider: "jev",
    baseUrl: "https://api.typesafe.ai",
    model: "jev-latest",
    hasKey: true,
  });
  assert.ok(!JSON.stringify(saved).includes("fake-local-key"));
  assert.equal((await settings.read()).key, "fake-local-key");
  assert.equal((await stat(settingsPath)).mode & 0o777, 0o600);
  const reopened = createSettingsStore({ settingsPath, environment: {} });
  assert.equal((await reopened.read()).key, "fake-local-key");
});

test("blank keys preserve only the same destination and never follow a changed gateway", async (t) => {
  const { settings } = await store(t);
  await settings.save({
    provider: "gateway",
    baseUrl: "https://one.example",
    model: "judge",
    key: "fake-one-key",
  });
  await settings.save({ model: "judge-two", key: "" });
  assert.equal((await settings.read()).key, "fake-one-key");
  await assert.rejects(
    settings.save({ baseUrl: "https://two.example", key: "" }),
    /API key/,
  );
  assert.equal((await settings.read()).baseUrl, "https://one.example");
  await assert.rejects(
    settings.discovery({ baseUrl: "https://two.example", key: "" }),
    /API key/,
  );
  const same = await settings.discovery({
    baseUrl: "https://one.example/v1",
    key: "",
  });
  assert.equal(same.key, "fake-one-key");
  await settings.save({ baseUrl: "http://127.0.0.1:4000", key: "" });
  assert.equal((await settings.read()).key, "");
});

test("saving and forgetting preserve unrelated dotenv values including multiline fields", async (t) => {
  const { settingsPath, settings } = await store(t);
  const original =
    "# retained comment\nOTHER='a value'\nMULTILINE='first\nBACKLOG_API_KEY=inside unrelated value\nlast'\n";
  await writeFile(settingsPath, original);
  await settings.save({ key: "fake-one-key" });
  const saved = parseEnv(await readFile(settingsPath, "utf8"));
  assert.equal(saved.OTHER, "a value");
  assert.equal(
    saved.MULTILINE,
    "first\nBACKLOG_API_KEY=inside unrelated value\nlast",
  );
  assert.equal(saved.BACKLOG_API_KEY, "fake-one-key");
  assert.equal((await settings.save({ forget: true })).hasKey, false);
  const forgotten = parseEnv(await readFile(settingsPath, "utf8"));
  assert.equal(forgotten.BACKLOG_API_KEY, undefined);
  assert.equal(forgotten.OTHER, saved.OTHER);
  assert.equal(forgotten.MULTILINE, saved.MULTILINE);
  assert.ok(
    (await readFile(settingsPath, "utf8")).startsWith("# retained comment"),
  );
});

test("environment-managed secrets take precedence and reject silent local changes", async (t) => {
  const { settingsPath, settings } = await store(t, {
    BACKLOG_API_KEY: "fake-env-key",
  });
  await writeFile(settingsPath, "BACKLOG_API_KEY='fake-file-key'\n");
  assert.equal((await settings.read()).key, "fake-env-key");
  assert.equal((await settings.save({ key: "" })).hasKey, true);
  await assert.rejects(
    settings.save({ key: "fake-new-key" }),
    (error) =>
      error.status === 409 && /environment variables/.test(error.message),
  );
  await assert.rejects(
    settings.save({ forget: true }),
    /environment variables/,
  );
  await assert.rejects(
    settings.save({
      provider: "gateway",
      baseUrl: "https://gateway.example",
      model: "judge",
      key: "",
    }),
    (error) =>
      error.status === 409 && /environment variables/.test(error.message),
  );
  assert.equal(
    parseEnv(await readFile(settingsPath, "utf8")).BACKLOG_API_KEY,
    "fake-file-key",
  );
});

test("discovery from TypeSafe to a gateway uses only the explicitly entered gateway key", async (t) => {
  const { settings } = await store(t);
  await settings.save({ key: "fake-typesafe-key" });
  await assert.rejects(
    settings.discovery({ baseUrl: "https://gateway.example", key: "" }),
    /API key/,
  );
  const gateway = await settings.discovery({
    baseUrl: "https://gateway.example",
    key: "fake-gateway-key",
  });
  assert.equal(gateway.provider, "gateway");
  assert.equal(gateway.key, "fake-gateway-key");
  assert.equal((await settings.read()).key, "fake-typesafe-key");
});
