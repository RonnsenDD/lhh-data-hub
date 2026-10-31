import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createGitHubAppClient } from "./github-app-adapter.js";
import { dispatchStaleSources, WatchdogDispatchCoordinator } from "./worker.js";

const NOW = Date.parse("2026-10-31T20:00:00Z");

function report(overrides = {}) {
  return {
    sources: [
      { key: "weather", status: "OK", ageMinutes: 10, thresholdMinutes: 45, sourceTime: "2026-10-31T19:50:00Z" },
      { key: "radolan_ry", status: "OK", ageMinutes: 8, thresholdMinutes: 15, sourceTime: "2026-10-31T19:52:00Z" },
      { key: "konrad3d", status: "OK", ageMinutes: 8, thresholdMinutes: 15, sourceTime: "2026-10-31T19:52:00Z" },
      { key: "other", status: "ERROR", reasonCode: "HTTP_503" },
      ...(overrides.sources ?? []),
    ],
  };
}

function snapshot(file, { queryStatus = "OK", activeRuns = [] } = {}) {
  return { queryStatus, workflows: [{ file, queryStatus, activeRuns }] };
}

function fakeCoordinator({ granted = true } = {}) {
  const calls = [];
  return {
    calls,
    async fetch(request) {
      const action = new URL(request.url).pathname.slice(1);
      const body = await request.json();
      calls.push({ action, body });
      if (action === "reserve") return Response.json(granted ? { granted: true, leaseId: "lease-test" } : { granted: false, reason: "cooldown" });
      return Response.json({ completed: true });
    },
  };
}

test("current feeds never request workflow dispatch", async () => {
  let snapshots = 0;
  const coordinator = fakeCoordinator();
  const result = await dispatchStaleSources({
    report: report(),
    client: { getWorkflowSnapshot: async () => { snapshots++; assert.fail("fresh data must not query GitHub"); }, dispatchWorkflow: async () => assert.fail("fresh data must not dispatch") },
    coordinator,
    nowMs: NOW,
  });
  assert.deepEqual(result, []);
  assert.equal(snapshots, 0);
  assert.equal(coordinator.calls.length, 0);
});

test("stale weather is dispatched only after two clean active-run checks and a reservation", async () => {
  const events = [];
  const coordinator = fakeCoordinator();
  let checks = 0;
  const result = await dispatchStaleSources({
    report: report({ sources: [{ key: "weather", status: "STALE", reasonCode: "OBSERVATION_STALE", ageMinutes: 61, thresholdMinutes: 45, sourceTime: "2026-10-31T18:59:00Z", products: { observations: [{ field: "temperatureC", status: "STALE", measuredAt: "2026-10-31T18:59:00Z" }] } }] }),
    client: {
      getWorkflowSnapshot: async ({ files }) => { checks++; events.push("check"); assert.deepEqual(files, ["update-dwd-weather.yml"]); return snapshot(files[0]); },
      dispatchWorkflow: async (file, options) => { events.push("dispatch"); assert.equal(file, "update-dwd-weather.yml"); assert.deepEqual(options, { enabled: true, ref: "main" }); return { httpStatus: 204 }; },
    },
    coordinator,
    nowMs: NOW,
  });
  assert.equal(checks, 2);
  assert.deepEqual(events, ["check", "check", "dispatch"]);
  assert.deepEqual(coordinator.calls.map((call) => call.action), ["reserve", "finish"]);
  assert.equal(result[0].outcome, "dispatch_accepted_not_verified");
  assert.equal(result[0].sources[0].ageMinutes, 61);
});

test("RADOLAN and KONRAD3D stale data share one allowlisted workflow request", async () => {
  const coordinator = fakeCoordinator();
  const dispatches = [];
  const result = await dispatchStaleSources({
    report: report({ sources: [
      { key: "radolan_ry", status: "STALE", reasonCode: "SOURCE_TOO_OLD", ageMinutes: 19, sourceTime: "2026-10-31T19:41:00Z" },
      { key: "konrad3d", status: "STALE", reasonCode: "SOURCE_TOO_OLD", ageMinutes: 22, sourceTime: "2026-10-31T19:38:00Z" },
    ] }),
    client: { getWorkflowSnapshot: async ({ files }) => snapshot(files[0]), dispatchWorkflow: async (file) => { dispatches.push(file); return { httpStatus: 204 }; } },
    coordinator,
    nowMs: NOW,
  });
  assert.deepEqual(dispatches, ["update-radolan-ry.yml"]);
  assert.deepEqual(result[0].sources.map((source) => source.key), ["radolan_ry", "konrad3d"]);
});

