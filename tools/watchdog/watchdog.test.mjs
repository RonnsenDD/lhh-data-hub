import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
const code = await readFile(new URL("./worker.js", import.meta.url), "utf8"),
  m = await import("./worker.js");
const { collectStatus, URLS, wildfireInterval, berlinWallClockToUtc } = m,
  NOW = Date.parse("2026-10-31T11:00:00Z");
function fixtures() {
  return {
    [URLS.weather]: {
      schemaVersion: 2,
      status: "ok",
      observations: {
        temperatureHumidity: {
          status: "ok",
          measuredAt: "2026-10-31T10:40:00Z",
          retrievedAt: "2026-10-31T10:55:00Z",
          values: {
            temperatureC: 7,
            relativeHumidityPercent: 85,
            dewPointC: 4,
          },
        },
        stationPressure: {
          status: "ok",
          measuredAt: "2026-10-31T10:40:00Z",
          values: { stationPressureHpa: 1018 },
        },
        wind: {
          status: "ok",
          measuredAt: "2026-10-31T10:40:00Z",
          values: { windSpeedKmh: 10, windDirectionDeg: 270 },
        },
        windGust: {
          status: "ok",
          measuredAt: "2026-10-31T10:40:00Z",
          values: { windGustKmh: 18 },
        },
        precipitation: {
          status: "ok",
          measuredAt: "2026-10-31T10:40:00Z",
          values: { precipitation10MinMm: 0.2 },
        },
      },
      forecast: {
        status: "ok",
        issuedAt: "2026-10-31T03:00:00Z",
        retrievedAt: "2026-10-31T10:55:00Z",
        points: [
          { validAt: "2026-10-31T12:00:00Z", values: { temperatureC: 9 } },
        ],
      },
    },
    [URLS.levelsL]: {
      schemaVersion: 1,
      station: "Lauchhammer",
      stationNumber: "5530401",
      latestMeasurement: {
        waterLevelCm: 55,
        measuredAtUtc: "2026-10-31T10:30:00Z",
      },
      retrievedAt: "2026-10-31T10:55:00Z",
      freshnessThresholdMinutes: 45,
      status: "ok",
    },
    [URLS.levelsB]: {
      schemaVersion: 1,
      station: "Biehlen 1",
      stationNumber: "5530302",
      latestMeasurement: {
        waterLevelCm: 39,
        measuredAtUtc: "2026-10-31T10:45:00Z",
      },
      retrievedAt: "2026-10-31T10:55:00Z",
      freshnessThresholdMinutes: 45,
      status: "ok",
    },
    [URLS.radar]: {
      status: "current",
      frameId: "ry1",
      productTime: "2026-10-31T10:55:00Z",
      retrievedAt: "2026-10-31T10:58:00Z",
      rainImage: "rain-ry1.png",
      coverageImage: "cov-ry1.png",
    },
    [URLS.konrad]: {
      schemaVersion: 1,
      product: "DWD KONRAD3D",
      source: "DWD",
      status: "current",
      referenceTime: "2026-10-31T10:55:00Z",
      creationTime: "2026-10-31T10:56:00Z",
      retrievedAt: "2026-10-31T10:58:00Z",
      publishedAt: "2026-10-31T10:59:00Z",
      staleAfterMinutes: 15,
      cellResult: "no-cells-detected",
    },
    [URLS.grass]: {
      schemaVersion: 1,
      status: "ok",
      retrievedAt: "2026-10-31T10:55:00Z",
      source: { dataAsOf: "2026-10-31T04:18:00Z" },
      days: [{ date: "2026-10-31", index: 1 }],
    },
    [URLS.wildfire]: {
      schemaVersion: 1,
      district: { regionalschluessel: "12066" },
      level: 1,
      description: "sehr geringe Gefahr",
      sourceDate: "2026-10-31",
      fetchStatus: "success",
      retrievedAt: "2026-10-31T10:55:00Z",
    },
  };
}
function mocked(data, opt = {}) {
  const calls = [],
    fetcher = async (input, init) => {
      const u = new URL(String(input));
      calls.push({ u, init });
      if (opt.fail?.(u)) throw Error("offline");
      const s = opt.status?.(u) || 200;
      if (s !== 200) return new Response("bad", { status: s });
      if (opt.badJson?.(u)) return new Response("{bad", { status: 200 });
      const x = data[u.origin + u.pathname];
      return x
        ? new Response(JSON.stringify(x), {
            status: 200,
            headers: {
              "last-modified": new Date(NOW - 60000).toUTCString(),
              age: "0",
            },
          })
        : new Response(null, { status: 404 });
    };
  return { calls, fetcher };
}
const find = (r, k) => r.sources.find((x) => x.key === k);
test("all seven real feed paths are individually evaluated", async () => {
  const { calls, fetcher } = mocked(fixtures()),
    r = await collectStatus({ nowMs: NOW, fetcher });
  assert.equal(calls.length, 7);
  assert.equal(r.overallStatus, "OK");
  assert.equal(find(r, "konrad3d").jsonPublishedAt, "2026-10-31T10:59:00Z");
});
test("fresh retrieval does not refresh old observation", async () => {
  const d = fixtures();
  d[URLS.weather].observations.wind.measuredAt = "2026-10-31T08:00:00Z";
  const { fetcher } = mocked(d);
  const r = await collectStatus({ nowMs: NOW, fetcher });
  assert.equal(
    find(r, "weather").products.observations.find(
      (x) => x.field === "windSpeedKmh",
    ).status,
    "STALE",
  );
});
test("missing measuredAt remains UNKNOWN", async () => {
  const d = fixtures();
  delete d[URLS.levelsB].latestMeasurement.measuredAtUtc;
  const { fetcher } = mocked(d);
  assert.equal(
    find(await collectStatus({ nowMs: NOW, fetcher }), "pegel_biehlen_1")
      .status,
    "UNKNOWN",
  );
});
test("forecast issue age and validAt are independent", async () => {
  const d = fixtures();
  d[URLS.weather].forecast.issuedAt = "2026-10-30T22:00:00Z";
  const { fetcher } = mocked(d);
  assert.equal(
    find(await collectStatus({ nowMs: NOW, fetcher }), "weather").products
      .forecast.status,
    "STALE",
  );
});
test("MOSMIX selects the earliest future point and retains the latest validThrough", async () => {
  const d = fixtures();
  d[URLS.weather].forecast.points = [
    { validAt: "2026-10-31T14:00:00Z", values: { temperatureC: null } },
    { validAt: "2026-10-31T13:00:00Z", values: { temperatureC: 12 } },
    { validAt: "2026-10-31T12:00:00Z", values: { temperatureC: null } },
    { validAt: "2026-10-31T10:00:00Z", values: { temperatureC: 5 } },
    { validAt: "2026-10-31T17:00:00Z", values: { temperatureC: 16 } },
    { validAt: "not-a-time", values: { temperatureC: 20 } },
  ];
  const { fetcher } = mocked(d);
  const forecast = find(await collectStatus({ nowMs: NOW, fetcher }), "weather").products.forecast;
  assert.equal(forecast.status, "OK");
  assert.equal(forecast.validAt, "2026-10-31T13:00:00Z");
  assert.equal(forecast.validThrough, "2026-10-31T17:00:00.000Z");
});
test("Lauchhammer and Biehlen have independent freshness", async () => {
  const d = fixtures();
  d[URLS.levelsL].latestMeasurement.measuredAtUtc = "2026-10-31T08:00:00Z";
  const { fetcher } = mocked(d);
  const r = await collectStatus({ nowMs: NOW, fetcher });
  assert.equal(find(r, "pegel_lauchhammer").status, "STALE");
  assert.equal(find(r, "pegel_biehlen_1").status, "OK");
});
test("wildfire expires at 08:00 Berlin", async () => {
  const d = fixtures();
  d[URLS.wildfire].sourceDate = "2026-10-30";
  const { fetcher } = mocked(d);
  assert.equal(
    find(
      await collectStatus({
        nowMs: Date.parse("2026-10-31T06:59:59Z"),
        fetcher,
      }),
      "waldbrand_osl",
    ).status,
    "OK",
  );
  assert.equal(
    find(
      await collectStatus({
        nowMs: Date.parse("2026-10-31T07:00:00Z"),
        fetcher,
      }),
      "waldbrand_osl",
    ).status,
    "STALE",
  );
});
test("DST windows are 23 and 25 hours", () => {
  assert.equal(
    Date.parse(wildfireInterval("2026-03-28").validUntil) -
      Date.parse(wildfireInterval("2026-03-28").validFrom),
    23 * 3600000,
  );
  assert.equal(
    Date.parse(wildfireInterval("2026-10-24").validUntil) -
      Date.parse(wildfireInterval("2026-10-24").validFrom),
    25 * 3600000,
  );
  assert.equal(
    berlinWallClockToUtc("2026-03-29", 8).toISOString(),
    "2026-03-29T06:00:00.000Z",
  );
});
test("recent retrieval with stale GLFI data stays STALE", async () => {
  const d = fixtures();
  d[URLS.grass].retrievedAt = new Date(NOW).toISOString();
  d[URLS.grass].source.dataAsOf = "2026-10-29T04:18:00Z";
  const { fetcher } = mocked(d);
  assert.equal(
    find(await collectStatus({ nowMs: NOW, fetcher }), "graslandfeuerindex")
      .status,
    "STALE",
  );
});
test("404 unavailable, 429 and 5xx error", async () => {
  const { fetcher } = mocked(fixtures(), {
    status: (u) =>
      u.pathname.endsWith("graslandfeuerindex.json")
        ? 404
        : u.pathname.endsWith("pegel-biehlen-1.json")
          ? 429
          : u.pathname.endsWith("pegel-lauchhammer.json")
            ? 503
            : 200,
  });
  const r = await collectStatus({ nowMs: NOW, fetcher });
  assert.equal(find(r, "graslandfeuerindex").status, "UNAVAILABLE");
  assert.equal(find(r, "pegel_biehlen_1").status, "ERROR");
  assert.equal(find(r, "pegel_lauchhammer").status, "ERROR");
});
test("offline, timeout and malformed JSON stay isolated per source", async () => {
  let x = mocked(fixtures(), {
    fail: (u) => u.pathname.endsWith("waldbrandgefahrenstufe-osl.json"),
  });
  let r = await collectStatus({ nowMs: NOW, fetcher: x.fetcher });
  assert.equal(find(r, "waldbrand_osl").status, "ERROR");
  x = mocked(fixtures(), {
    fail: (u) => u.pathname.endsWith("waldbrandgefahrenstufe-osl.json"),
  });
  const original = x.fetcher;
  x.fetcher = async (input, init) => {
    if (
      new URL(String(input)).pathname.endsWith(
        "waldbrandgefahrenstufe-osl.json",
      )
    )
      throw new DOMException("timeout", "AbortError");
    return original(input, init);
  };
  r = await collectStatus({ nowMs: NOW, fetcher: x.fetcher });
  assert.equal(find(r, "waldbrand_osl").reasonCode, "TIMEOUT");
  x = mocked(fixtures(), {
    badJson: (u) => u.pathname.endsWith("graslandfeuerindex.json"),
  });
  r = await collectStatus({ nowMs: NOW, fetcher: x.fetcher });
  assert.equal(find(r, "graslandfeuerindex").reasonCode, "INVALID_JSON");
  assert.equal(find(r, "radolan_ry").status, "OK");
});
test("Cloudflare manual redirects follow only same-origin HTTPS targets", async () => {
  const { fetcher: base } = mocked(fixtures());
  const calls = [];
  const f = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (url.pathname.endsWith("dwd-weather.json") && !url.searchParams.has("accepted")) {
      const location = new URL(url);
      location.searchParams.set("accepted", "1");
      return new Response(null, {
        status: 302,
        headers: { location: location.toString() },
      });
    }
    return base(input, init);
  };
  const result = await collectStatus({ nowMs: NOW, fetcher: f });
  assert.equal(find(result, "weather").status, "OK");
  const weatherCalls = calls.filter(({ url }) => url.pathname.endsWith("dwd-weather.json"));
  assert.equal(weatherCalls.length, 2);
  assert.ok(weatherCalls.every(({ init }) => init.redirect === "manual"));
});

