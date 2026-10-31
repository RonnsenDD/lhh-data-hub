import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { generateKeyPairSync, verify as verifySignature, createPublicKey } from "node:crypto";
import {
  adapterConstants,
  createAppJwt,
  createGitHubAppClient,
  WORKFLOWS,
} from "./github-app-adapter.js";

const NOW = Date.parse("2026-10-31T10:20:00Z");
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
});
const ENV = {
  GITHUB_APP_ID: "5555433",
  GITHUB_INSTALLATION_ID: "177220128",
  GITHUB_APP_PRIVATE_KEY: privateKey,
};
const validRuns = [
  {
    id: 301,
    status: "queued",
    conclusion: null,
    event: "schedule",
    created_at: "2026-10-31T10:03:15Z",
    run_started_at: null,
    updated_at: "2026-10-31T10:03:15Z",
    head_sha: "abc123",
  },
  {
    id: 300,
    status: "completed",
    conclusion: "failure",
    event: "schedule",
    created_at: "2026-10-31T09:48:00Z",
    run_started_at: "2026-10-31T09:48:02Z",
    updated_at: "2026-10-31T09:49:00Z",
    head_sha: "def456",
  },
  {
    id: 299,
    status: "completed",
    conclusion: "success",
    event: "push",
    created_at: "2026-10-31T09:30:00Z",
    run_started_at: "2026-10-31T09:30:03Z",
    updated_at: "2026-10-31T09:31:00Z",
    head_sha: "ghi789",
  },
];
const json = (value, status = 200, headers = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
function decodeSegment(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
}
function appJwtCalls(runs = validRuns) {
  const calls = [];
  const fetcher = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (url.origin !== adapterConstants.apiOrigin) {
      return json({ message: "forbidden host" }, 403);
    }
    if (url.pathname === "/app/installations/177220128/access_tokens") {
      assert.equal(init.method, "POST");
      assert.equal(init.redirect, "manual");
      return json({
        token: "ghs_testInstallationToken_1234567890",
        expires_at: new Date(NOW + 60 * 60 * 1000).toISOString(),
      });
    }
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "manual");
    assert.equal(url.pathname.startsWith("/repos/RonnsenDD/lhh-data-hub/actions/workflows/"), true);
    assert.equal(url.pathname.endsWith("/runs"), true);
    return json({ total_count: runs.length, workflow_runs: runs });
  };
  return { calls, fetcher };
}

test("RS256 JWT carries App ID, clock-skew allowance, 9-minute lifetime, and valid signature", async () => {
  const jwt = await createAppJwt({
    appId: ENV.GITHUB_APP_ID,
    privateKeyPem: privateKey,
    nowMs: NOW,
  });
  const [head, body, signature, extra] = jwt.split(".");
  assert.ok(head && body && signature);
  assert.equal(extra, undefined);
  assert.deepEqual(decodeSegment(head), { alg: "RS256", typ: "JWT" });
  const payload = decodeSegment(body);
  assert.equal(payload.iss, "5555433");
  assert.equal(payload.iat, Math.floor(NOW / 1000) - 60);
  assert.equal(payload.exp, Math.floor(NOW / 1000) + 540);
  assert.ok(verifySignature(
    "RSA-SHA256",
    Buffer.from(head + "." + body),
    createPublicKey(publicKey),
    Buffer.from(signature.replace(/-/g, "+").replace(/_/g, "/"), "base64"),
  ));
});

test("App client requests a one-repository Actions-read token and only GETs workflow runs", async () => {
  const { calls, fetcher } = appJwtCalls();
  const client = createGitHubAppClient(ENV, { fetcher, now: () => NOW });
  const result = await client.getWorkflowSnapshot();
  assert.equal(result.repository, "RonnsenDD/lhh-data-hub");
  assert.equal(result.queryStatus, "OK");
  assert.equal(result.workflows.length, 5);
  const tokenCall = calls.find((call) => call.url.pathname.endsWith("/access_tokens"));
  assert.ok(tokenCall);
  assert.deepEqual(JSON.parse(tokenCall.init.body), {
    repository_ids: [1424581788],
    permissions: { actions: "read" },
  });
  assert.match(tokenCall.init.headers.Authorization, /^Bearer [^.]+\.[^.]+\.[^.]+$/);
  assert.equal(calls.filter((call) => call.init.method === "GET").length, 5);
  assert.ok(calls.every((call) => call.url.origin === "https://api.github.com"));
  assert.ok(calls.every((call) => call.init.method === "GET" || call.url.pathname.endsWith("/access_tokens")));
  assert.equal(calls.some((call) => call.url.pathname.includes("dispatch")), false);
  const source = await readFile(new URL("./github-app-adapter.js", import.meta.url), "utf8");
  assert.equal(source.includes("workflow_dispatch"), false);
});