test("active, unavailable GitHub status, failed second check, and held lease all fail closed", async (t) => {
  const stale = report({ sources: [{ key: "weather", status: "STALE", ageMinutes: 60, products: { observations: [{ field: "temperatureC", status: "STALE", measuredAt: "2026-10-31T19:00:00Z" }] } }] });
  await t.test("already running before reservation", async () => {
    const coordinator = fakeCoordinator(); let dispatched = false;
    const result = await dispatchStaleSources({ report: stale, client: { getWorkflowSnapshot: async ({ files }) => snapshot(files[0], { activeRuns: [{ id: 42, status: "in_progress" }] }), dispatchWorkflow: async () => { dispatched = true; } }, coordinator, nowMs: NOW });
    assert.equal(result[0].outcome, "already_running"); assert.equal(coordinator.calls.length, 0); assert.equal(dispatched, false);
  });
  await t.test("GitHub query error", async () => {
    const coordinator = fakeCoordinator(); let dispatched = false;
    const result = await dispatchStaleSources({ report: stale, client: { getWorkflowSnapshot: async () => ({ queryStatus: "ERROR", workflows: [] }), dispatchWorkflow: async () => { dispatched = true; } }, coordinator, nowMs: NOW });
    assert.equal(result[0].outcome, "blocked_github_status"); assert.equal(coordinator.calls.length, 0); assert.equal(dispatched, false);
  });
  await t.test("active run appears after reservation", async () => {
    const coordinator = fakeCoordinator(); let checks = 0; let dispatched = false;
    const result = await dispatchStaleSources({ report: stale, client: { getWorkflowSnapshot: async ({ files }) => snapshot(files[0], { activeRuns: ++checks === 2 ? [{ id: 43, status: "queued" }] : [] }), dispatchWorkflow: async () => { dispatched = true; } }, coordinator, nowMs: NOW });
    assert.equal(result[0].outcome, "already_running"); assert.equal(dispatched, false); assert.deepEqual(coordinator.calls.map((call) => call.action), ["reserve", "finish"]);
  });
  await t.test("coordinator cooldown", async () => {
    const coordinator = fakeCoordinator({ granted: false }); let dispatched = false;
    const result = await dispatchStaleSources({ report: stale, client: { getWorkflowSnapshot: async ({ files }) => snapshot(files[0]), dispatchWorkflow: async () => { dispatched = true; } }, coordinator, nowMs: NOW });
    assert.equal(result[0].outcome, "suppressed"); assert.equal(dispatched, false);
  });
});

test("dispatch timeout is recorded as uncertain, not as a successful update", async () => {
  const coordinator = fakeCoordinator();
  const result = await dispatchStaleSources({
    report: report({ sources: [{ key: "weather", status: "STALE", ageMinutes: 55, products: { observations: [{ field: "temperatureC", status: "STALE", measuredAt: "2026-10-31T19:05:00Z" }] } }] }),
    client: { getWorkflowSnapshot: async ({ files }) => snapshot(files[0]), dispatchWorkflow: async () => { const error = new Error("GITHUB_TIMEOUT"); error.code = "GITHUB_TIMEOUT"; throw error; } },
    coordinator,
    nowMs: NOW,
  });
  assert.equal(result[0].outcome, "dispatch_or_control_error");
  assert.equal(coordinator.calls.at(-1).body.outcome, "uncertain");
  assert.notEqual(result[0].outcome, "dispatch_accepted_not_verified");
});