test("foreign-host, HTTP-downgrade, missing-location and redirect loops fail closed", async () => {
  const cases = [
    ["https://attacker.example/data.json", "REDIRECT_HOST_NOT_ALLOWED"],
    ["http://raw.githubusercontent.com/redirect.json", "REDIRECT_HOST_NOT_ALLOWED"],
    [null, "REDIRECT_MISSING_LOCATION"],
  ];
  for (const [location, expected] of cases) {
    const { fetcher: base } = mocked(fixtures());
    let redirectCalls = 0;
    const f = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("dwd-weather.json")) {
        redirectCalls++;
        return new Response(null, {
          status: 302,
          headers: location ? { location } : {},
        });
      }
      return base(input, init);
    };
    const result = await collectStatus({ nowMs: NOW, fetcher: f });
    assert.equal(find(result, "weather").reasonCode, expected);
    assert.equal(redirectCalls, 1);
  }
  const { fetcher: base } = mocked(fixtures());
  const f = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("dwd-weather.json")) {
      return new Response(null, { status: 302, headers: { location: url.href } });
    }
    return base(input, init);
  };
  const result = await collectStatus({ nowMs: NOW, fetcher: f });
  assert.equal(find(result, "weather").reasonCode, "REDIRECT_LOOP");
});

test("observed outage mix remains five STALE and two OK feeds", async () => {
  const d = fixtures();
  for (const row of Object.values(d[URLS.weather].observations)) {
    row.measuredAt = "2026-10-31T08:00:00Z";
  }
  d[URLS.levelsL].latestMeasurement.measuredAtUtc = "2026-10-31T08:00:00Z";
  d[URLS.levelsB].latestMeasurement.measuredAtUtc = "2026-10-31T08:00:00Z";
  d[URLS.radar].productTime = "2026-10-31T10:00:00Z";
  d[URLS.konrad].referenceTime = "2026-10-31T10:00:00Z";
  const { fetcher } = mocked(d);
  const result = await collectStatus({ nowMs: NOW, fetcher });
  assert.deepEqual(
    Object.fromEntries(
      ["STALE", "OK"].map((status) => [
        status,
        result.sources.filter((source) => source.status === status).length,
      ]),
    ),
    { STALE: 5, OK: 2 },
  );
  assert.equal(result.overallStatus, "STALE");
});