test("workflow summary separates successful, failed, active, automatic age, and schedule gap", async () => {
  const { fetcher } = appJwtCalls();
  const result = await createGitHubAppClient(ENV, { fetcher, now: () => NOW }).getWorkflowSnapshot();
  const row = result.workflows.find((workflow) => workflow.file === "update-dwd-weather.yml");
  assert.equal(row.lastRun.id, 301);
  assert.equal(row.lastSuccess.conclusion, "success");
  assert.equal(row.lastFailure.conclusion, "failure");
  assert.equal(row.activeRuns[0].status, "queued");
  assert.equal(row.lastAutomaticRunCreatedAt, "2026-10-31T10:03:15Z");
  assert.equal(row.lastAutomaticRunStartedAt, null);
  assert.equal(row.minutesSinceLastAutomaticRunCreated, 16);
  assert.equal(row.minutesSinceLastAutomaticRunStarted, null);
  assert.equal(row.latestExpectedScheduleTickAt, "2026-10-31T10:18:00.000Z");
  assert.equal(row.latestExpectedTickOverdueMinutes, 2);
  assert.equal(row.lastAutomaticScheduleCreationDelayMinutes, 0);
  assert.equal(row.lastAutomaticRunStartDelayMinutes, null);
});



test("a missed schedule tick is separate from the age of the last automatic run", async () => {
  const { fetcher } = appJwtCalls([{
    id: 401,
    status: "completed",
    conclusion: "success",
    event: "schedule",
    created_at: "2026-10-31T10:03:00Z",
    run_started_at: "2026-10-31T10:03:08Z",
  }]);
  const row = (await createGitHubAppClient(ENV, { fetcher, now: () => NOW })
    .getWorkflowSnapshot()).workflows[0];
  assert.equal(row.minutesSinceLastAutomaticRunCreated, 17);
  assert.equal(row.minutesSinceLastAutomaticRunStarted, 16);
  assert.equal(row.latestExpectedScheduleTickAt, "2026-10-31T10:18:00.000Z");
  assert.equal(row.latestExpectedTickOverdueMinutes, 2);
  assert.equal(row.lastAutomaticScheduleCreationDelayMinutes, 0);
  assert.equal(row.missingExpectedScheduleTicksBetweenLatestAutomaticRuns, null);
  assert.equal("scheduleOverdueMinutes" in row, false);
});

test("late run reports inferred cron delay, missed ticks, and actual run age separately", async () => {
  const delayedRuns = [
    {
      id: 502,
      status: "completed",
      conclusion: "success",
      event: "schedule",
      created_at: "2026-10-31T10:37:00Z",
      run_started_at: "2026-10-31T10:38:00Z",
    },
    {
      id: 501,
      status: "completed",
      conclusion: "success",
      event: "schedule",
      created_at: "2026-10-31T10:03:00Z",
      run_started_at: "2026-10-31T10:03:08Z",
    },
  ];
  const { fetcher } = appJwtCalls(delayedRuns);
  const row = (await createGitHubAppClient(ENV, {
    fetcher,
    now: () => Date.parse("2026-10-31T10:40:00Z"),
  }).getWorkflowSnapshot()).workflows[0];

  assert.equal(row.minutesSinceLastAutomaticRunCreated, 3);
  assert.equal(row.minutesSinceLastAutomaticRunStarted, 2);
  assert.equal(row.latestExpectedScheduleTickAt, "2026-10-31T10:33:00.000Z");
  assert.equal(row.latestExpectedTickOverdueMinutes, 0);
  assert.equal(row.lastAutomaticScheduleCreationDelayMinutes, 4);
  assert.equal(row.lastAutomaticRunStartDelayMinutes, 5);
  assert.equal(row.scheduleStartDelayAttribution, "inferred_nearest_cron_tick_before_run_creation");
  assert.equal(row.missingExpectedScheduleTicksBetweenLatestAutomaticRuns, 1);
});

