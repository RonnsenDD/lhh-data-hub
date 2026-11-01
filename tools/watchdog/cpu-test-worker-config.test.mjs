import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const configPath = new URL("../../wrangler.watchdog-cpu-test.jsonc", import.meta.url);

test("CPU observation uses a separate, read-only test Worker and cadence", async () => {
  const config = JSON.parse(await readFile(configPath, "utf8"));

  assert.equal(config.name, "feuerwehr-lauchhammer-watchdog-cpu-test");
  assert.notEqual(config.name, "feuerwehr-lauchhammer-watchdog");
  assert.equal(config.main, "tools/watchdog/worker.bundle.js");
  assert.equal(config.workers_dev, false);
  assert.deepEqual(config.triggers?.crons, ["*/30 * * * *"]);
  assert.equal(config.vars.GITHUB_APP_READ_ENABLED, "false");
  assert.equal(config.vars.WORKFLOW_DISPATCH_ENABLED, "false");
  assert.equal(config.vars.WATCHDOG_DIAGNOSTICS_ENABLED, "false");
  assert.equal(config.vars.WATCHDOG_CPU_TEST_MODE, "true");
  assert.equal(config.vars.WATCHDOG_WEATHER_FIXTURE_MODE, "false");

  assert.equal("routes" in config, false);
  assert.equal("durable_objects" in config, false);
  assert.equal("migrations" in config, false);
  assert.equal("secrets" in config, false);
});