test("Durable Object reservations serialize concurrent dispatch attempts and enforce cooldown/day cap", async () => {
  const store = new Map();
  let gate = Promise.resolve();
  const ctx = {
    storage: { get: async (key) => store.get(key), put: async (key, value) => store.set(key, value) },
    blockConcurrencyWhile(fn) { const prior = gate; let release; gate = new Promise((resolve) => { release = resolve; }); return prior.then(fn).finally(release); },
  };
  const coordinator = new WatchdogDispatchCoordinator(ctx);
  const payload = { workflowFile: "update-dwd-weather.yml", nowMs: NOW, cooldownMs: 30 * 60_000, maxPerUtcDay: 2, leaseMs: 5 * 60_000, sourceFingerprint: "weather:2026-10-31T19:00:00Z" };
  const [a, b] = await Promise.all([
    coordinator.fetch(new Request("https://internal/reserve", { method: "POST", body: JSON.stringify(payload) })),
    coordinator.fetch(new Request("https://internal/reserve", { method: "POST", body: JSON.stringify(payload) })),
  ]);
  const results = await Promise.all([a.json(), b.json()]);
  assert.equal(results.filter((item) => item.granted).length, 1);
  assert.equal(results.filter((item) => item.reason === "reservation_active").length, 1);
  const lease = results.find((item) => item.granted).leaseId;
  const finish = await coordinator.fetch(new Request("https://internal/finish", { method: "POST", body: JSON.stringify({ workflowFile: payload.workflowFile, leaseId: lease, outcome: "accepted" }) }));
  assert.equal((await finish.json()).completed, true);
  const afterCooldown = await coordinator.fetch(new Request("https://internal/reserve", { method: "POST", body: JSON.stringify({ ...payload, nowMs: NOW + 1000 }) }));
  assert.equal((await afterCooldown.json()).reason, "cooldown");
  const sameSnapshot = await coordinator.fetch(new Request("https://internal/reserve", { method: "POST", body: JSON.stringify({ ...payload, nowMs: NOW + 31 * 60_000 }) }));
  assert.equal((await sameSnapshot.json()).reason, "same_source_snapshot");
  const changedPayload = { ...payload, sourceFingerprint: "weather:2026-10-31T19:20:00Z" };
  const second = await coordinator.fetch(new Request("https://internal/reserve", { method: "POST", body: JSON.stringify({ ...changedPayload, nowMs: NOW + 31 * 60_000 }) }));
  const secondValue = await second.json();
  assert.equal(secondValue.granted, true);
  await coordinator.fetch(new Request("https://internal/finish", { method: "POST", body: JSON.stringify({ workflowFile: payload.workflowFile, leaseId: secondValue.leaseId, outcome: "accepted" }) }));
  const dailyLimit = await coordinator.fetch(new Request("https://internal/reserve", { method: "POST", body: JSON.stringify({ ...changedPayload, nowMs: NOW + 62 * 60_000 }) }));
  assert.equal((await dailyLimit.json()).reason, "daily_limit");
  const nextDay = await coordinator.fetch(new Request("https://internal/reserve", { method: "POST", body: JSON.stringify({ ...changedPayload, sourceFingerprint: "weather:2026-11-01T08:00:00Z", nowMs: NOW + 24 * 60 * 60_000 }) }));
  assert.equal((await nextDay.json()).granted, true);
});

test("GitHub App dispatch requests only repository-scoped Actions write for fixed workflow on main", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const calls = [];
  const now = () => NOW;
  const client = createGitHubAppClient({ GITHUB_APP_ID: "5555433", GITHUB_INSTALLATION_ID: "177220128", GITHUB_APP_PRIVATE_KEY: privateKey }, {
    now,
    fetcher: async (input, init) => {
      const url = new URL(String(input)); calls.push({ url, init });
      if (url.pathname.endsWith("/access_tokens")) return Response.json({ token: "ghs_testInstallationToken_1234567890", expires_at: new Date(NOW + 3600000).toISOString() });
      return new Response(null, { status: 204 });
    },
  });
  await assert.rejects(client.dispatchWorkflow("update-dwd-weather.yml"), /DISPATCH_DISABLED/);
  assert.equal(calls.length, 0);
  await assert.rejects(client.dispatchWorkflow("update-levels.yml", { enabled: true }), /WORKFLOW_NOT_ALLOWLISTED/);
  const result = await client.dispatchWorkflow("update-dwd-weather.yml", { enabled: true });
  assert.deepEqual(result, { accepted: true, workflowFile: "update-dwd-weather.yml", ref: "main", httpStatus: 204 });
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[0].init.body), { repository_ids: [1424581788], permissions: { actions: "write" } });
  assert.equal(calls[1].init.method, "POST");
  assert.equal(calls[1].url.pathname, "/repos/RonnsenDD/lhh-data-hub/actions/workflows/update-dwd-weather.yml/dispatches");
  assert.deepEqual(JSON.parse(calls[1].init.body), { ref: "main" });
});

test("GitHub dispatch permission and throttling failures are classified without retry", async (t) => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  for (const [status, expected] of [[403, "GITHUB_PERMISSION_DENIED"], [429, "GITHUB_RATE_LIMITED"], [503, "GITHUB_UPSTREAM_ERROR"]]) {
    await t.test(String(status), async () => {
      let dispatchCount = 0;
      const client = createGitHubAppClient({ GITHUB_APP_ID: "5555433", GITHUB_INSTALLATION_ID: "177220128", GITHUB_APP_PRIVATE_KEY: privateKey }, {
        now: () => NOW,
        fetcher: async (input) => {
          const url = new URL(String(input));
          if (url.pathname.endsWith("/access_tokens")) return Response.json({ token: "ghs_testInstallationToken_1234567890", expires_at: new Date(NOW + 3600000).toISOString() });
          dispatchCount++;
          return Response.json({ message: "sensitive body omitted" }, { status, headers: status === 429 ? { "retry-after": "120" } : {} });
        },
      });
      await assert.rejects(client.dispatchWorkflow("update-radolan-ry.yml", { enabled: true }), (error) => error.code === expected);
      assert.equal(dispatchCount, 1);
    });
  }
});