test("daily schedule gap counts omitted calendar runs without confusing age and lateness", async () => {
  const daily = WORKFLOWS.find((workflow) => workflow.file === "update-graslandfeuerindex.yml");
  const runs = [
    {
      id: 602,
      status: "completed",
      conclusion: "success",
      event: "schedule",
      created_at: "2026-10-31T05:17:00Z",
      run_started_at: "2026-10-31T05:19:00Z",
    },
    {
      id: 601,
      status: "completed",
      conclusion: "success",
      event: "schedule",
      created_at: "2026-10-28T05:16:00Z",
      run_started_at: "2026-10-28T05:18:00Z",
    },
  ];
  const actualNow = Date.parse("2026-10-31T05:30:00Z");
  const { fetcher } = appJwtCalls(runs);
  const row = (await createGitHubAppClient(ENV, {
    fetcher,
    now: () => actualNow,
  }).getWorkflowSnapshot()).workflows.find((workflow) => workflow.file === daily.file);

  assert.equal(row.minutesSinceLastAutomaticRunCreated, 13);
  assert.equal(row.minutesSinceLastAutomaticRunStarted, 11);
  assert.equal(row.latestExpectedTickOverdueMinutes, 0);
  assert.equal(row.lastAutomaticScheduleCreationDelayMinutes, 2);
  assert.equal(row.lastAutomaticRunStartDelayMinutes, 4);
  assert.equal(row.missingExpectedScheduleTicksBetweenLatestAutomaticRuns, 2);
});

test("token is reused within its safe lifetime and renewed inside five-minute expiry margin", async () => {
  let nowMs = NOW;
  let tokenRequests = 0;
  const fetcher = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/access_tokens")) {
      tokenRequests++;
      return json({
        token: "ghs_testInstallationToken_1234567890",
        expires_at: new Date(nowMs + 60 * 60 * 1000).toISOString(),
      });
    }
    return json({ workflow_runs: [] });
  };
  const client = createGitHubAppClient(ENV, { fetcher, now: () => nowMs });
  await client.getWorkflowSnapshot();
  await client.getWorkflowSnapshot();
  assert.equal(tokenRequests, 1);
  nowMs += 56 * 60 * 1000;
  await client.getWorkflowSnapshot();
  assert.equal(tokenRequests, 2);
});

test("PKCS8 GitHub key PEM is supported too", async () => {
  const { privateKey: pkcs8 } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const jwt = await createAppJwt({ appId: ENV.GITHUB_APP_ID, privateKeyPem: pkcs8, nowMs: NOW });
  assert.equal(decodeSegment(jwt.split(".")[0]).alg, "RS256");
});

test("missing configuration and invalid keys fail without exposing values", async () => {
  assert.throws(
    () => createGitHubAppClient({ GITHUB_APP_ID: "5555433" }),
    (error) => error.code === "INVALID_INSTALLATION_ID",
  );
  const badEnv = { ...ENV, GITHUB_APP_PRIVATE_KEY: "not a key" };
  const client = createGitHubAppClient(badEnv, { fetcher: async () => assert.fail("must not fetch") });
  const result = await client.getWorkflowSnapshot();
  assert.equal(result.reasonCode, "INVALID_PRIVATE_KEY");
  assert.equal(JSON.stringify(result).includes("not a key"), false);
});

test("401 authentication failure skips all workflow reads", async () => {
  const calls = [];
  const client = createGitHubAppClient(ENV, {
    now: () => NOW,
    fetcher: async (input, init) => {
      calls.push({ url: new URL(String(input)), init });
      return json({ message: "private response body not surfaced" }, 401);
    },
  });
  const result = await client.getWorkflowSnapshot();
  assert.equal(result.queryStatus, "ERROR");
  assert.equal(result.reasonCode, "GITHUB_UNAUTHORIZED");
  assert.equal(result.workflows.every((workflow) => workflow.queryStatus === "SKIPPED_AUTH_FAILURE"), true);
  assert.equal(calls.length, 1);
  assert.equal(JSON.stringify(result).includes("private response body"), false);
});

test("403 permission denial is distinct from GitHub rate limiting", async () => {
  const makeClient = (remaining) => {
    const { fetcher } = appJwtCalls();
    return createGitHubAppClient(ENV, {
      now: () => NOW,
      fetcher: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/access_tokens")) return fetcher(input, init);
        if (url.pathname.includes("update-dwd-weather.yml")) {
          return json({ message: "redacted" }, 403, { "x-ratelimit-remaining": String(remaining), "x-ratelimit-reset": "1793440000" });
        }
        return fetcher(input, init);
      },
    });
  };
  const forbidden = await makeClient(500).getWorkflowSnapshot();
  assert.equal(forbidden.workflows.find((row) => row.file === "update-dwd-weather.yml").reasonCode, "GITHUB_PERMISSION_DENIED");
  const limited = await makeClient(0).getWorkflowSnapshot();
  const row = limited.workflows.find((workflow) => workflow.file === "update-dwd-weather.yml");
  assert.equal(row.reasonCode, "GITHUB_RATE_LIMITED");
  assert.equal(row.rateLimitRemaining, 0);
  assert.ok(row.rateLimitResetAt);
  assert.equal(limited.queryStatus, "PARTIAL");
});