test("redirect chains are bounded", async () => {
  const { fetcher: base } = mocked(fixtures());
  const f = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("dwd-weather.json")) {
      const next = new URL(url);
      next.searchParams.set("hop", String(Number(next.searchParams.get("hop") || 0) + 1));
      return new Response(null, { status: 302, headers: { location: next.href } });
    }
    return base(input, init);
  };
  const result = await collectStatus({ nowMs: NOW, fetcher: f });
  assert.equal(find(result, "weather").reasonCode, "REDIRECT_LIMIT_EXCEEDED");
});

test("scheduled logs contain structured status, not feed URLs or payload values", async () => {
  const { fetcher } = mocked(fixtures());
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  let logLine = "";
  globalThis.fetch = fetcher;
  console.log = (line) => { logLine = String(line); };
  try {
    await m.default.scheduled({ cron: "*/5 * * * *", scheduledTime: NOW });
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
  const log = JSON.parse(logLine);
  assert.equal(log.event, "feed_watchdog_check");
  assert.equal(log.sources.length, 7);
  assert.equal(logLine.includes("raw.githubusercontent.com"), false);
  assert.equal(logLine.includes("rain-ry1.png"), false);
  assert.equal(logLine.includes('"waterLevelCm"'), false);
  assert.equal(logLine.includes("Authorization"), false);
});

test("GitHub App reads remain disabled unless the exact true flag is set", async () => {
  const { fetcher } = mocked(fixtures());
  const oldFetch = globalThis.fetch;
  const oldLog = console.log;
  const calls = [];
  const logs = [];
  globalThis.fetch = async (input, init) => {
    calls.push(new URL(String(input)));
    return fetcher(input, init);
  };
  console.log = (line) => logs.push(String(line));
  try {
    await m.default.scheduled({ cron: "*/5 * * * *", scheduledTime: NOW }, {});
    await m.default.scheduled(
      { cron: "*/5 * * * *", scheduledTime: NOW },
      { GITHUB_APP_READ_ENABLED: "false" },
    );
    await m.default.scheduled(
      { cron: "*/5 * * * *", scheduledTime: NOW },
      { GITHUB_APP_READ_ENABLED: "TRUE" },
    );
  } finally {
    globalThis.fetch = oldFetch;
    console.log = oldLog;
  }
  assert.equal(calls.length, 21);
  assert.equal(calls.some((url) => url.origin === "https://api.github.com"), false);
  assert.equal(logs.filter((line) => JSON.parse(line).event === "github_workflow_observation").length, 0);
});

test("enabled Cron event performs scoped read-only workflow queries and preserves seven feed checks", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const { fetcher: feedFetch } = mocked(fixtures());
  const calls = [];
  const logs = [];
  const oldFetch = globalThis.fetch;
  const oldLog = console.log;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin === "https://api.github.com") {
      calls.push({ url, init });
      if (url.pathname.endsWith("/access_tokens")) {
        assert.equal(init.method, "POST");
        assert.equal(init.redirect, "manual");
        assert.deepEqual(JSON.parse(init.body), {
          repository_ids: [1424581788],
          permissions: { actions: "read" },
        });
        return new Response(JSON.stringify({
          token: "ghs_ephemeral_test_token_not_real",
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        }), { status: 201, headers: { "content-type": "application/json" } });
      }
      assert.equal(init.method, "GET");
      assert.equal(init.redirect, "manual");
      assert.equal(url.pathname.startsWith("/repos/RonnsenDD/lhh-data-hub/actions/workflows/"), true);
      return new Response(JSON.stringify({ workflow_runs: [{
        id: 91,
        status: "completed",
        conclusion: "success",
        event: "schedule",
        created_at: new Date(Date.now() - 60000).toISOString(),
        run_started_at: new Date(Date.now() - 55000).toISOString(),
        updated_at: new Date().toISOString(),
        head_sha: "public-test-sha",
      }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return feedFetch(input, init);
  };
  console.log = (line) => logs.push(String(line));
  try {
    await m.default.scheduled(
      { cron: "*/5 * * * *", scheduledTime: NOW },
      {
        GITHUB_APP_READ_ENABLED: "true",
        GITHUB_APP_ID: "5555433",
        GITHUB_INSTALLATION_ID: "177220128",
        GITHUB_APP_PRIVATE_KEY: privateKey,
      },
    );
  } finally {
    globalThis.fetch = oldFetch;
    console.log = oldLog;
  }
  assert.equal(calls.length, 6);
  assert.equal(calls.filter((call) => call.init.method === "GET").length, 5);
  assert.equal(calls.filter((call) => call.init.method === "POST").length, 1);
  assert.ok(calls.every((call) => call.url.origin === "https://api.github.com"));
  assert.ok(calls.every((call) => call.url.pathname.endsWith("/access_tokens") || call.url.pathname.endsWith("/runs")));
  assert.equal(calls.some((call) => call.url.pathname.includes("dispatch")), false);

  const feedLog = logs.map((line) => JSON.parse(line)).find((log) => log.event === "feed_watchdog_check");
  const appLog = logs.map((line) => JSON.parse(line)).find((log) => log.event === "github_workflow_observation");
  assert.equal(feedLog.sources.length, 7);
  assert.equal(appLog.queryStatus, "OK");
  assert.equal(appLog.workflows.length, 5);
  assert.equal(logs.join("\n").includes(privateKey), false);
  assert.equal(logs.join("\n").includes("ghs_ephemeral_test_token_not_real"), false);
});

test("public status requests never invoke the GitHub App adapter even when enabled", async () => {
  const { fetcher } = mocked(fixtures());
  const calls = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.origin === "https://api.github.com") throw new Error("must not call GitHub API");
    return fetcher(input, init);
  };
  try {
    const response = await m.default.fetch(
      new Request("https://worker.example/status", { headers: { Origin: "https://feuerwehrlauchhammer.sharepoint.com" } }),
      {
        GITHUB_APP_READ_ENABLED: "true",
        GITHUB_APP_ID: "5555433",
        GITHUB_INSTALLATION_ID: "177220128",
      },
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.sources.length, 7);
    assert.equal("workflows" in payload, false);
  } finally {
    globalThis.fetch = oldFetch;
  }
  assert.equal(calls.length, 7);
  assert.equal(calls.some((url) => url.origin === "https://api.github.com"), false);
});

test("GitHub authentication failure is logged without changing feed results", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const { fetcher: feedFetch } = mocked(fixtures());
  const baselineFeeds = await collectStatus({ fetcher: feedFetch });
  const calls = [];
  const logs = [];
  const oldFetch = globalThis.fetch;
  const oldLog = console.log;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin === "https://api.github.com") {
      calls.push({ url, init });
      return new Response("private response body", { status: 403 });
    }
    return feedFetch(input, init);
  };
  console.log = (line) => logs.push(String(line));
  try {
    await m.default.scheduled(
      { cron: "*/5 * * * *", scheduledTime: NOW },
      {
        GITHUB_APP_READ_ENABLED: "true",
        GITHUB_APP_ID: "5555433",
        GITHUB_INSTALLATION_ID: "177220128",
        GITHUB_APP_PRIVATE_KEY: privateKey,
      },
    );
  } finally {
    globalThis.fetch = oldFetch;
    console.log = oldLog;
  }
  assert.equal(calls.length, 1);
  const feedLog = logs.map((line) => JSON.parse(line)).find((log) => log.event === "feed_watchdog_check");
  const appLog = logs.map((line) => JSON.parse(line)).find((log) => log.event === "github_workflow_observation");
  assert.equal(feedLog.overallStatus, baselineFeeds.overallStatus);
  assert.equal(feedLog.sources.length, 7);
  assert.deepEqual(
    feedLog.sources.map((source) => [source.key, source.status, source.reasonCode]),
    baselineFeeds.sources.map((source) => [source.key, source.status, source.reasonCode ?? null]),
  );
  assert.equal(appLog.queryStatus, "ERROR");
  assert.equal(appLog.reasonCode, "GITHUB_PERMISSION_DENIED");
  assert.equal(logs.join("\n").includes("private response body"), false);
});

test("no GitHub write or dispatch path is implemented", async () => {
  const s = await readFile(new URL("./worker.js", import.meta.url), "utf8");
  const adapter = await readFile(new URL("./github-app-adapter.js", import.meta.url), "utf8");
  assert.equal(adapter.includes("workflow_dispatch"), false);
  assert.equal(adapter.includes("dispatches"), false);
  assert.equal(s.includes("workflow_dispatch"), false);
  assert.equal(s.includes("D1Database"), false);
  assert.equal(s.includes("caches.default"), false);
});

test("invalid schema is ERROR and cannot claim freshness", async () => {
  const d = fixtures();
  d[URLS.weather].schemaVersion = 99;
  const { fetcher } = mocked(d);
  const w = find(await collectStatus({ nowMs: NOW, fetcher }), "weather");
  assert.equal(w.status, "ERROR");
  assert.equal(w.reasonCode, "INVALID_SCHEMA");
});
test("status endpoint permits GET and rejects writes", async () => {
  const { fetcher } = mocked(fixtures()),
    old = globalThis.fetch;
  globalThis.fetch = fetcher;
  try {
    const r = await m.default.fetch(
      new Request("https://worker.example/status", {
        headers: { Origin: "https://feuerwehrlauchhammer.sharepoint.com" },
      }),
    );
    assert.equal(r.status, 200);
    assert.equal(
      r.headers.get("access-control-allow-origin"),
      "https://feuerwehrlauchhammer.sharepoint.com",
    );
    assert.equal((await r.json()).mode, "observe-only");
    const p = await m.default.fetch(
      new Request("https://worker.example/status", { method: "POST" }),
    );
    assert.equal(p.status, 405);
  } finally {
    globalThis.fetch = old;
  }
});
test("parallel feed requests are capped at four", async () => {
  const d = fixtures();
  let active = 0,
    max = 0;
  const f = async (input, init) => {
    active++;
    max = Math.max(max, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active--;
    const u = new URL(String(input)),
      v = d[u.origin + u.pathname];
    return v
      ? new Response(JSON.stringify(v), {
          headers: { "content-type": "application/json" },
        })
      : new Response(null, { status: 404 });
  };
  await collectStatus({ nowMs: NOW, fetcher: f });
  assert.ok(max <= 4);
});

test("producer-declared stale/error states cannot be upgraded by a fresh timestamp", async () => {
  const d = fixtures();
  d[URLS.weather].observations.wind.status = "stale";
  d[URLS.konrad].status = "error";
  const { fetcher } = mocked(d);
  const r = await collectStatus({ nowMs: NOW, fetcher });
  assert.equal(find(r, "weather").status, "STALE");
  assert.equal(find(r, "konrad3d").status, "ERROR");
});

test("unavailable products stay unavailable without invented timestamps", async () => {
  const d = fixtures();
  d[URLS.konrad] = {
    schemaVersion: 1,
    product: "DWD KONRAD3D",
    source: "DWD",
    status: "unavailable",
    referenceTime: null,
    publishedAt: "2026-10-31T11:00:00Z",
  };
  const { fetcher } = mocked(d);
  const row = find(await collectStatus({ nowMs: NOW, fetcher }), "konrad3d");
  assert.equal(row.status, "UNAVAILABLE");
  assert.equal(row.sourceTime, null);
});
test("missing CDN Age is reported as unavailable, not zero", async () => {
  const d = fixtures();
  const { fetcher } = mocked(d);
  const wrapper = async (input, init) => {
    const response = await fetcher(input, init);
    const headers = new Headers(response.headers);
    headers.delete("age");
    return new Response(response.body, { status: response.status, headers });
  };
  const row = find(
    await collectStatus({ nowMs: NOW, fetcher: wrapper }),
    "weather",
  );
  assert.equal(row.transport.httpAgeSeconds, null);
});