test("429 and 5xx are reported per workflow without stopping other reads", async () => {
  const { fetcher } = appJwtCalls();
  const client = createGitHubAppClient(ENV, {
    now: () => NOW,
    fetcher: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/access_tokens")) return fetcher(input, init);
      if (url.pathname.includes("update-levels.yml")) return json({}, 429, { "retry-after": "30" });
      if (url.pathname.includes("update-radolan-ry.yml")) return json({}, 503);
      return fetcher(input, init);
    },
  });
  const result = await client.getWorkflowSnapshot();
  assert.equal(result.workflows.find((x) => x.file === "update-levels.yml").reasonCode, "GITHUB_RATE_LIMITED");
  assert.equal(result.workflows.find((x) => x.file === "update-levels.yml").retryAfterSeconds, 30);
  assert.equal(result.workflows.find((x) => x.file === "update-radolan-ry.yml").reasonCode, "GITHUB_UPSTREAM_ERROR");
  assert.equal(result.workflows.find((x) => x.file === "update-dwd-weather.yml").queryStatus, "OK");
});

test("timeouts are isolated and do not change observe-only feed code", async () => {
  const client = createGitHubAppClient(ENV, {
    now: () => NOW,
    timeoutMs: 5,
    fetcher: async (input, init) => {
      if (new URL(String(input)).pathname.endsWith("/access_tokens")) {
        return json({ token: "ghs_testInstallationToken_1234567890", expires_at: new Date(NOW + 3600000).toISOString() });
      }
      return new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    },
  });
  const result = await client.getWorkflowSnapshot();
  assert.equal(result.queryStatus, "PARTIAL");
  assert.equal(result.workflows.every((workflow) => workflow.reasonCode === "GITHUB_TIMEOUT"), true);
  const worker = await readFile(new URL("./worker.js", import.meta.url), "utf8");
  assert.equal(worker.includes("github-app-adapter"), false);
  assert.equal(worker.includes("api.github.com"), false);
});

test("GitHub API redirects remain same-origin, bounded, and read-only", async () => {
  const calls = [];
  const client = createGitHubAppClient(ENV, {
    now: () => NOW,
    fetcher: async (input, init) => {
      const url = new URL(String(input));
      calls.push({ url, init });
      if (url.pathname.endsWith("/access_tokens")) {
        return json({ token: "ghs_testInstallationToken_1234567890", expires_at: new Date(NOW + 3600000).toISOString() });
      }
      if (url.pathname.includes("update-dwd-weather.yml") && !url.searchParams.has("ok")) {
        const target = new URL(url);
        target.searchParams.set("ok", "1");
        return new Response(null, { status: 302, headers: { location: target.href } });
      }
      return json({ workflow_runs: [] });
    },
  });
  const result = await client.getWorkflowSnapshot();
  assert.equal(result.workflows.find((x) => x.file === "update-dwd-weather.yml").queryStatus, "OK");
  assert.ok(calls.every((call) => call.init.redirect === "manual"));
  assert.ok(calls.every((call) => call.url.origin === "https://api.github.com"));
  const rejectedClient = createGitHubAppClient(ENV, {
    now: () => NOW,
    fetcher: async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/access_tokens")) {
        return json({ token: "ghs_testInstallationToken_1234567890", expires_at: new Date(NOW + 3600000).toISOString() });
      }
      if (url.pathname.includes("update-dwd-weather.yml")) {
        return new Response(null, { status: 302, headers: { location: "https://evil.example/steal" } });
      }
      return json({ workflow_runs: [] });
    },
  });
  const rejected = await rejectedClient.getWorkflowSnapshot();
  assert.equal(rejected.workflows.find((x) => x.file === "update-dwd-weather.yml").reasonCode, "GITHUB_REDIRECT_REJECTED");
});

test("fixed workflow list includes only the five approved Data Hub producers", () => {
  assert.deepEqual(WORKFLOWS.map((workflow) => workflow.file), [
    "update-dwd-weather.yml",
    "update-levels.yml",
    "update-radolan-ry.yml",
    "update-graslandfeuerindex.yml",
    "update-waldbrandgefahrenstufe-osl.yml",
  ]);
  assert.equal(adapterConstants.repositoryPath, "/repos/RonnsenDD/lhh-data-hub");
  assert.equal(adapterConstants.repositoryId, 1424581788);
});

